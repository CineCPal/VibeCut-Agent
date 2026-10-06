"""
result_cache.py
On-disk cache of per-clip analysis results, so re-running the app on
the same folder -- or just tweaking segment length, segments-per-clip,
or energy weight -- doesn't require re-decoding every video from
scratch.

Cache file: "<analyzed folder>/.broll_analyzer_cache.json" -- lives
inside the folder you point the app at, one cache file per folder.
It's read and written only within that folder; nothing is uploaded,
sent over a network, or shared anywhere else.

What's cached is the expensive, settings-independent part of analysis:
per-frame technical samples (sharpness, exposure, motion) and, if
computed, the local CLIP "energy" score. The composite score, best
segment(s), and overall score are cheap to recompute from those
samples for any combination of window length / segments-per-clip /
energy weight (see analyzer.rescore_clip), so changing those settings
doesn't invalidate the cache or require touching the source file
again.

Content-aware scoring (vision_energy.py) also produces one SigLIP 2
embedding per sample. Those live in a separate binary sidecar,
"<analyzed folder>/.broll_analyzer_embeddings.npz" (float16), not the
JSON: inline base64 would add ~250 KB per minute of footage to a file
that's re-read and re-written on every run. Changing the brief or
weights then only rescores from these -- no re-decode. The JSON keeps a
per-entry "embed_model" so a future model change invalidates exactly the
entries it affects.

Cache entries are keyed by each file's path (relative to the analyzed
folder, so the cache stays valid if the whole folder is moved/copied
elsewhere) plus its size and modification time, so an edited,
replaced, or re-encoded file is automatically treated as new and
re-analyzed rather than served a stale result.
"""

import base64
import json
import os
from dataclasses import asdict

import numpy as np

from vibecut_agent.broll.analyzer import ClipResult, FrameSample

CACHE_FILENAME = ".broll_analyzer_cache.json"
EMBEDDINGS_FILENAME = ".broll_analyzer_embeddings.npz"
CACHE_VERSION = 1
# Bumped only if the .npz layout itself changes (not for a model change --
# that's tracked per entry via "embed_model").
EMBEDDINGS_VERSION = 1
# Mirrors vision_energy.LEGACY_EMBED_MODEL_ID without importing it (that
# module is optional-dependency-adjacent; this one must import cleanly
# with numpy alone). Entries with energy data but no "embed_model" field
# were produced by the old CLIP model.
LEGACY_EMBED_MODEL_ID = "ViT-B-32/openai"


def cache_path_for_folder(folder: str) -> str:
    return os.path.join(folder, CACHE_FILENAME)


def load_cache(folder: str) -> dict[str, dict]:
    """Best-effort load: any problem reading/parsing the cache file
    (missing, corrupt, wrong version, permissions) just means an empty
    cache -- every clip gets freshly analyzed, exactly as if caching
    didn't exist. Caching is purely a speed optimization and should
    never be a reason the app fails to run."""
    path = cache_path_for_folder(folder)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
            return {}
        clips = data.get("clips", {})
        return clips if isinstance(clips, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return {}


def save_cache(folder: str, entries: dict[str, dict]) -> None:
    """Best-effort save via a temp file + atomic replace, so a crash or
    concurrent run can't leave a half-written, corrupt cache file
    behind. Any failure (read-only folder, disk full, permissions) is
    swallowed -- losing the cache just means slower re-analysis next
    time, not a broken app."""
    path = cache_path_for_folder(folder)
    tmp_path = path + ".tmp"
    payload = {"version": CACHE_VERSION, "clips": entries}
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp_path, path)  # atomic on POSIX and Windows
    except OSError:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass


def embeddings_path_for_folder(folder: str) -> str:
    return os.path.join(folder, EMBEDDINGS_FILENAME)


def load_embeddings(folder: str) -> dict[str, np.ndarray]:
    """{relative path: (N, D) float16 array}. Best-effort like
    load_cache: any problem just means no embeddings, so content-aware
    runs re-decode those clips. Stored as one concatenated array plus
    offsets (not one npz member per clip) so loading never needs
    allow_pickle and relative paths with "/" are just data."""
    path = embeddings_path_for_folder(folder)
    try:
        with np.load(path, allow_pickle=False) as data:
            if int(data["version"]) != EMBEDDINGS_VERSION:
                return {}
            keys = [str(k) for k in data["paths"]]
            offsets = data["offsets"]
            matrix = data["data"]
        if len(offsets) != len(keys) + 1 or int(offsets[-1]) != matrix.shape[0]:
            return {}
        return {k: matrix[int(offsets[i]) : int(offsets[i + 1])] for i, k in enumerate(keys)}
    except (FileNotFoundError, OSError, ValueError, KeyError, IndexError):
        return {}


def save_embeddings(folder: str, mapping: dict[str, np.ndarray]) -> None:
    """Best-effort atomic save (temp file + os.replace), same contract as
    save_cache. An empty mapping removes any stale sidecar file rather
    than writing an empty one."""
    path = embeddings_path_for_folder(folder)
    items = [
        (k, np.asarray(v, dtype=np.float16))
        for k, v in sorted(mapping.items())
        if v is not None and getattr(v, "ndim", 0) == 2 and v.shape[0] > 0
    ]
    if not items:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
        return
    dim = items[0][1].shape[1]
    items = [(k, v) for k, v in items if v.shape[1] == dim]
    offsets = np.zeros(len(items) + 1, dtype=np.int64)
    for i, (_, v) in enumerate(items):
        offsets[i + 1] = offsets[i] + v.shape[0]
    # np.savez appends ".npz" to names without it, so keep the suffix on
    # the temp file too.
    tmp_path = path + ".tmp.npz"
    try:
        with open(tmp_path, "wb") as f:
            np.savez(
                f,
                version=np.array(EMBEDDINGS_VERSION),
                paths=np.array([k for k, _ in items], dtype=str),
                offsets=offsets,
                data=np.concatenate([v for _, v in items]),
            )
        os.replace(tmp_path, path)
    except OSError:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass


def attach_embeddings(result: ClipResult, embeddings: np.ndarray | None) -> bool:
    """Put cached embeddings back on a ClipResult restored from the JSON
    cache, if they line up one-to-one with its samples. Returns whether
    they were attached."""
    if (
        embeddings is not None
        and getattr(embeddings, "ndim", 0) == 2
        and embeddings.shape[0] == len(result.samples)
        and embeddings.shape[0] > 0
    ):
        result.embeddings = embeddings
        return True
    result.embeddings = None
    return False


def file_fingerprint(path: str) -> tuple[int, float] | None:
    """(size, mtime) used to detect whether a file has changed since
    it was cached. Returns None if the file can't be stat'd (e.g. it
    disappeared between listing the folder and analyzing it)."""
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime
    except OSError:
        return None


def entry_from_result(result: ClipResult, fingerprint: tuple[int, float]) -> dict:
    """Serialize a successfully-analyzed ClipResult into a cache entry.
    Only the settings-independent fields are stored -- overall_score,
    segments, and best_window_* are recomputed fresh from `samples` on
    load (see analyzer.rescore_clip) rather than cached, since they
    depend on window/segment/energy-weight settings that may differ
    next run."""
    size, mtime = fingerprint
    return {
        "size": size,
        "mtime": mtime,
        "filename": result.filename,
        "duration": result.duration,
        "fps": result.fps,
        "width": result.width,
        "height": result.height,
        "energy_enabled": result.energy_enabled,
        "energy_error": result.energy_error,
        # Model behind the energy values (and the sidecar embeddings, if
        # any). None when energy wasn't computed.
        "embed_model": result.embed_model if result.energy_enabled else None,
        "audio_channels": result.audio_channels,
        "audio_samplerate": result.audio_samplerate,
        "audio_bit_depth": result.audio_bit_depth,
        "audio_channel_layout": result.audio_channel_layout,
        "audio_format_probed": result.audio_format_probed,
        "audio_error": result.audio_error,
        "tc_start": result.tc_start,
        "reel": result.reel,
        "samples": [asdict(s) for s in result.samples],
        # Stored as base64 since JSON has no binary type. Purely a
        # cosmetic preview frame -- local-only, never uploaded, never
        # written into the exported XML.
        "thumbnail_jpeg_b64": (
            base64.b64encode(result.thumbnail_jpeg).decode("ascii") if result.thumbnail_jpeg else None
        ),
        "thumbnail_time": result.thumbnail_time,
    }


def result_from_entry(path: str, entry: dict) -> ClipResult:
    """Reconstruct a ClipResult from a cache entry. The caller is
    expected to call analyzer.rescore_clip() on the result afterward to
    populate overall_score/segments/best_window_* for the current
    settings -- this function only restores the raw sampled data."""
    samples = [FrameSample(**s) for s in entry.get("samples", [])]
    thumb_b64 = entry.get("thumbnail_jpeg_b64")
    thumbnail_jpeg = None
    if thumb_b64:
        try:
            thumbnail_jpeg = base64.b64decode(thumb_b64)
        except (ValueError, TypeError):
            thumbnail_jpeg = None
    audio_channels = entry.get("audio_channels", 2)
    audio_channel_layout = entry.get("audio_channel_layout", "Stereo")
    audio_error = entry.get("audio_error")
    if audio_error == "No audio stream found in file" and audio_channels != 0:
        # Self-heal cache entries written before analyzer._probe_audio_format
        # started clearing these fields for a genuinely audio-less source --
        # older entries left the stereo default in place alongside this
        # error, which made xml_export.py fabricate phantom audio media/
        # clipitems for a file that has none. Corrected read-side, like the
        # mtime-tolerance handling above, so existing cache files don't need
        # a full re-decode to pick up the fix.
        audio_channels = 0
        audio_channel_layout = "None"
    return ClipResult(
        path=path,
        filename=entry.get("filename", os.path.basename(path)),
        duration=entry.get("duration", 0.0),
        fps=entry.get("fps", 0.0),
        width=entry.get("width", 0),
        height=entry.get("height", 0),
        samples=samples,
        energy_enabled=entry.get("energy_enabled", False),
        energy_error=entry.get("energy_error"),
        embed_model=entry_embed_model(entry),
        audio_channels=audio_channels,
        audio_samplerate=entry.get("audio_samplerate", 48000),
        audio_bit_depth=entry.get("audio_bit_depth", 16),
        audio_channel_layout=audio_channel_layout,
        audio_format_probed=entry.get("audio_format_probed", False),
        audio_error=entry.get("audio_error"),
        tc_start=entry.get("tc_start"),
        reel=entry.get("reel"),
        thumbnail_jpeg=thumbnail_jpeg,
        thumbnail_time=entry.get("thumbnail_time"),
    )


def restore_cached_result(
    path: str,
    entry: dict | None,
    fingerprint: tuple[int, float] | None,
    embeddings: np.ndarray | None,
    need_energy: bool,
    embed_model: str | None = None,
) -> ClipResult | None:
    """The one cache-hit path both the standalone app and the suite's
    worker use: check usability (including, for a content-aware run, the
    model and the sidecar embeddings), rebuild the ClipResult, and put
    its embeddings back. Returns None on a miss. The caller still calls
    analyzer.rescore_clip for the current settings."""
    has_embeddings = None
    if need_energy and entry is not None:
        has_embeddings = (
            embeddings is not None
            and getattr(embeddings, "ndim", 0) == 2
            and embeddings.shape[0] == len(entry.get("samples") or [])
            and embeddings.shape[0] > 0
        )
    if not is_entry_usable(
        entry,
        fingerprint,
        need_energy=need_energy,
        embed_model=embed_model if need_energy else None,
        has_embeddings=has_embeddings,
    ):
        return None
    assert entry is not None  # is_entry_usable is False for a missing entry
    result = result_from_entry(path, entry)
    attach_embeddings(result, embeddings)
    return result


def update_thumbnail(
    folder: str,
    rel_path: str,
    thumbnail_jpeg: bytes | None,
    thumbnail_time: float | None,
) -> None:
    """Patch just one cache entry's thumbnail fields in place, leaving
    everything else already cached for that folder untouched.

    Used to persist a UI-triggered on-demand thumbnail refresh (see
    analyzer.refresh_thumbnail) back to disk immediately, rather than
    only ever being written by the next full Analyze run's batch
    save_cache() call. Without this, selecting a row to get an
    up-to-date preview only updated the in-memory ClipResult -- closing
    and reopening the app (or just clicking Analyze again) would reload
    the older, stale thumbnail from disk and silently discard the
    refresh, forcing the same file to be reseeked again next time.

    Best-effort like the rest of this module: if the folder's cache no
    longer exists, or this particular entry isn't in it (e.g. the file
    was removed from the cache between the refresh starting and
    finishing), this simply does nothing -- the refresh stays
    in-memory-only for the rest of this session, exactly as before this
    function existed, rather than raising or recreating a bogus entry."""
    entries = load_cache(folder)
    entry = entries.get(rel_path)
    if entry is None:
        return
    entry["thumbnail_jpeg_b64"] = base64.b64encode(thumbnail_jpeg).decode("ascii") if thumbnail_jpeg else None
    entry["thumbnail_time"] = thumbnail_time
    save_cache(folder, entries)


def entry_embed_model(entry: dict) -> str | None:
    """The model behind an entry's energy values: its stored
    "embed_model", or the legacy CLIP model for entries written before
    that field existed. None if the entry has no energy data."""
    if not entry.get("energy_enabled"):
        return None
    return entry.get("embed_model") or LEGACY_EMBED_MODEL_ID


def is_entry_usable(
    entry: dict | None,
    fingerprint: tuple[int, float] | None,
    need_energy: bool,
    embed_model: str | None = None,
    has_embeddings: bool | None = None,
) -> bool:
    """Whether a cache entry can be reused as-is: the file must be
    unchanged (matching size/mtime), and if energy scoring is being
    requested now, the cached samples must already include it (energy
    scoring can't be added to a cache entry that was computed without
    it without re-decoding, since it requires the actual frame
    pixels).

    With need_energy, two optional stricter checks for content-aware
    runs: `embed_model` (the current vision_energy.EMBED_MODEL_ID) must
    match the model the entry's energy came from -- old CLIP-era energy
    values are on a different scale and can't be mixed with SigLIP 2
    ones -- and `has_embeddings=False` (the caller found no aligned
    sidecar embeddings for this entry) is a miss, since brief relevance
    needs them. Both are ignored when need_energy is False."""
    if entry is None or fingerprint is None:
        return False
    size, mtime = fingerprint
    if entry.get("size") != size:
        return False
    # mtime is stored as the raw float st.st_mtime, and floats that have
    # round-tripped through JSON -- or come off filesystems/OSes that
    # quantize timestamps slightly differently between stat calls -- can
    # differ in the last few bits without the file having changed at all.
    # An exact `!=` here turned those phantom differences into full
    # re-decodes, so compare with a tiny absolute tolerance instead.
    # 1e-6 s is far below any real filesystem timestamp granularity, so a
    # genuinely modified file still always misses. Deliberately a
    # read-side-only change: the stored JSON format is untouched, because
    # this cache file is shared with older copies of the app and a format
    # change would invalidate every existing cache.
    cached_mtime = entry.get("mtime")
    if not isinstance(cached_mtime, (int, float)) or abs(cached_mtime - mtime) > 1e-6:
        return False
    if need_energy and not entry.get("energy_enabled"):
        return False
    if need_energy and embed_model is not None:
        if entry_embed_model(entry) != embed_model:
            return False
    return not (need_energy and has_embeddings is False)
