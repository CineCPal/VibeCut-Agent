//! Reads the transcripts the Interview Transcriber leaves next to each video (VibeCut's transcript.rs,
//! verbatim; PLAN.md "Phase 6b"), for the agent's transcript tools. Read only: the file is `<video path>.ivt-cache.json`, nothing else is ever opened, and
//! a transcript is ignored when the video has changed since it was written (the same size and
//! modification-time rule `pipeline.load_cache` applies in Python).
//!
//! The Blair suite's A-Sync also leaves its sync offsets next to the video, either inside the same
//! cache (`sync_tracks`) or in `<video path>.sync-offsets.json`; `read_suite_sync` reads those, so a
//! clip synced there comes into VibeCut already synced (PLAN.md, "Synced audio").

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const CACHE_SUFFIX: &str = ".ivt-cache.json";
const SYNC_OFFSETS_SUFFIX: &str = ".sync-offsets.json";
/// An offsets sidecar is a few hundred bytes.
const MAX_SYNC_OFFSETS_BYTES: u64 = 1024 * 1024;
/// A transcript of many hours is a few MB; anything bigger is not something the tool wrote.
pub const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub speaker: String,
    /// Per-word timings in source seconds, when the transcriber recorded them (transcripts made
    /// before it did, or lines edited by hand, have none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscriptWord>>,
}

/// The segment's words, in time order and clamped inside the segment; malformed ones are dropped.
fn parse_words(value: Option<&Value>, seg_start: f64, seg_end: f64) -> Option<Vec<TranscriptWord>> {
    let mut words: Vec<TranscriptWord> = value?
        .as_array()?
        .iter()
        .filter_map(|w| {
            let start = w.get("start")?.as_f64()?.max(seg_start);
            let end = w.get("end")?.as_f64()?.min(seg_end);
            let text = w.get("text")?.as_str()?.trim();
            (start.is_finite() && end.is_finite() && end > start && !text.is_empty())
                .then(|| TranscriptWord { start, end, text: text.to_string() })
        })
        .collect();
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    (!words.is_empty()).then_some(words)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptData {
    pub segments: Vec<TranscriptSegment>,
    pub speakers: Vec<String>,
    /// Display names the user gave to speakers in the transcriber, by speaker id.
    pub speaker_labels: BTreeMap<String, String>,
    /// Speakers the user turned off in the transcriber; their lines are not part of the transcript.
    pub excluded_speakers: Vec<String>,
    /// The external recording the suite transcribed instead of the video's own sound. Its times were
    /// already shifted onto the video by `sync_offset_seconds`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_offset_seconds: Option<f64>,
}

/// One external recording A-Sync lined up with a video.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteSyncTrack {
    pub path: String,
    /// Seconds the recording is delayed: video_time = recording_time + offset (VibeCut's convention too).
    pub offset_seconds: f64,
    pub enabled: bool,
    /// A-Sync's channel routing: missing or empty is every channel, `[0]` a downmix, else 1-based channels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<Vec<u32>>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteSync {
    pub method: String,
    pub tracks: Vec<SuiteSyncTrack>,
}

fn with_suffix(media: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = media.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

pub fn cache_path(media: &Path) -> PathBuf {
    with_suffix(media, CACHE_SUFFIX)
}

/// A small JSON file, or `None` if it is missing, too big or unreadable.
fn read_json(path: &Path, max_bytes: u64) -> Option<Value> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return None;
    }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn parse_sync_tracks(value: Option<&Value>) -> Option<Vec<SuiteSyncTrack>> {
    let tracks = value?.as_array()?;
    Some(
        tracks
            .iter()
            .filter_map(|t| {
                let path = t.get("path")?.as_str()?;
                if !Path::new(path).is_absolute() {
                    return None;
                }
                let offset_seconds = t.get("offset_seconds").and_then(Value::as_f64).unwrap_or(0.0);
                if !offset_seconds.is_finite() {
                    return None;
                }
                let channels = t
                    .get("channels")
                    .and_then(Value::as_array)
                    .map(|c| c.iter().filter_map(Value::as_u64).filter_map(|n| u32::try_from(n).ok()).collect::<Vec<_>>())
                    .filter(|c| !c.is_empty());
                Some(SuiteSyncTrack {
                    path: path.to_string(),
                    offset_seconds,
                    enabled: t.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    channels,
                })
            })
            .collect(),
    )
}

/// The offsets A-Sync saved for `video`: the transcript cache's `sync_tracks` first (where the suite
/// moves them once a video is also transcribed), else the `.sync-offsets.json` sidecar. Unlike the
/// transcript, this is not tied to the video's size and date: an offset stays true for a re-saved file.
pub fn read_suite_sync_from(video: &Path) -> Option<SuiteSync> {
    if !video.is_absolute() {
        return None;
    }
    let method = |data: &Value, key: &str| data.get(key).and_then(Value::as_str).unwrap_or("waveform").to_string();
    if let Some(cache) = read_json(&cache_path(video), MAX_TRANSCRIPT_BYTES) {
        if let Some(tracks) = parse_sync_tracks(cache.get("sync_tracks")) {
            return Some(SuiteSync { method: method(&cache, "sync_method"), tracks });
        }
    }
    let sidecar = read_json(&with_suffix(video, SYNC_OFFSETS_SUFFIX), MAX_SYNC_OFFSETS_BYTES)?;
    let tracks = parse_sync_tracks(sidecar.get("tracks"))?;
    Some(SuiteSync { method: method(&sidecar, "method"), tracks })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// One segment, or `None` if it is malformed or has no usable time range.
fn parse_segment(value: &Value) -> Option<TranscriptSegment> {
    let start = value.get("start")?.as_f64()?;
    let end = value.get("end")?.as_f64()?;
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return None;
    }
    let text = value.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let speaker = value.get("speaker").and_then(Value::as_str).unwrap_or("Speaker 0");
    let words = parse_words(value.get("words"), start, end);
    Some(TranscriptSegment { start, end, text: text.to_string(), speaker: speaker.to_string(), words })
}

/// Whether the cache still describes the file on disk. A video that cannot be inspected (offline
/// drive) is given the benefit of the doubt, as in the Python tool.
fn matches_media(data: &Value, media: &Path) -> bool {
    let Ok(meta) = fs::metadata(media) else { return true };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let size_ok = data.get("video_size").and_then(Value::as_u64) == Some(meta.len());
    let mtime_ok = mtime.is_some() && data.get("video_mtime").and_then(Value::as_u64) == mtime;
    size_ok && mtime_ok
}

/// The transcript stored for `media`, or `None` when there is none, it cannot be read, or it is stale.
pub fn read_transcript_from(media: &Path) -> Option<TranscriptData> {
    if !media.is_absolute() {
        return None;
    }
    let data = read_json(&cache_path(media), MAX_TRANSCRIPT_BYTES)?;
    if !matches_media(&data, media) {
        return None;
    }

    let mut segments: Vec<TranscriptSegment> =
        data.get("segments")?.as_array()?.iter().filter_map(parse_segment).collect();
    segments.sort_by(|a, b| a.start.total_cmp(&b.start));
    if segments.is_empty() {
        return None;
    }
    let speaker_labels = data
        .get("speaker_labels")
        .and_then(Value::as_object)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|(id, label)| label.as_str().map(str::trim).filter(|l| !l.is_empty()).map(|l| (id.clone(), l.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some(TranscriptData {
        segments,
        speakers: strings(data.get("speakers")),
        speaker_labels,
        excluded_speakers: strings(data.get("excluded_speakers")),
        audio_source: data.get("audio_source").and_then(Value::as_str).filter(|p| Path::new(p).is_absolute()).map(String::from),
        sync_offset_seconds: data.get("sync_offset_seconds").and_then(Value::as_f64).filter(|o| o.is_finite()),
    })
}

#[tauri::command]
pub async fn read_transcript(media_path: String) -> Result<Option<TranscriptData>, String> {
    tauri::async_runtime::spawn_blocking(move || read_transcript_from(Path::new(&media_path)))
        .await
        .map_err(|e| format!("Could not read the transcript: {e}"))
}

#[tauri::command]
pub async fn read_suite_sync(video_path: String) -> Result<Option<SuiteSync>, String> {
    tauri::async_runtime::spawn_blocking(move || read_suite_sync_from(Path::new(&video_path)))
        .await
        .map_err(|e| format!("Could not read the sync offsets: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        dir: PathBuf,
        video: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("vibecut-transcript-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let video = dir.join("interview.mp4");
            fs::write(&video, b"not really a video").unwrap();
            Fixture { dir, video }
        }

        fn stamp(&self) -> (u64, u64) {
            let meta = fs::metadata(&self.video).unwrap();
            (meta.len(), meta.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_secs())
        }

        fn write_cache(&self, body: Value) {
            fs::write(cache_path(&self.video), body.to_string()).unwrap();
        }

        fn cache_for_current_video(&self, segments: Value) -> Value {
            let (size, mtime) = self.stamp();
            json!({ "video_size": size, "video_mtime": mtime, "speakers": ["Speaker 0", "Speaker 1"], "segments": segments })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn the_cache_sits_next_to_the_video_with_the_transcribers_suffix() {
        assert_eq!(cache_path(Path::new("/a b/interview.mp4")), PathBuf::from("/a b/interview.mp4.ivt-cache.json"));
    }

    #[test]
    fn reads_segments_in_time_order_with_labels_and_exclusions() {
        let f = Fixture::new("read");
        let mut cache = f.cache_for_current_video(json!([
            { "start": 5.0, "end": 8.5, "text": " Second line ", "speaker": "Speaker 1", "avg_logprob": -0.2 },
            { "start": 0.5, "end": 4.0, "text": "First line", "speaker": "Speaker 0" },
        ]));
        cache["speaker_labels"] = json!({ "Speaker 0": "Ana", "Speaker 1": "  " });
        cache["excluded_speakers"] = json!(["Speaker 1"]);
        f.write_cache(cache);

        let data = read_transcript_from(&f.video).unwrap();
        assert_eq!(data.segments.len(), 2);
        assert_eq!(data.segments[0], TranscriptSegment { start: 0.5, end: 4.0, text: "First line".into(), speaker: "Speaker 0".into(), words: None });
        assert_eq!(data.segments[1].text, "Second line");
        assert_eq!(data.speakers, vec!["Speaker 0", "Speaker 1"]);
        assert_eq!(data.speaker_labels.get("Speaker 0").map(String::as_str), Some("Ana"));
        assert!(!data.speaker_labels.contains_key("Speaker 1"), "blank labels are dropped");
        assert_eq!(data.excluded_speakers, vec!["Speaker 1"]);
    }

    #[test]
    fn drops_segments_that_cannot_be_placed() {
        let f = Fixture::new("bad-segments");
        f.write_cache(f.cache_for_current_video(json!([
            { "start": 1.0, "end": 1.0, "text": "empty range" },
            { "start": -2.0, "end": 1.0, "text": "negative" },
            { "start": 1.0, "end": 2.0, "text": "   " },
            { "start": "x", "end": 2.0, "text": "not a number" },
            { "start": 3.0, "end": 4.0 },
            { "start": 6.0, "end": 7.0, "text": "kept" },
        ])));
        let data = read_transcript_from(&f.video).unwrap();
        assert_eq!(data.segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), vec!["kept"]);
        assert_eq!(data.segments[0].speaker, "Speaker 0", "a missing speaker gets the tool's default");
    }

    #[test]
    fn no_cache_or_no_usable_segments_gives_none() {
        let f = Fixture::new("none");
        assert!(read_transcript_from(&f.video).is_none());
        f.write_cache(f.cache_for_current_video(json!([])));
        assert!(read_transcript_from(&f.video).is_none());
    }

    #[test]
    fn a_video_that_changed_since_transcription_is_ignored() {
        let f = Fixture::new("stale");
        let segments = json!([{ "start": 0.0, "end": 1.0, "text": "hello" }]);
        let mut cache = f.cache_for_current_video(segments.clone());
        cache["video_size"] = json!(cache["video_size"].as_u64().unwrap() + 1);
        f.write_cache(cache);
        assert!(read_transcript_from(&f.video).is_none(), "size differs");

        let mut cache = f.cache_for_current_video(segments.clone());
        cache["video_mtime"] = json!(cache["video_mtime"].as_u64().unwrap() - 10);
        f.write_cache(cache);
        assert!(read_transcript_from(&f.video).is_none(), "modification time differs");

        f.write_cache(json!({ "segments": segments }));
        assert!(read_transcript_from(&f.video).is_none(), "a cache that never recorded the video is stale, as in Python");
    }

    #[test]
    fn an_offline_video_keeps_its_transcript() {
        let f = Fixture::new("offline");
        f.write_cache(json!({ "video_size": 1, "video_mtime": 1, "segments": [{ "start": 0.0, "end": 1.0, "text": "hello" }] }));
        fs::remove_file(&f.video).unwrap();
        assert!(read_transcript_from(&f.video).is_some());
    }

    #[test]
    fn rejects_relative_paths_malformed_files_and_oversized_files() {
        assert!(read_transcript_from(Path::new("interview.mp4")).is_none());

        let f = Fixture::new("malformed");
        fs::write(cache_path(&f.video), "{ not json").unwrap();
        assert!(read_transcript_from(&f.video).is_none());
        f.write_cache(json!(["not", "an", "object"]));
        assert!(read_transcript_from(&f.video).is_none());

        let big = Fixture::new("big");
        let file = fs::File::create(cache_path(&big.video)).unwrap();
        file.set_len(MAX_TRANSCRIPT_BYTES + 1).unwrap();
        assert!(read_transcript_from(&big.video).is_none());
    }

    #[test]
    fn serializes_with_the_names_the_frontend_expects() {
        let data = TranscriptData {
            segments: vec![TranscriptSegment { start: 0.0, end: 1.0, text: "x".into(), speaker: "S".into(), words: None }],
            speakers: vec!["S".into()],
            speaker_labels: BTreeMap::from([("S".to_string(), "Ana".to_string())]),
            excluded_speakers: vec![],
            audio_source: None,
            sync_offset_seconds: None,
        };
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["speakerLabels"]["S"], "Ana");
        assert_eq!(value["excludedSpeakers"], json!([]));
        assert!(value["segments"][0].get("text").is_some());
    }

    #[test]
    fn reads_word_timings_clamped_to_their_line_and_skips_bad_ones() {
        let f = Fixture::new("words");
        f.write_cache(f.cache_for_current_video(json!([
            { "start": 1.0, "end": 3.0, "text": "Um, hello there", "speaker": "Speaker 0", "words": [
                { "start": 1.8, "end": 2.2, "text": "there" },
                { "start": 0.9, "end": 1.2, "text": "Um," },
                { "start": 1.3, "end": 1.3, "text": "empty-range" },
                { "start": 1.4, "end": 1.7, "text": "  " },
                { "start": 1.4, "end": 1.7, "text": "hello" },
                { "start": 2.9, "end": 3.4, "text": "overrun" }
            ]},
            { "start": 4.0, "end": 5.0, "text": "No words recorded", "speaker": "Speaker 1" }
        ])));

        let data = read_transcript_from(&f.video).unwrap();
        let words = data.segments[0].words.as_ref().unwrap();
        let texts: Vec<_> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, vec!["Um,", "hello", "there", "overrun"]);
        assert_eq!((words[0].start, words[0].end), (1.0, 1.2)); // clamped to the line's start
        assert_eq!((words[3].start, words[3].end), (2.9, 3.0)); // clamped to the line's end
        assert!(data.segments[1].words.is_none());

        // An absent word list is left out of the IPC payload entirely.
        let json = serde_json::to_value(&data.segments[1]).unwrap();
        assert!(json.get("words").is_none());
    }

    #[test]
    fn reads_the_suites_record_of_which_recording_was_transcribed() {
        let f = Fixture::new("audio-source");
        let mut cache = f.cache_for_current_video(json!([{ "start": 1.0, "end": 2.0, "text": "Hi" }]));
        cache["audio_source"] = json!("/rec/ZOOM0001.WAV");
        cache["sync_offset_seconds"] = json!(-12.5);
        f.write_cache(cache);
        let data = read_transcript_from(&f.video).unwrap();
        assert_eq!(data.audio_source.as_deref(), Some("/rec/ZOOM0001.WAV"));
        assert_eq!(data.sync_offset_seconds, Some(-12.5));
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["audioSource"], "/rec/ZOOM0001.WAV");
        assert_eq!(value["syncOffsetSeconds"], -12.5);
    }

    #[test]
    fn reads_a_sync_offsets_from_the_sidecar() {
        let f = Fixture::new("sync-sidecar");
        fs::write(
            with_suffix(&f.video, SYNC_OFFSETS_SUFFIX),
            json!({
                "video_path": f.video.to_string_lossy(),
                "method": "waveform",
                "tracks": [
                    { "path": "/rec/lav.wav", "offset_seconds": 1.6 },
                    { "path": "/rec/boom.wav", "offset_seconds": -2.0, "enabled": false, "channels": [2] },
                    { "path": "relative.wav", "offset_seconds": 0.0 },
                ],
            })
            .to_string(),
        )
        .unwrap();
        let sync = read_suite_sync_from(&f.video).unwrap();
        assert_eq!(sync.method, "waveform");
        assert_eq!(
            sync.tracks,
            vec![
                SuiteSyncTrack { path: "/rec/lav.wav".into(), offset_seconds: 1.6, enabled: true, channels: None },
                SuiteSyncTrack { path: "/rec/boom.wav".into(), offset_seconds: -2.0, enabled: false, channels: Some(vec![2]) },
            ]
        );
    }

    #[test]
    fn the_caches_sync_tracks_win_over_a_leftover_sidecar() {
        let f = Fixture::new("sync-cache");
        let mut cache = f.cache_for_current_video(json!([{ "start": 1.0, "end": 2.0, "text": "Hi" }]));
        cache["sync_tracks"] = json!([{ "path": "/rec/new.wav", "offset_seconds": 3.0 }]);
        cache["sync_method"] = json!("timecode");
        f.write_cache(cache);
        fs::write(with_suffix(&f.video, SYNC_OFFSETS_SUFFIX), json!({ "tracks": [{ "path": "/rec/old.wav", "offset_seconds": 9.0 }] }).to_string()).unwrap();
        let sync = read_suite_sync_from(&f.video).unwrap();
        assert_eq!(sync.method, "timecode");
        assert_eq!(sync.tracks.len(), 1);
        assert_eq!(sync.tracks[0].path, "/rec/new.wav");
    }

    #[test]
    fn no_suite_sync_without_either_file() {
        let f = Fixture::new("sync-none");
        assert!(read_suite_sync_from(&f.video).is_none());
        assert!(read_suite_sync_from(Path::new("relative.mp4")).is_none());
    }
}
