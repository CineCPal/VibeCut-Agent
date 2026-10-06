//! Waveform sync of separately recorded sound: finds where a camera clip's own (scratch) audio sits
//! inside an external recorder's file — see PLAN.md, "Synced audio".
//!
//! Offset convention (A-Sync's, used everywhere in VibeCut): `offset` is the number of seconds the
//! recorder must be delayed to line up with the camera, so `camera_time = recorder_time + offset`.
//! A camera clip that starts 20 minutes into a long recorder roll has `offset = -1200`.
//!
//! Two passes, so a camera clip can be found anywhere in a multi-hour roll without decoding either
//! file whole into memory:
//! 1. **Coarse**: each file becomes a 100 Hz onset-strength envelope (the rise in log energy from one
//!    10 ms frame to the next). Log differences don't depend on gain, so a quiet camera mic and a
//!    hot lav still line up. The envelopes are compared with a normalised cross-correlation (Pearson
//!    per lag, over the overlapping part only) through one FFT. Envelopes are cached per file.
//! 2. **Fine**: two short excerpts (early and late in the overlap, where there's the most going on)
//!    are decoded at 16 kHz and correlated sample by sample in a ±150 ms window around the coarse
//!    answer, with parabolic interpolation. The two estimates are averaged; their difference is
//!    reported as drift (a warning — drift is not corrected).

use crate::commands::ffmpeg_binary;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State};

/// The envelope's decode rate: speech energy is well represented, and a 2-hour roll is small.
const ENVELOPE_DECODE_RATE: u32 = 8000;
/// Envelope frames per second (10 ms frames).
pub const ENVELOPE_HZ: f64 = 100.0;
/// Energy below this (about -70 dBFS) counts as silence, so hiss doesn't read as onsets.
const ENERGY_FLOOR: f64 = 1e-7;
/// The fine pass's decode rate.
const FINE_RATE: u32 = 16000;
/// How far either side of the coarse answer the fine pass looks, in seconds.
const FINE_MARGIN_SECONDS: f64 = 0.15;
/// The longest excerpt the fine pass decodes.
const FINE_WINDOW_SECONDS: f64 = 20.0;
/// A coarse peak must be at least this far from the runner-up to count them as different answers.
const RUNNER_UP_EXCLUSION_SECONDS: f64 = 1.0;
/// Overlap needed before a lag is considered at all (or half the shorter file, if that is less).
const MIN_OVERLAP_SECONDS: f64 = 10.0;
/// A match needs this much envelope correlation…
pub const MIN_SCORE: f64 = 0.2;
/// …and a peak this much clearer than the runner-up (1 - runner_up / best).
pub const MIN_CONFIDENCE: f64 = 0.25;
/// Below this, a fine-pass estimate is ignored in favour of the coarse one.
const MIN_FINE_PEARSON: f64 = 0.2;

const ENVELOPE_VERSION: u32 = 1;
const ENVELOPE_MAGIC: &[u8; 8] = b"VCENV001";
const MAX_ENVELOPE_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const PROGRESS_EVENT: &str = "audio-sync-progress";
pub const CANCELLED: &str = "Cancelled";

// ---------------------------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------------------------

/// Builds an onset-strength envelope (one value per 10 ms frame) from samples fed one at a time, so
/// a long file can be streamed through it.
struct EnvelopeBuilder {
    frame: usize,
    energy: f64,
    filled: usize,
    previous: Option<f64>,
    out: Vec<f32>,
}

impl EnvelopeBuilder {
    fn new(rate: u32) -> Self {
        let frame = (f64::from(rate) / ENVELOPE_HZ).round().max(1.0) as usize;
        EnvelopeBuilder { frame, energy: 0.0, filled: 0, previous: None, out: Vec::new() }
    }
    fn push(&mut self, sample: f32) {
        self.energy += f64::from(sample) * f64::from(sample);
        self.filled += 1;
        if self.filled == self.frame {
            let level = (self.energy / self.frame as f64).max(ENERGY_FLOOR).ln();
            self.out.push(self.previous.map_or(0.0, |p| (level - p).max(0.0)) as f32);
            self.previous = Some(level);
            self.energy = 0.0;
            self.filled = 0;
        }
    }
}

/// Onset strength, one value per 10 ms frame, from mono samples at `rate` Hz (any scale).
#[cfg(test)]
fn onset_envelope(samples: &[f32], rate: u32) -> Vec<f32> {
    let mut builder = EnvelopeBuilder::new(rate);
    for &s in samples {
        builder.push(s);
    }
    builder.out
}

/// Prefix sums of values and squares, for O(1) sums over any range.
struct Prefix {
    sum: Vec<f64>,
    sq: Vec<f64>,
}

impl Prefix {
    fn new(values: &[f32]) -> Self {
        let mut sum = Vec::with_capacity(values.len() + 1);
        let mut sq = Vec::with_capacity(values.len() + 1);
        sum.push(0.0);
        sq.push(0.0);
        for &v in values {
            let v = f64::from(v);
            sum.push(sum.last().unwrap() + v);
            sq.push(sq.last().unwrap() + v * v);
        }
        Prefix { sum, sq }
    }
    fn range(&self, lo: usize, hi: usize) -> (f64, f64) {
        (self.sum[hi] - self.sum[lo], self.sq[hi] - self.sq[lo])
    }
}

/// `xc[k]` for lag `k - (a.len() - 1)`: `Σ a[i] · b[i + lag]`, through one FFT.
fn cross_correlation(a: &[f32], b: &[f32]) -> Vec<f64> {
    let (n, m) = (a.len(), b.len());
    let size = (n + m - 1).next_power_of_two();
    let mut planner = FftPlanner::<f64>::new();
    let forward = planner.plan_fft_forward(size);
    let inverse = planner.plan_fft_inverse(size);
    let mut fa: Vec<Complex<f64>> = (0..size).map(|i| Complex::new(a.get(i).map_or(0.0, |&v| f64::from(v)), 0.0)).collect();
    let mut fb: Vec<Complex<f64>> = (0..size).map(|i| Complex::new(b.get(i).map_or(0.0, |&v| f64::from(v)), 0.0)).collect();
    forward.process(&mut fa);
    forward.process(&mut fb);
    // circular c[k] = Σ_j b[j + k] · a[j]  =  IFFT(FFT(b) · conj(FFT(a)))
    let mut product: Vec<Complex<f64>> = fb.iter().zip(&fa).map(|(x, y)| x * y.conj()).collect();
    inverse.process(&mut product);
    let scale = 1.0 / size as f64;
    // Reorder so index 0 is lag -(n-1).
    (0..n + m - 1)
        .map(|k| {
            let lag = k as i64 - (n as i64 - 1);
            let idx = if lag >= 0 { lag as usize } else { (size as i64 + lag) as usize };
            product[idx].re * scale
        })
        .collect()
}

fn pearson(sxy: f64, sx: f64, sxx: f64, sy: f64, syy: f64, k: f64) -> Option<f64> {
    let vx = sxx - sx * sx / k;
    let vy = syy - sy * sy / k;
    // Both sides need real variation: a flat stretch correlates with nothing.
    if vx <= 1e-9 * k || vy <= 1e-9 * k {
        return None;
    }
    Some((sxy - sx * sy / k) / (vx * vy).sqrt())
}

/// The best coarse alignment of a camera envelope against a recorder envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct Coarse {
    /// Camera frame `i` lines up with recorder frame `i + lag`.
    pub lag: i64,
    /// Envelope correlation at `lag`, weighted by how much of the shorter file overlaps (0–1).
    pub score: f64,
    /// `1 - runner_up / score`: 0 when another lag is as good, 1 when nothing else comes close.
    pub confidence: f64,
    /// Overlapping frames at `lag`.
    pub overlap: usize,
}

/// Normalised cross-correlation of two envelopes over every lag with enough overlap.
pub fn coarse_search(camera: &[f32], recorder: &[f32]) -> Option<Coarse> {
    let (n, m) = (camera.len(), recorder.len());
    if n < 2 || m < 2 {
        return None;
    }
    let shorter = n.min(m);
    let min_overlap = ((MIN_OVERLAP_SECONDS * ENVELOPE_HZ) as usize).min(shorter / 2).max(2);
    let xc = cross_correlation(camera, recorder);
    let pc = Prefix::new(camera);
    let pr = Prefix::new(recorder);

    let mut scores: Vec<(i64, f64, usize)> = Vec::new();
    for (k, &sxy) in xc.iter().enumerate() {
        let lag = k as i64 - (n as i64 - 1);
        let lo = (-lag).max(0) as usize;
        let hi = ((m as i64 - lag).min(n as i64)).max(0) as usize;
        if hi <= lo || hi - lo < min_overlap {
            continue;
        }
        let overlap = hi - lo;
        let (sx, sxx) = pc.range(lo, hi);
        let (sy, syy) = pr.range((lo as i64 + lag) as usize, (hi as i64 + lag) as usize);
        let Some(r) = pearson(sxy, sx, sxx, sy, syy, overlap as f64) else { continue };
        // Favour fuller overlaps: a sliver can correlate by chance.
        scores.push((lag, r * (overlap as f64 / shorter as f64).sqrt(), overlap));
    }
    let &(lag, score, overlap) = scores.iter().max_by(|a, b| a.1.total_cmp(&b.1))?;
    let exclusion = (RUNNER_UP_EXCLUSION_SECONDS * ENVELOPE_HZ) as i64;
    let runner_up = scores
        .iter()
        .filter(|(l, _, _)| (l - lag).abs() > exclusion)
        .map(|s| s.1)
        .fold(0.0_f64, f64::max);
    let confidence = if score > 0.0 { (1.0 - runner_up / score).clamp(0.0, 1.0) } else { 0.0 };
    Some(Coarse { lag, score, confidence, overlap })
}

/// Where `needle` sits inside `haystack` (which must be at least as long), in fractional samples,
/// and the Pearson correlation there.
pub fn fine_lag(needle: &[f32], haystack: &[f32]) -> Option<(f64, f64)> {
    let (p, q) = (needle.len(), haystack.len());
    if p < 16 || q < p {
        return None;
    }
    let xc = cross_correlation(needle, haystack);
    let pn = Prefix::new(needle);
    let ph = Prefix::new(haystack);
    let (sx, sxx) = pn.range(0, p);
    let k = p as f64;
    let at = |d: usize| -> Option<f64> {
        let (sy, syy) = ph.range(d, d + p);
        pearson(xc[d + p - 1], sx, sxx, sy, syy, k)
    };
    let values: Vec<Option<f64>> = (0..=q - p).map(at).collect();
    let (best, peak) = values
        .iter()
        .enumerate()
        .filter_map(|(d, v)| v.map(|v| (d, v)))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    let mut refined = best as f64;
    if best > 0 && best + 1 < values.len() {
        if let (Some(l), Some(r)) = (values[best - 1], values[best + 1]) {
            let denom = l - 2.0 * peak + r;
            if denom.abs() > 1e-12 {
                refined += (0.5 * (l - r) / denom).clamp(-0.5, 0.5);
            }
        }
    }
    Some((refined, peak))
}

/// The start (in frames) of the `len`-frame window inside `lo..hi` with the most onset activity.
fn busiest_window(envelope: &[f32], lo: usize, hi: usize, len: usize) -> usize {
    let hi = hi.min(envelope.len());
    if hi <= lo || hi - lo <= len {
        return lo;
    }
    let prefix = Prefix::new(envelope);
    (lo..=hi - len).max_by(|&a, &b| prefix.range(a, a + len).0.total_cmp(&prefix.range(b, b + len).0)).unwrap_or(lo)
}

/// Camera-time windows (start, length in seconds) for the fine pass: one early and one late in the
/// overlap, each the busiest stretch of its half. One window when the overlap is short.
pub fn fine_windows(camera_env: &[f32], coarse: &Coarse, recorder_frames: usize) -> Vec<(f64, f64)> {
    let lo = (-coarse.lag).max(0) as usize;
    let hi = ((recorder_frames as i64 - coarse.lag).min(camera_env.len() as i64)).max(0) as usize;
    // Keep the fine margin inside both files.
    let margin = (FINE_MARGIN_SECONDS * ENVELOPE_HZ).ceil() as usize + 2;
    let (lo, hi) = (lo + margin, hi.saturating_sub(margin));
    if hi <= lo + 20 {
        return Vec::new();
    }
    let span = hi - lo;
    let to_s = |f: usize| f as f64 / ENVELOPE_HZ;
    if span < (8.0 * ENVELOPE_HZ) as usize {
        return vec![(to_s(lo), to_s(span))];
    }
    let len = ((FINE_WINDOW_SECONDS * ENVELOPE_HZ) as usize).min(span / 2);
    let mid = lo + span / 2;
    let early = busiest_window(camera_env, lo, mid, len);
    let late = busiest_window(camera_env, mid, hi, len);
    vec![(to_s(early), to_s(len)), (to_s(late), to_s(len))]
}

// ---------------------------------------------------------------------------------------------
// ffmpeg I/O
// ---------------------------------------------------------------------------------------------

fn ffmpeg_error(e: std::io::Error) -> String {
    match e.kind() {
        ErrorKind::NotFound => "ffmpeg not found. Install ffmpeg (brew install ffmpeg) or set VIBECUT_FFMPEG".to_string(),
        _ => format!("Could not run ffmpeg: {e}"),
    }
}

/// Streams the file's first audio track through ffmpeg into an onset envelope, never holding more
/// than one read buffer of samples.
fn extract_envelope(path: &Path, cancelled: &AtomicBool) -> Result<Vec<f32>, String> {
    let mut child = Command::new(ffmpeg_binary())
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-ac", "1", "-ar", &ENVELOPE_DECODE_RATE.to_string(), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(ffmpeg_error)?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut builder = EnvelopeBuilder::new(ENVELOPE_DECODE_RATE);
    let mut odd_byte: Option<u8> = None;
    let sample = |pair: [u8; 2]| f32::from(i16::from_le_bytes(pair)) / 32768.0;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        let read = stdout.read(&mut buffer).map_err(|e| format!("Could not read ffmpeg output: {e}"))?;
        if read == 0 {
            break;
        }
        let mut bytes = &buffer[..read];
        if let Some(first) = odd_byte.take() {
            builder.push(sample([first, bytes[0]]));
            bytes = &bytes[1..];
        }
        let pairs = bytes.chunks_exact(2);
        if let [last] = pairs.remainder() {
            odd_byte = Some(*last);
        }
        for pair in pairs {
            builder.push(sample([pair[0], pair[1]]));
        }
    }
    let envelope = builder.out;
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    let status = child.wait().map_err(|e| format!("ffmpeg did not finish: {e}"))?;
    if !status.success() {
        let reason = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("ffmpeg failed").trim().to_string();
        return Err(if reason.contains("matches no streams") { "The file has no sound".into() } else { reason });
    }
    if envelope.len() < 2 {
        return Err("The file has no sound".into());
    }
    Ok(envelope)
}

/// `seconds` of mono audio from `start`, at the fine pass's rate.
fn decode_excerpt(path: &Path, start: f64, seconds: f64) -> Result<Vec<f32>, String> {
    let output = Command::new(ffmpeg_binary())
        .args(["-v", "error", "-nostdin", "-ss", &format!("{:.6}", start.max(0.0)), "-t", &format!("{seconds:.6}"), "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-ac", "1", "-ar", &FINE_RATE.to_string(), "-f", "f32le", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(ffmpeg_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("ffmpeg failed").trim().to_string());
    }
    Ok(output.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn envelope_file_name(source: &Path) -> Result<String, String> {
    let meta = fs::metadata(source).map_err(|e| format!("Cannot read the file: {e}"))?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let mut hasher = DefaultHasher::new();
    (source, meta.len(), modified, ENVELOPE_VERSION).hash(&mut hasher);
    Ok(format!("{:016x}.env", hasher.finish()))
}

fn read_cached(path: &Path) -> Option<Vec<f32>> {
    let bytes = fs::read(path).ok()?;
    let body = bytes.strip_prefix(ENVELOPE_MAGIC.as_slice())?;
    (body.len() % 4 == 0).then(|| body.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn write_cached(path: &Path, envelope: &[f32]) {
    let mut bytes = Vec::with_capacity(ENVELOPE_MAGIC.len() + envelope.len() * 4);
    bytes.extend_from_slice(ENVELOPE_MAGIC);
    for v in envelope {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    // A partial file first, so an interrupted run never leaves a broken cache entry.
    let partial = path.with_extension("part");
    if fs::write(&partial, bytes).is_ok() && fs::rename(&partial, path).is_err() {
        let _ = fs::remove_file(&partial);
    }
}

fn envelope_for(path: &Path, cache_dir: Option<&Path>, cancelled: &AtomicBool) -> Result<Vec<f32>, String> {
    let target = cache_dir.map(|dir| envelope_file_name(path).map(|name| dir.join(name))).transpose()?;
    if let Some(cached) = target.as_deref().and_then(read_cached) {
        return Ok(cached);
    }
    let envelope = extract_envelope(path, cancelled)?;
    if let Some(target) = target {
        write_cached(&target, &envelope);
    }
    Ok(envelope)
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncMatch {
    pub camera: String,
    pub recorder: String,
    /// Seconds the recorder is delayed: camera_time = recorder_time + offset.
    pub offset: f64,
    pub score: f64,
    pub confidence: f64,
    /// Whether this pair passed the thresholds (unmatched pairs are reported so the UI can say why).
    pub matched: bool,
    /// Whether the fine pass confirmed the offset (otherwise it is only accurate to 10 ms).
    pub refined: bool,
    /// The late estimate minus the early one, when both were confirmed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drift_seconds: Option<f64>,
    pub overlap_seconds: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub matches: Vec<SyncMatch>,
    pub errors: Vec<SyncFileError>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgress {
    job_id: String,
    done: usize,
    total: usize,
    detail: String,
}

/// Refines a coarse alignment with the fine pass, returning (offset, refined, drift).
fn refine(camera: &Path, recorder: &Path, camera_env: &[f32], recorder_frames: usize, coarse: &Coarse) -> (f64, bool, Option<f64>) {
    let coarse_offset = -(coarse.lag as f64) / ENVELOPE_HZ;
    let mut estimates = Vec::new();
    for (start, length) in fine_windows(camera_env, coarse, recorder_frames) {
        let rec_start = start - coarse_offset - FINE_MARGIN_SECONDS;
        let (Ok(needle), Ok(haystack)) = (
            decode_excerpt(camera, start, length),
            decode_excerpt(recorder, rec_start, length + 2.0 * FINE_MARGIN_SECONDS),
        ) else {
            continue;
        };
        if let Some((lag, r)) = fine_lag(&needle, &haystack) {
            if r >= MIN_FINE_PEARSON {
                // camera `start` lines up with recorder `rec_start + lag`.
                estimates.push(start - (rec_start.max(0.0) + lag / f64::from(FINE_RATE)));
            }
        }
    }
    match estimates.as_slice() {
        [] => (coarse_offset, false, None),
        [one] => (*one, true, None),
        [early, late, ..] => ((early + late) / 2.0, true, Some(late - early)),
    }
}

/// Every camera against every recorder. `cache_dir` holds envelopes between runs (None in tests).
pub fn run_sync(
    cameras: &[String],
    recorders: &[String],
    cache_dir: Option<&Path>,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    let files: Vec<&String> = cameras.iter().chain(recorders).collect();
    let total = files.len() + cameras.len() * recorders.len();
    let mut done = 0;

    let mut envelopes: HashMap<&String, Vec<f32>> = HashMap::new();
    for path in files {
        if envelopes.contains_key(path) {
            continue;
        }
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        progress(done, total, &format!("Listening to {name}"));
        match envelope_for(Path::new(path), cache_dir, cancelled) {
            Ok(env) => {
                envelopes.insert(path, env);
            }
            Err(e) if e == CANCELLED => return Err(e),
            Err(message) => report.errors.push(SyncFileError { path: path.clone(), message }),
        }
        done += 1;
    }

    for camera in cameras {
        for recorder in recorders {
            if cancelled.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            done += 1;
            let (Some(cam_env), Some(rec_env)) = (envelopes.get(camera), envelopes.get(recorder)) else { continue };
            if camera == recorder {
                continue;
            }
            let name = Path::new(camera).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            progress(done, total, &format!("Matching {name}"));
            let Some(coarse) = coarse_search(cam_env, rec_env) else { continue };
            let matched = coarse.score >= MIN_SCORE && coarse.confidence >= MIN_CONFIDENCE;
            let (offset, refined, drift_seconds) = if matched {
                refine(Path::new(camera), Path::new(recorder), cam_env, rec_env.len(), &coarse)
            } else {
                (-(coarse.lag as f64) / ENVELOPE_HZ, false, None)
            };
            report.matches.push(SyncMatch {
                camera: camera.clone(),
                recorder: recorder.clone(),
                offset,
                score: coarse.score,
                confidence: coarse.confidence,
                matched,
                refined,
                drift_seconds,
                overlap_seconds: coarse.overlap as f64 / ENVELOPE_HZ,
            });
        }
    }
    progress(total, total, "Done");
    Ok(report)
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct AudioSyncJobs {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map(|dir| dir.join("audiosync")).map_err(|e| format!("No cache folder: {e}"))
}

/// Finds where each camera file's sound sits in each recorder file. Progress arrives as
/// `audio-sync-progress` events; `cancel_audio_sync` stops it with the error "Cancelled".
#[tauri::command]
pub async fn sync_audio(
    app: AppHandle,
    jobs: State<'_, AudioSyncJobs>,
    job_id: String,
    cameras: Vec<String>,
    recorders: Vec<String>,
) -> Result<SyncReport, String> {
    for path in cameras.iter().chain(&recorders) {
        if !Path::new(path).is_absolute() {
            return Err(format!("Media path must be absolute: {path}"));
        }
    }
    if cameras.is_empty() || recorders.is_empty() {
        return Err("Choose at least one camera clip and one sound file".into());
    }
    let dir = cache_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the sync cache folder: {e}"))?;
    let flag = Arc::new(AtomicBool::new(false));
    jobs.running.lock().unwrap().insert(job_id.clone(), flag.clone());
    let worker_app = app.clone();
    let worker_id = job_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_sync(&cameras, &recorders, Some(&dir), &flag, |done, total, detail| {
            let _ = worker_app.emit(
                PROGRESS_EVENT,
                SyncProgress { job_id: worker_id.clone(), done, total, detail: detail.to_string() },
            );
        })
    })
    .await
    .map_err(|e| e.to_string());
    jobs.running.lock().unwrap().remove(&job_id);
    outcome?
}

#[tauri::command]
pub fn cancel_audio_sync(jobs: State<'_, AudioSyncJobs>, job_id: String) {
    if let Some(flag) = jobs.running.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Deletes cached envelopes not used in a long time, off the main thread, like the other caches.
pub fn prune_in_background(app: &AppHandle) {
    let Ok(dir) = cache_dir(app) else { return };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(entries) = fs::read_dir(&dir) else { return };
        let now = SystemTime::now();
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || !path.extension().is_some_and(|e| e == "env" || e == "part") {
                continue;
            }
            let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).unwrap_or_default();
            if age > MAX_ENVELOPE_AGE {
                let _ = fs::remove_file(&path);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic "speech": noise bursts of random length and loudness separated by pauses.
    fn speechlike(seconds: f64, rate: u32, seed: u64) -> Vec<f32> {
        let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut next = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as f64) / f64::from(u32::MAX >> 1)
        };
        let total = (seconds * f64::from(rate)) as usize;
        let mut out = Vec::with_capacity(total);
        while out.len() < total {
            let burst = ((0.08 + 0.3 * next()) * f64::from(rate)) as usize;
            let gain = 0.05 + 0.5 * next();
            for _ in 0..burst {
                out.push(((next() * 2.0 - 1.0) * gain) as f32);
            }
            let pause = ((0.05 + 0.4 * next()) * f64::from(rate)) as usize;
            for _ in 0..pause {
                out.push(((next() * 2.0 - 1.0) * 0.001) as f32);
            }
        }
        out.truncate(total);
        out
    }

    #[test]
    fn onset_envelope_rises_only_at_onsets() {
        let mut samples = vec![0.0_f32; 8000];
        samples.extend(std::iter::repeat_n(0.5_f32, 8000));
        let env = onset_envelope(&samples, 8000);
        assert_eq!(env.len(), 200);
        let peak = env.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(peak, 100);
        assert!(env[150] == 0.0);
    }

    #[test]
    fn onset_envelope_ignores_gain() {
        let a = speechlike(5.0, 8000, 1);
        // Louder rather than quieter, so the pauses stay above the silence floor in both.
        let b: Vec<f32> = a.iter().map(|s| s * 1.8).collect();
        let (ea, eb) = (onset_envelope(&a, 8000), onset_envelope(&b, 8000));
        let worst = ea.iter().zip(&eb).map(|(x, y)| (x - y).abs()).fold(0.0_f32, f32::max);
        assert!(worst < 1e-3, "{worst}");
    }

    #[test]
    fn coarse_search_finds_a_clip_inside_a_long_roll() {
        let roll = speechlike(600.0, 8000, 7);
        let roll_env = onset_envelope(&roll, 8000);
        // The camera starts 412.3 s into the roll and runs 45 s; its mic is quieter and noisier.
        let start = (412.3 * 8000.0) as usize;
        let camera: Vec<f32> = roll[start..start + 45 * 8000].iter().enumerate().map(|(i, s)| s * 0.3 + ((i * 7919 % 97) as f32 / 97.0 - 0.5) * 0.004).collect();
        let coarse = coarse_search(&onset_envelope(&camera, 8000), &roll_env).unwrap();
        assert!((coarse.lag - 41230).abs() <= 1, "{coarse:?}");
        assert!(coarse.score >= MIN_SCORE && coarse.confidence >= MIN_CONFIDENCE, "{coarse:?}");
    }

    #[test]
    fn coarse_search_handles_a_recorder_that_started_late() {
        let take = speechlike(90.0, 8000, 3);
        // The recorder starts 2 s after the camera and stops 5 s before it.
        let recorder = &take[2 * 8000..85 * 8000];
        let coarse = coarse_search(&onset_envelope(&take, 8000), &onset_envelope(recorder, 8000)).unwrap();
        assert_eq!(coarse.lag, -200, "{coarse:?}");
        assert!(coarse.confidence >= MIN_CONFIDENCE);
    }

    #[test]
    fn unrelated_recordings_do_not_match() {
        let a = onset_envelope(&speechlike(60.0, 8000, 11), 8000);
        let b = onset_envelope(&speechlike(300.0, 8000, 12), 8000);
        let coarse = coarse_search(&a, &b).unwrap();
        assert!(!(coarse.score >= MIN_SCORE && coarse.confidence >= MIN_CONFIDENCE), "{coarse:?}");
    }

    #[test]
    fn fine_lag_is_sub_sample_accurate() {
        let signal = speechlike(3.0, 16000, 5);
        let needle = &signal[8000..8000 + 16000];
        // A half-sample shift, made by averaging neighbours.
        let shifted: Vec<f32> = signal.windows(2).map(|w| (w[0] + w[1]) / 2.0).collect();
        let (lag, r) = fine_lag(needle, &shifted[5000..5000 + 16000 + 6000]).unwrap();
        assert!((lag - 2999.5).abs() < 0.2, "{lag}");
        // Averaging neighbours low-passes white noise, so the best possible correlation is about 0.71.
        assert!(r > 0.6, "{r}");
    }

    #[test]
    fn fine_windows_stay_inside_both_files() {
        let env = vec![0.1_f32; 6000];
        let coarse = Coarse { lag: -500, score: 1.0, confidence: 1.0, overlap: 5500 };
        let windows = fine_windows(&env, &coarse, 5000);
        assert_eq!(windows.len(), 2);
        for (start, len) in windows {
            assert!(start >= 5.0 + FINE_MARGIN_SECONDS);
            assert!(start + len <= 55.0 - FINE_MARGIN_SECONDS + 1e-9);
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibecut-audiosync-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_wav(path: &Path, samples: &[f32], rate: u32) {
        let data: Vec<u8> = samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&data);
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn syncs_real_files_through_ffmpeg_when_installed() {
        if Command::new(ffmpeg_binary()).arg("-version").output().is_err() {
            return;
        }
        let dir = temp_dir("real");
        let rate = 48000;
        let roll = speechlike(240.0, rate, 21);
        let recorder = dir.join("roll.wav");
        write_wav(&recorder, &roll, rate);
        // Camera 1 starts 100.25 s into the roll; camera 2 starts 1.6 s before the roll does.
        let cam1 = dir.join("cam1.mov");
        let start = (100.25 * f64::from(rate)) as usize;
        write_wav(&dir.join("cam1.wav"), &roll[start..start + 30 * rate as usize].iter().map(|s| s * 0.4).collect::<Vec<_>>(), rate);
        let mut early = vec![0.0_f32; (1.6 * f64::from(rate)) as usize];
        early.extend(roll[..40 * rate as usize].iter().map(|s| s * 0.4));
        write_wav(&dir.join("cam2.wav"), &early, rate);
        let cam2 = dir.join("cam2.mov");
        for (wav, mov) in [("cam1.wav", &cam1), ("cam2.wav", &cam2)] {
            // Real camera files: a picture plus AAC sound.
            assert!(Command::new(ffmpeg_binary())
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=25", "-i"])
                .arg(dir.join(wav))
                .args(["-shortest", "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k"])
                .arg(mov)
                .status()
                .unwrap()
                .success());
        }
        let cameras = vec![cam1.to_string_lossy().into_owned(), cam2.to_string_lossy().into_owned()];
        let recorders = vec![recorder.to_string_lossy().into_owned()];
        let report = run_sync(&cameras, &recorders, None, &AtomicBool::new(false), |_, _, _| {}).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        let by_camera = |c: &Path| report.matches.iter().find(|m| m.camera == c.to_string_lossy()).unwrap().clone();
        let m1 = by_camera(&cam1);
        assert!(m1.matched && m1.refined, "{m1:?}");
        // AAC adds a little priming delay; within 2 ms of the truth is what an editor needs.
        assert!((m1.offset - -100.25).abs() < 0.002, "{m1:?}");
        let m2 = by_camera(&cam2);
        assert!(m2.matched && m2.refined, "{m2:?}");
        assert!((m2.offset - 1.6).abs() < 0.002, "{m2:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_camera_without_sound_is_reported() {
        if Command::new(ffmpeg_binary()).arg("-version").output().is_err() {
            return;
        }
        let dir = temp_dir("silent");
        let camera = dir.join("silent.mov");
        assert!(Command::new(ffmpeg_binary())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=25:d=2", "-c:v", "libx264"])
            .arg(&camera)
            .status()
            .unwrap()
            .success());
        let recorder = dir.join("r.wav");
        write_wav(&recorder, &speechlike(5.0, 8000, 1), 8000);
        let report = run_sync(
            &[camera.to_string_lossy().into_owned()],
            &[recorder.to_string_lossy().into_owned()],
            None,
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(report.errors.len(), 1);
        assert!(report.matches.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Syncs real footage: `VIBECUT_SYNC_CAMERAS` and `VIBECUT_SYNC_RECORDERS` (paths separated by `:`),
    /// printing the report. `cargo test -- --ignored real_footage --nocapture`.
    #[test]
    #[ignore]
    fn real_footage() {
        let paths = |key: &str| -> Vec<String> { std::env::var(key).unwrap_or_default().split(':').filter(|p| !p.is_empty()).map(String::from).collect() };
        let (cameras, recorders) = (paths("VIBECUT_SYNC_CAMERAS"), paths("VIBECUT_SYNC_RECORDERS"));
        assert!(!cameras.is_empty() && !recorders.is_empty(), "set VIBECUT_SYNC_CAMERAS and VIBECUT_SYNC_RECORDERS");
        let report = run_sync(&cameras, &recorders, None, &AtomicBool::new(false), |_, _, _| {}).unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        assert!(report.errors.is_empty());
    }
}
