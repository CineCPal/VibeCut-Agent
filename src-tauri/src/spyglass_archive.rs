//! Reads Spyglass's index (`spyglass_index.sqlite`) for the B-roll panel: the folder tree, which clips a
//! set of folders covers, and a page-by-page listing of their shots with what Spyglass saw in them.
//!
//! READ ONLY. The index belongs to Spyglass. It is opened with `SQLITE_OPEN_READ_ONLY` and
//! `PRAGMA query_only`, and nothing here ever writes to it. The text search (which needs CLIP) stays in
//! the Python sidecar (`spyglass_index.py`); it is handed the clip ids this module resolves, so the folder
//! and alias rules below live in one place.
//!
//! The folder tree is a port of Spyglass's `crates/spyglass-core/src/folders.rs`. There is no folder table:
//! `watched_roots` lists the top-level scan roots, and everything under them is known only from
//! `clips.file_path`. Finder aliases (`alias_links`) can put a folder's footage on another volume, so a
//! folder's "apparent" path is translated to the real path prefixes its clips are registered under. Unlike
//! Spyglass, prefixes are compared in Rust rather than with SQL `LIKE`, so a `%` or `_` in a folder name is
//! never a wildcard, and a clip reached through two prefixes is counted once.

use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

/// Tables and columns this module cannot work without.
const REQUIRED: &[(&str, &[&str])] = &[
    ("clips", &["id", "file_path"]),
    ("shots", &["id", "clip_id", "start_tc", "end_tc"]),
    ("watched_roots", &["id", "label", "path"]),
];

/// The most shots one browse page may hold.
pub const MAX_BROWSE_LIMIT: usize = 200;
/// How much of the transcript under a shot is returned.
const TRANSCRIPT_CHARS: usize = 300;
/// SQLite's default limit on `?` parameters is well above this; chunks keep each query small.
const CHUNK: usize = 500;

fn db_error(e: rusqlite::Error) -> String {
    format!("The Spyglass index could not be read: {e}")
}

/// Opens the index read-only and checks that it has what this module reads.
pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(format!("The Spyglass index was not found: {}", path.display()));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("The Spyglass index could not be opened: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    conn.execute_batch("PRAGMA query_only = ON").map_err(db_error)?;
    for (table, needed) in REQUIRED {
        let found = columns(&conn, table)?;
        if !needed.iter().all(|c| found.contains(*c)) {
            return Err(format!("That does not look like a Spyglass index (unexpected: {table})"));
        }
    }
    Ok(conn)
}

/// Column names of `table`; empty when there is no such table. `table` is always a constant here.
fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(db_error)?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(db_error)?;
    names.collect::<Result<_, _>>().map_err(db_error)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool, String> {
    Ok(!columns(conn, table)?.is_empty())
}

/// `column` when the table has it, else `NULL`, so older indexes still read.
fn column_or_null<'a>(found: &HashSet<String>, column: &'a str) -> &'a str {
    if found.contains(column) {
        column
    } else {
        "NULL"
    }
}

// ------------------------------------------------------------------------------------------ paths

/// `path` with exactly one trailing `/`, so `/Volumes/Archive2` never counts as inside `/Volumes/Archive`.
fn normalize_prefix(path: &str) -> String {
    format!("{}/", path.trim_end_matches('/'))
}

/// Whether `path` is `base` itself or anywhere below it.
fn is_under(path: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    path == base || path.starts_with(&normalize_prefix(base))
}

/// One hop through the longest alias whose apparent path is `path` or an ancestor of it.
fn translate_once(links: &[(String, String)], path: &str) -> String {
    let current = path.trim_end_matches('/');
    let best = links
        .iter()
        .map(|(apparent, real)| (apparent.trim_end_matches('/'), real.trim_end_matches('/')))
        .filter(|(apparent, _)| current == *apparent || current.starts_with(&format!("{apparent}/")))
        .max_by_key(|(apparent, _)| apparent.len());
    match best {
        Some((apparent, real)) => format!("{real}{}", &current[apparent.len()..]),
        None => current.to_string(),
    }
}

/// Follows a chain of nested aliases; bounded so a corrupt, cyclic table cannot loop forever.
fn translate_chain(links: &[(String, String)], path: &str) -> String {
    let mut current = path.trim_end_matches('/').to_string();
    for _ in 0..8 {
        let next = translate_once(links, &current);
        if next == current {
            break;
        }
        current = next;
    }
    current
}

/// Every real prefix whose clips count as under `base`: `base` itself plus the target of every alias
/// anywhere below it, recursively.
fn real_prefixes_recursive(links: &[(String, String)], base: &str, depth: usize) -> Vec<String> {
    let mut out = vec![base.to_string()];
    if depth >= 8 {
        return out;
    }
    for (apparent, real) in links {
        if is_under(apparent.trim_end_matches('/'), base) {
            out.extend(real_prefixes_recursive(links, real.trim_end_matches('/'), depth + 1));
        }
    }
    out
}

/// Names of aliases sitting directly inside `apparent_parent`.
fn immediate_alias_child_names(links: &[(String, String)], apparent_parent: &str) -> Vec<String> {
    let boundary = normalize_prefix(apparent_parent);
    links
        .iter()
        .filter_map(|(apparent, _)| {
            let rest = apparent.trim_end_matches('/').strip_prefix(boundary.as_str())?;
            (!rest.is_empty() && !rest.contains('/')).then(|| rest.to_string())
        })
        .collect()
}

// ------------------------------------------------------------------------------------------ the archive

struct Root {
    id: i64,
    label: String,
    path: String,
}

struct ClipRow {
    id: i64,
    path: String,
    size: Option<i64>,
    recorded_at: Option<String>,
    shots: i64,
    technical: i64,
    energy: i64,
}

/// What the tree and the summaries need, read once per index version (see `spyglass::ArchiveCache`).
pub struct Archive {
    roots: Vec<Root>,
    clips: Vec<ClipRow>,
    links: Vec<(String, String)>,
    /// clip id -> (lowercased tag, shots carrying it)
    clip_tags: HashMap<i64, Vec<(String, i64)>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TagCount {
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    /// The folder's apparent path: what a caller passes back to expand it or to use it as a scope.
    pub path: String,
    pub is_root: bool,
    /// Shots anywhere under the folder.
    pub shot_count: i64,
    pub has_children: bool,
    /// Whether the folder can be reached now (its drive is attached).
    pub online: bool,
    pub top_tags: Vec<TagCount>,
    pub date_range: Option<DateRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    pub clip_count: usize,
    pub shot_count: i64,
    pub technical_count: i64,
    pub energy_count: i64,
    pub date_range: Option<DateRange>,
    pub top_tags: Vec<TagCount>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseShot {
    pub shot_id: i64,
    pub path: String,
    pub filename: String,
    pub start: f64,
    pub end: f64,
    pub caption: Option<String>,
    pub tags: Vec<String>,
    pub technical: Option<f64>,
    pub energy: Option<f64>,
    pub recorded_at: Option<String>,
    pub transcript: Option<String>,
    /// The shot's keyframe image, when it exists on disk.
    pub keyframe: Option<String>,
    /// "ok", "offline" (the file is not there, e.g. its drive is not attached) or "changed" (its size is
    /// not what Spyglass indexed, so the shot's times may point into a different version of the file).
    pub status: &'static str,
}

impl Archive {
    pub fn load(conn: &Connection) -> Result<Archive, String> {
        let root_cols = columns(conn, "watched_roots")?;
        let root_sql = if root_cols.contains("access_level") {
            "SELECT id, label, path FROM watched_roots WHERE access_level != 'removed'"
        } else {
            "SELECT id, label, path FROM watched_roots"
        };
        let mut stmt = conn.prepare(root_sql).map_err(db_error)?;
        let roots = stmt
            .query_map([], |r| Ok(Root { id: r.get(0)?, label: r.get(1)?, path: r.get(2)? }))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;

        let clip_cols = columns(conn, "clips")?;
        let clip_sql = format!(
            "SELECT id, file_path, {}, {} FROM clips",
            column_or_null(&clip_cols, "size_bytes"),
            column_or_null(&clip_cols, "recorded_at")
        );
        let mut stmt = conn.prepare(&clip_sql).map_err(db_error)?;
        let mut clips = stmt
            .query_map([], |r| {
                Ok(ClipRow {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    size: r.get(2)?,
                    recorded_at: r.get(3)?,
                    shots: 0,
                    technical: 0,
                    energy: 0,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        clips.sort_by(|a, b| a.path.cmp(&b.path));

        let shot_cols = columns(conn, "shots")?;
        let count_sql = format!(
            "SELECT clip_id, COUNT(*), COUNT({}), COUNT({}) FROM shots GROUP BY clip_id",
            column_or_null(&shot_cols, "technical_quality_score"),
            column_or_null(&shot_cols, "energy_score")
        );
        let mut stmt = conn.prepare(&count_sql).map_err(db_error)?;
        let counts: HashMap<i64, (i64, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .map_err(db_error)?
            .collect::<Result<_, _>>()
            .map_err(db_error)?;
        for clip in &mut clips {
            if let Some(&(shots, technical, energy)) = counts.get(&clip.id) {
                clip.shots = shots;
                clip.technical = technical;
                clip.energy = energy;
            }
        }

        let mut clip_tags: HashMap<i64, Vec<(String, i64)>> = HashMap::new();
        if has_table(conn, "tags")? {
            let mut stmt = conn
                .prepare(
                    "SELECT s.clip_id, LOWER(t.label), COUNT(DISTINCT t.shot_id) FROM tags t \
                     JOIN shots s ON s.id = t.shot_id GROUP BY s.clip_id, LOWER(t.label)",
                )
                .map_err(db_error)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(db_error)?;
            for row in rows {
                let (clip, label, count) = row.map_err(db_error)?;
                clip_tags.entry(clip).or_default().push((label, count));
            }
        }

        let links = if has_table(conn, "alias_links")? {
            let mut stmt = conn.prepare("SELECT apparent_path, real_path FROM alias_links").map_err(db_error)?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
        } else {
            Vec::new()
        };

        Ok(Archive { roots, clips, links, clip_tags })
    }

    /// Indexes (into `clips`, which is sorted by path) of every clip anywhere under an apparent folder.
    fn members(&self, apparent: &str) -> Vec<usize> {
        let bases = real_prefixes_recursive(&self.links, &translate_chain(&self.links, apparent), 0);
        (0..self.clips.len()).filter(|&i| bases.iter().any(|b| is_under(&self.clips[i].path, b))).collect()
    }

    fn has_real_subfolder(&self, apparent: &str) -> bool {
        let prefix = normalize_prefix(&translate_chain(&self.links, apparent));
        self.clips.iter().any(|c| c.path.strip_prefix(prefix.as_str()).is_some_and(|rest| rest.contains('/')))
    }

    fn summary_of(&self, members: &[usize]) -> ScopeSummary {
        let mut shot_count = 0;
        let mut technical_count = 0;
        let mut energy_count = 0;
        let mut dates: Vec<&str> = Vec::new();
        let mut tags: HashMap<&str, i64> = HashMap::new();
        for &i in members {
            let clip = &self.clips[i];
            shot_count += clip.shots;
            technical_count += clip.technical;
            energy_count += clip.energy;
            if let Some(date) = clip.recorded_at.as_deref().and_then(|d| d.get(..10)) {
                dates.push(date);
            }
            for (label, count) in self.clip_tags.get(&clip.id).map(Vec::as_slice).unwrap_or_default() {
                *tags.entry(label).or_default() += count;
            }
        }
        let date_range = match (dates.iter().min(), dates.iter().max()) {
            (Some(from), Some(to)) => Some(DateRange { from: from.to_string(), to: to.to_string() }),
            _ => None,
        };
        let mut top_tags: Vec<TagCount> = tags.into_iter().map(|(label, count)| TagCount { label: label.to_string(), count }).collect();
        top_tags.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
        ScopeSummary { clip_count: members.len(), shot_count, technical_count, energy_count, date_range, top_tags }
    }

    fn node(&self, name: String, path: String, is_root: bool) -> FolderNode {
        let summary = self.summary_of(&self.members(&path));
        let has_children = self.has_real_subfolder(&path) || !immediate_alias_child_names(&self.links, &path).is_empty();
        let online = Path::new(&translate_chain(&self.links, &path)).exists();
        let mut top_tags = summary.top_tags;
        top_tags.truncate(5);
        FolderNode { name, path, is_root, shot_count: summary.shot_count, has_children, online, top_tags, date_range: summary.date_range }
    }

    /// `None`: the watched roots, most recent label first (they are season-shaped, like "2025-2026").
    /// `Some(parent)`: the folders directly inside `parent`, A to Z.
    pub fn children(&self, parent: Option<&str>) -> Vec<FolderNode> {
        match parent {
            None => {
                let mut roots: Vec<&Root> = self.roots.iter().collect();
                roots.sort_by(|a, b| b.label.cmp(&a.label).then_with(|| a.id.cmp(&b.id)));
                roots.into_iter().map(|r| self.node(r.label.clone(), r.path.trim_end_matches('/').to_string(), true)).collect()
            }
            Some(parent) => {
                let parent = parent.trim_end_matches('/');
                let real_prefix = normalize_prefix(&translate_chain(&self.links, parent));
                let mut names: Vec<String> = self
                    .clips
                    .iter()
                    .filter_map(|c| {
                        let rest = c.path.strip_prefix(real_prefix.as_str())?;
                        let (name, _) = rest.split_once('/')?;
                        (!name.is_empty()).then(|| name.to_string())
                    })
                    .collect();
                names.extend(immediate_alias_child_names(&self.links, parent));
                names.sort();
                names.dedup();
                let apparent_prefix = normalize_prefix(parent);
                names.into_iter().map(|name| {
                    let path = format!("{apparent_prefix}{name}");
                    self.node(name, path, false)
                }).collect()
            }
        }
    }

    /// Clips (as `clips` indexes, in path order) under any of `scopes`, or under every watched root when
    /// `scopes` is empty. A scope must be a watched root or a folder inside one.
    pub fn resolve(&self, scopes: &[String]) -> Result<Vec<usize>, String> {
        let wanted: Vec<String> = if scopes.is_empty() {
            self.roots.iter().map(|r| r.path.clone()).collect()
        } else {
            for scope in scopes {
                if !self.roots.iter().any(|r| is_under(scope.trim_end_matches('/'), &r.path)) {
                    return Err(format!("{scope} is not a folder Spyglass watches (see its watched folders)"));
                }
            }
            scopes.to_vec()
        };
        let mut set: HashSet<usize> = HashSet::new();
        for scope in &wanted {
            set.extend(self.members(scope));
        }
        let mut out: Vec<usize> = set.into_iter().collect();
        out.sort_unstable();
        Ok(out)
    }

    pub fn clip_ids(&self, members: &[usize]) -> Vec<i64> {
        members.iter().map(|&i| self.clips[i].id).collect()
    }

    pub fn summary(&self, members: &[usize]) -> ScopeSummary {
        self.summary_of(members)
    }

    /// One page of the shots of `members`, ordered by clip path and then time.
    pub fn browse(&self, conn: &Connection, members: &[usize], offset: usize, limit: usize) -> Result<Vec<BrowseShot>, String> {
        let limit = limit.clamp(1, MAX_BROWSE_LIMIT);
        // Which clips the page touches, and how many of the first one's shots come before it.
        let mut page_clips: Vec<usize> = Vec::new();
        let mut skip_in_first = 0usize;
        let mut seen = 0usize;
        for &i in members {
            let count = self.clips[i].shots.max(0) as usize;
            if seen + count > offset && seen < offset + limit {
                if page_clips.is_empty() {
                    skip_in_first = offset.saturating_sub(seen);
                }
                page_clips.push(i);
            }
            seen += count;
            if seen >= offset + limit {
                break;
            }
        }
        if page_clips.is_empty() {
            return Ok(Vec::new());
        }

        let shot_cols = columns(conn, "shots")?;
        let sql_head = format!(
            "SELECT id, clip_id, start_tc, end_tc, {}, {}, {}, {} FROM shots WHERE clip_id IN",
            column_or_null(&shot_cols, "caption"),
            column_or_null(&shot_cols, "technical_quality_score"),
            column_or_null(&shot_cols, "energy_score"),
            column_or_null(&shot_cols, "keyframe_path")
        );
        type ShotRow = (i64, i64, f64, f64, Option<String>, Option<f64>, Option<f64>, Option<String>);
        let mut by_clip: HashMap<i64, Vec<ShotRow>> = HashMap::new();
        let ids: Vec<i64> = page_clips.iter().map(|&i| self.clips[i].id).collect();
        for chunk in ids.chunks(CHUNK) {
            let sql = format!("{sql_head} ({}) ORDER BY start_tc, id", marks(chunk.len()));
            let mut stmt = conn.prepare(&sql).map_err(db_error)?;
            let rows = stmt
                .query_map(params_from_iter(chunk.iter()), |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
                })
                .map_err(db_error)?;
            for row in rows {
                let row: ShotRow = row.map_err(db_error)?;
                by_clip.entry(row.1).or_default().push(row);
            }
        }

        let mut rows: Vec<(usize, ShotRow)> = Vec::new();
        for (n, &i) in page_clips.iter().enumerate() {
            let shots = by_clip.remove(&self.clips[i].id).unwrap_or_default();
            let skip = if n == 0 { skip_in_first } else { 0 };
            rows.extend(shots.into_iter().skip(skip).map(|s| (i, s)));
        }
        rows.truncate(limit);

        let shot_ids: Vec<i64> = rows.iter().map(|(_, s)| s.0).collect();
        let tags = shot_tags(conn, &shot_ids)?;
        let transcripts = clip_transcripts(conn, &ids)?;
        let mut status_of: HashMap<usize, &'static str> = HashMap::new();

        Ok(rows
            .into_iter()
            .map(|(i, (shot_id, clip_id, start, end, caption, technical, energy, keyframe))| {
                let clip = &self.clips[i];
                let status = *status_of.entry(i).or_insert_with(|| file_status(&clip.path, clip.size));
                let transcript = transcripts.get(&clip_id).and_then(|segments| transcript_under(segments, start, end));
                BrowseShot {
                    shot_id,
                    path: clip.path.clone(),
                    filename: Path::new(&clip.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    start: round(start, 3),
                    end: round(end, 3),
                    caption: caption.filter(|c| !c.trim().is_empty()),
                    tags: tags.get(&shot_id).cloned().unwrap_or_default(),
                    technical: technical.map(|t| round(t, 1)),
                    energy: energy.map(|e| round(e, 3)),
                    recorded_at: clip.recorded_at.clone(),
                    transcript,
                    keyframe: keyframe.filter(|k| is_image_file(k)),
                    status,
                }
            })
            .collect())
    }
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn round(value: f64, places: i32) -> f64 {
    let factor = 10f64.powi(places);
    (value * factor).round() / factor
}

fn shot_tags(conn: &Connection, shot_ids: &[i64]) -> Result<HashMap<i64, Vec<String>>, String> {
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    if !has_table(conn, "tags")? {
        return Ok(out);
    }
    for chunk in shot_ids.chunks(CHUNK) {
        let sql = format!("SELECT shot_id, label FROM tags WHERE shot_id IN ({}) ORDER BY label", marks(chunk.len()));
        let mut stmt = conn.prepare(&sql).map_err(db_error)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(db_error)?;
        for row in rows {
            let (shot, label) = row.map_err(db_error)?;
            out.entry(shot).or_default().push(label);
        }
    }
    Ok(out)
}

type Segment = (f64, f64, String);

fn clip_transcripts(conn: &Connection, clip_ids: &[i64]) -> Result<HashMap<i64, Vec<Segment>>, String> {
    let mut out: HashMap<i64, Vec<Segment>> = HashMap::new();
    if !has_table(conn, "transcript_segments")? {
        return Ok(out);
    }
    for chunk in clip_ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT clip_id, start_tc, end_tc, text FROM transcript_segments WHERE clip_id IN ({}) ORDER BY start_tc",
            marks(chunk.len())
        );
        let mut stmt = conn.prepare(&sql).map_err(db_error)?;
        let rows = stmt
            .query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .map_err(db_error)?;
        for row in rows {
            let (clip, segment) = row.map_err(db_error)?;
            out.entry(clip).or_default().push(segment);
        }
    }
    Ok(out)
}

/// The words spoken during a shot, trimmed; `None` when nothing was said (or nothing was transcribed).
fn transcript_under(segments: &[Segment], start: f64, end: f64) -> Option<String> {
    let text = segments
        .iter()
        .filter(|(s, e, _)| *s < end && *e > start)
        .map(|(_, _, t)| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    Some(match text.char_indices().nth(TRANSCRIPT_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    })
}

fn file_status(path: &str, indexed_size: Option<i64>) -> &'static str {
    match std::fs::metadata(path) {
        Err(_) => "offline",
        Ok(meta) => match indexed_size {
            Some(size) if size >= 0 && meta.len() != size as u64 => "changed",
            _ => "ok",
        },
    }
}

/// Whether `path` is an image file that exists: only these are ever let through to the webview.
pub fn is_image_file(path: &str) -> bool {
    let p = Path::new(path);
    let image = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp"));
    image && p.is_absolute() && p.is_file()
}

/// The keyframe images of `shot_ids` that exist on disk, as (shot id, path).
pub fn keyframes(conn: &Connection, shot_ids: &[i64]) -> Result<Vec<(i64, String)>, String> {
    if !columns(conn, "shots")?.contains("keyframe_path") {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for chunk in shot_ids.chunks(CHUNK) {
        let sql = format!("SELECT id, keyframe_path FROM shots WHERE id IN ({}) AND keyframe_path IS NOT NULL", marks(chunk.len()));
        let mut stmt = conn.prepare(&sql).map_err(db_error)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(db_error)?;
        for row in rows {
            let (id, path) = row.map_err(db_error)?;
            if is_image_file(&path) {
                out.push((id, path));
            }
        }
    }
    Ok(out)
}

/// The file a shot belongs to and its keyframe (when one exists on disk), for a drag out of the window.
/// `None` when the index has no such shot. The file itself is not checked here.
pub fn shot_file(conn: &Connection, shot_id: i64) -> Result<Option<(String, Option<String>)>, String> {
    let keyframe = if columns(conn, "shots")?.contains("keyframe_path") { "s.keyframe_path" } else { "NULL" };
    let sql = format!("SELECT c.file_path, {keyframe} FROM shots s JOIN clips c ON c.id = s.clip_id WHERE s.id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(db_error)?;
    let mut rows = stmt.query([shot_id]).map_err(db_error)?;
    let Some(row) = rows.next().map_err(db_error)? else { return Ok(None) };
    let path: String = row.get(0).map_err(db_error)?;
    let image: Option<String> = row.get(1).map_err(db_error)?;
    Ok(Some((path, image.filter(|p| is_image_file(p)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    const SCHEMA: &str = "
        CREATE TABLE watched_roots (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, path TEXT NOT NULL,
            access_level TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE clips (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE, size_bytes INTEGER,
            recorded_at TEXT);
        CREATE TABLE shots (id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL, start_tc REAL NOT NULL,
            end_tc REAL NOT NULL, keyframe_path TEXT, technical_quality_score REAL, energy_score REAL, caption TEXT);
        CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id INTEGER NOT NULL, label TEXT NOT NULL);
        CREATE TABLE transcript_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL,
            start_tc REAL NOT NULL, end_tc REAL NOT NULL, text TEXT NOT NULL);
        CREATE TABLE alias_links (apparent_path TEXT PRIMARY KEY, real_path TEXT NOT NULL);
    ";

    struct Fixture {
        dir: PathBuf,
        db: PathBuf,
        conn: Connection,
    }

    impl Fixture {
        fn new(label: &str) -> Fixture {
            let dir = std::env::temp_dir().join(format!("vibecut-spyglass-archive-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let db = dir.join("spyglass_index.sqlite");
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            Fixture { dir, db, conn }
        }
        fn root(&self, label: &str, path: &str) {
            self.conn.execute("INSERT INTO watched_roots(label, path) VALUES (?1, ?2)", (label, path)).unwrap();
        }
        fn clip(&self, path: &str, shots: usize) -> i64 {
            self.conn.execute("INSERT INTO clips(file_path, recorded_at) VALUES (?1, '2026-05-01T10:00:00Z')", [path]).unwrap();
            let id = self.conn.last_insert_rowid();
            for n in 0..shots {
                let start = n as f64 * 5.0;
                self.conn
                    .execute(
                        "INSERT INTO shots(clip_id, start_tc, end_tc, caption) VALUES (?1, ?2, ?3, ?4)",
                        (id, start, start + 5.0, format!("shot {n} of {path}")),
                    )
                    .unwrap();
            }
            id
        }
        fn read(&self) -> (Connection, Archive) {
            let conn = open_readonly(&self.db).unwrap();
            let archive = Archive::load(&conn).unwrap();
            (conn, archive)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn names(nodes: &[FolderNode]) -> Vec<&str> {
        nodes.iter().map(|n| n.name.as_str()).collect()
    }

    #[test]
    fn top_level_lists_visible_roots_newest_label_first_with_recursive_counts() {
        let f = Fixture::new("roots");
        f.root("2024-2025", "/Volumes/A/2024-2025");
        f.root("2025-2026", "/Volumes/A/2025-2026");
        f.conn.execute("INSERT INTO watched_roots(label, path, access_level) VALUES ('Old', '/Volumes/Old', 'removed')", []).unwrap();
        f.clip("/Volumes/A/2025-2026/Theater/a.mov", 3);
        f.clip("/Volumes/A/2025-2026/b.mov", 1);
        f.clip("/Volumes/A/2024-2025/c.mov", 2);
        let (_, archive) = f.read();
        let roots = archive.children(None);
        assert_eq!(names(&roots), ["2025-2026", "2024-2025"]);
        assert_eq!(roots[0].shot_count, 4);
        assert!(roots[0].has_children);
        assert!(roots[0].is_root);
        assert!(!roots[1].has_children, "a root with only files directly inside has no subfolders");
        assert_eq!(roots[0].date_range, Some(DateRange { from: "2026-05-01".into(), to: "2026-05-01".into() }));
    }

    #[test]
    fn children_are_one_level_deep_and_a_sibling_with_a_longer_name_is_not_inside() {
        let f = Fixture::new("children");
        f.root("Archive", "/Volumes/Archive");
        f.clip("/Volumes/Archive/Sports/Soccer/a.mov", 1);
        f.clip("/Volumes/Archive/Sports/b.mov", 1);
        f.clip("/Volumes/Archive/Arts/c.mov", 1);
        f.clip("/Volumes/Archive2/Sports/d.mov", 5);
        let (_, archive) = f.read();
        let kids = archive.children(Some("/Volumes/Archive/"));
        assert_eq!(names(&kids), ["Arts", "Sports"]);
        assert_eq!(kids[1].path, "/Volumes/Archive/Sports");
        assert_eq!(kids[1].shot_count, 2);
        assert!(kids[1].has_children);
        assert_eq!(names(&archive.children(Some("/Volumes/Archive/Sports"))), ["Soccer"]);
        assert_eq!(archive.summary(&archive.resolve(&[]).unwrap()).shot_count, 3, "Archive2 is not under Archive");
    }

    #[test]
    fn wildcard_characters_in_folder_names_are_matched_literally() {
        let f = Fixture::new("wildcards");
        f.root("Archive", "/Volumes/Archive");
        f.clip("/Volumes/Archive/100%_done/a.mov", 1);
        f.clip("/Volumes/Archive/100X_done/b.mov", 4);
        let (_, archive) = f.read();
        let scope = archive.resolve(&["/Volumes/Archive/100%_done".to_string()]).unwrap();
        assert_eq!(archive.summary(&scope).shot_count, 1);
    }

    #[test]
    fn an_alias_child_appears_and_counts_its_real_footage() {
        let f = Fixture::new("alias");
        f.root("Archive", "/Volumes/Archive");
        f.clip("/Volumes/Archive/Arts/a.mov", 1);
        f.clip("/Volumes/Other/Athletics/Game/b.mov", 2);
        f.conn.execute("INSERT INTO alias_links VALUES ('/Volumes/Archive/Athletics', '/Volumes/Other/Athletics')", []).unwrap();
        let (_, archive) = f.read();
        let roots = archive.children(None);
        assert_eq!(roots[0].shot_count, 3, "a folder above an alias includes what the alias points to");
        let kids = archive.children(Some("/Volumes/Archive"));
        assert_eq!(names(&kids), ["Arts", "Athletics"]);
        assert_eq!(kids[1].shot_count, 2);
        assert!(kids[1].has_children);
        assert_eq!(names(&archive.children(Some("/Volumes/Archive/Athletics"))), ["Game"]);
    }

    #[test]
    fn scopes_are_unioned_without_double_counting_and_must_be_watched() {
        let f = Fixture::new("scopes");
        f.root("Archive", "/Volumes/Archive");
        let a = f.clip("/Volumes/Archive/Arts/a.mov", 1);
        let b = f.clip("/Volumes/Archive/Arts/Dance/b.mov", 2);
        f.clip("/Volumes/Archive/Sports/c.mov", 4);
        let (_, archive) = f.read();
        let scope = archive.resolve(&["/Volumes/Archive/Arts".into(), "/Volumes/Archive/Arts/Dance".into()]).unwrap();
        let mut ids = archive.clip_ids(&scope);
        ids.sort();
        assert_eq!(ids, [a, b]);
        assert_eq!(archive.summary(&scope).shot_count, 3);
        assert!(archive.resolve(&["/Users/someone/Movies".into()]).unwrap_err().contains("not a folder Spyglass watches"));
        assert_eq!(archive.resolve(&[]).unwrap().len(), 3);
    }

    #[test]
    fn browse_pages_run_across_clips_in_path_order_with_tags_and_transcript() {
        let f = Fixture::new("browse");
        f.root("Archive", "/Volumes/Archive");
        let b = f.clip("/Volumes/Archive/b.mov", 3);
        f.clip("/Volumes/Archive/a.mov", 2);
        f.conn.execute("INSERT INTO tags(shot_id, label) SELECT id, 'Crowd' FROM shots WHERE clip_id = ?1 AND start_tc = 0", [b]).unwrap();
        f.conn.execute("INSERT INTO transcript_segments(clip_id, start_tc, end_tc, text) VALUES (?1, 1, 2, 'Welcome everyone')", [b]).unwrap();
        let (conn, archive) = f.read();
        let scope = archive.resolve(&[]).unwrap();
        let summary = archive.summary(&scope);
        assert_eq!(summary.shot_count, 5);
        assert_eq!(summary.top_tags, [TagCount { label: "crowd".into(), count: 1 }]);

        let page = archive.browse(&conn, &scope, 1, 2).unwrap();
        assert_eq!(page.iter().map(|s| (s.filename.as_str(), s.start)).collect::<Vec<_>>(), [("a.mov", 5.0), ("b.mov", 0.0)]);
        assert_eq!(page[1].tags, ["Crowd"]);
        assert_eq!(page[1].transcript.as_deref(), Some("Welcome everyone"));
        assert_eq!(page[0].transcript, None);
        assert_eq!(page[0].status, "offline", "the made-up file is not on disk");
        assert!(archive.browse(&conn, &scope, 5, 10).unwrap().is_empty());
    }

    #[test]
    fn a_file_that_changed_size_is_reported_as_changed() {
        let f = Fixture::new("status");
        let dir = f.dir.to_string_lossy().into_owned();
        f.root("Here", &dir);
        let clip_path = f.dir.join("real.mov");
        fs::write(&clip_path, b"12345").unwrap();
        let id = f.clip(&clip_path.to_string_lossy(), 1);
        f.conn.execute("UPDATE clips SET size_bytes = 99 WHERE id = ?1", [id]).unwrap();
        let (conn, archive) = f.read();
        let scope = archive.resolve(&[]).unwrap();
        assert_eq!(archive.browse(&conn, &scope, 0, 10).unwrap()[0].status, "changed");
        f.conn.execute("UPDATE clips SET size_bytes = 5 WHERE id = ?1", [id]).unwrap();
        let (conn, archive) = f.read();
        assert_eq!(archive.browse(&conn, &archive.resolve(&[]).unwrap(), 0, 10).unwrap()[0].status, "ok");
    }

    #[test]
    fn only_existing_image_files_are_offered_as_keyframes() {
        let f = Fixture::new("keyframes");
        f.root("Archive", "/Volumes/Archive");
        let clip = f.clip("/Volumes/Archive/a.mov", 3);
        let jpg = f.dir.join("shot.jpg");
        fs::write(&jpg, b"jpg").unwrap();
        let txt = f.dir.join("notes.txt");
        fs::write(&txt, b"secret").unwrap();
        let ids: Vec<i64> = {
            let mut stmt = f.conn.prepare("SELECT id FROM shots WHERE clip_id = ?1 ORDER BY id").unwrap();
            stmt.query_map([clip], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        f.conn.execute("UPDATE shots SET keyframe_path = ?1 WHERE id = ?2", (jpg.to_string_lossy(), ids[0])).unwrap();
        f.conn.execute("UPDATE shots SET keyframe_path = ?1 WHERE id = ?2", (txt.to_string_lossy(), ids[1])).unwrap();
        f.conn.execute("UPDATE shots SET keyframe_path = '/nowhere/x.jpg' WHERE id = ?1", [ids[2]]).unwrap();
        let (conn, _) = f.read();
        assert_eq!(keyframes(&conn, &ids).unwrap(), [(ids[0], jpg.to_string_lossy().into_owned())]);
    }

    #[test]
    fn a_shot_names_its_clip_file_and_only_a_real_keyframe() {
        let f = Fixture::new("shotfile");
        f.root("Archive", "/Volumes/Archive");
        let clip = f.clip("/Volumes/Archive/a.mov", 2);
        let ids: Vec<i64> = {
            let mut stmt = f.conn.prepare("SELECT id FROM shots WHERE clip_id = ?1 ORDER BY id").unwrap();
            stmt.query_map([clip], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        let jpg = f.dir.join("k.jpg");
        fs::write(&jpg, b"jpg").unwrap();
        f.conn.execute("UPDATE shots SET keyframe_path = ?1 WHERE id = ?2", (jpg.to_string_lossy(), ids[0])).unwrap();
        f.conn.execute("UPDATE shots SET keyframe_path = '/nowhere/x.jpg' WHERE id = ?1", [ids[1]]).unwrap();
        let (conn, _) = f.read();
        assert_eq!(shot_file(&conn, ids[0]).unwrap(), Some(("/Volumes/Archive/a.mov".into(), Some(jpg.to_string_lossy().into_owned()))));
        assert_eq!(shot_file(&conn, ids[1]).unwrap(), Some(("/Volumes/Archive/a.mov".into(), None)));
        assert_eq!(shot_file(&conn, 999_999).unwrap(), None);
    }

    #[test]
    fn the_index_cannot_be_written_through_this_connection() {
        let f = Fixture::new("readonly");
        f.root("Archive", "/Volumes/Archive");
        let (conn, _) = f.read();
        assert!(conn.execute("INSERT INTO watched_roots(label, path) VALUES ('x', '/x')", []).is_err());
        assert!(conn.execute("DELETE FROM clips", []).is_err());
    }

    #[test]
    fn something_else_is_not_taken_for_an_index() {
        let f = Fixture::new("notindex");
        let other = f.dir.join("other.sqlite");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE notes (id INTEGER)").unwrap();
        assert!(open_readonly(&other).unwrap_err().contains("does not look like a Spyglass index"));
        assert!(open_readonly(&f.dir.join("missing.sqlite")).unwrap_err().contains("not found"));
    }

    #[test]
    fn a_long_transcript_is_trimmed() {
        let segments = vec![(0.0, 10.0, "word ".repeat(200))];
        let text = transcript_under(&segments, 1.0, 2.0).unwrap();
        assert_eq!(text.chars().count(), TRANSCRIPT_CHARS + 1);
        assert!(text.ends_with('…'));
        assert_eq!(transcript_under(&segments, 20.0, 30.0), None);
    }
}

/// A timing check against the real index named by `VIBECUT_SPYGLASS_INDEX` (read only):
/// `cargo test --lib real_index -- --ignored --nocapture`.
#[cfg(test)]
mod real_index {
    use super::*;

    #[test]
    #[ignore]
    fn reads_the_real_index() {
        let Ok(path) = std::env::var("VIBECUT_SPYGLASS_INDEX") else { return };
        let started = std::time::Instant::now();
        let conn = open_readonly(Path::new(&path)).unwrap();
        let archive = Archive::load(&conn).unwrap();
        println!("load: {:?}", started.elapsed());
        let t = std::time::Instant::now();
        let roots = archive.children(None);
        println!("roots: {:?}", t.elapsed());
        for root in &roots {
            println!("{} {} shots={} online={} tags={:?} {:?}", root.name, root.path, root.shot_count, root.online, root.top_tags, root.date_range);
        }
        let t = std::time::Instant::now();
        let kids = archive.children(Some(&roots[0].path));
        println!("children of {}: {} in {:?}", roots[0].name, kids.len(), t.elapsed());
        for k in kids.iter().take(8) {
            println!("  {} shots={} children={}", k.name, k.shot_count, k.has_children);
        }
        let t = std::time::Instant::now();
        let scope = archive.resolve(&[kids[0].path.clone()]).unwrap();
        let page = archive.browse(&conn, &scope, 0, 60).unwrap();
        println!("browse {}: {} shots in {:?}; first: {:?}", kids[0].name, page.len(), t.elapsed(), page.first());
    }
}
