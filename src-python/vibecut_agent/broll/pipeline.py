"""pipeline.py — the GUI-free analysis run shared by the Tk app (app.py) and the sidecar (headless.py).

Everything here was moved out of `BRollAnalyzerApp._run_analysis` and its helpers: a cache pass,
then a parallel pass over a ProcessPoolExecutor, then a fresh cache save. Content-aware runs
(`enable_energy`) also restore and save the SigLIP 2 per-frame embeddings
(.broll_analyzer_embeddings.npz, see result_cache.py), score clips against an optional brief, and
can mark near-duplicate takes -- ported from the suite's app.py / broll_worker.py.
The Tk-specific `self.after(...)` calls became the `on_status` / `on_progress` callbacks, which are
invoked on the calling thread. Importing this module never imports tkinter.

Cancellation stays cooperative (see CLAUDE.md): the loop polls `cancel_event` from the thread that
owns the executor. Never call `executor.shutdown` from another thread.
"""

from __future__ import annotations

import concurrent.futures
import os
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from vibecut_agent.broll import (
    result_cache,
    vision_energy,  # torch itself is only imported lazily
)
from vibecut_agent.broll.analyzer import (
    ClipResult,
    analyze_clip,
    limit_opencv_threads,
    mark_near_duplicates,
    rescore_clip,
)

DEFAULT_WINDOW_SEC = 4.0
DEFAULT_MAX_SEGMENTS = 1
DEFAULT_MIN_GAP_SEC = 1.0
DEFAULT_ENERGY_WEIGHT = 0.35
DEFAULT_RELEVANCE_WEIGHT = 0.35
# Briefs come from a free-text field; bound them so a pasted essay can't
# bloat the tokenizer call (SigLIP 2's context is 64 tokens anyway).
MAX_BRIEF_CHARS = 200
# Each content-aware worker process loads its own SigLIP 2 (~1.5 GB in
# fp32), so the default pool is capped when it is on (the suite's default).
MAX_CONTENT_AWARE_WORKERS = 3


def default_worker_count(enable_energy: bool = False) -> int:
    count = max(1, (os.cpu_count() or 2) - 1)
    return min(count, MAX_CONTENT_AWARE_WORKERS) if enable_energy else count


def content_scoring(brief: str, enable_energy: bool) -> tuple[np.ndarray | None, str | None]:
    """(relevance_targets, brief_error) for this run. The brief is embedded
    ONCE here in the parent process -- never per clip -- and only for a
    content-aware run with a non-empty brief. A failure degrades to no
    brief (energy/technical scoring still run) rather than failing the job."""
    brief = (brief or "").strip()
    if not enable_energy or not brief:
        return None, None
    try:
        return vision_energy.brief_targets(brief[:MAX_BRIEF_CHARS]), None
    except Exception as e:
        return None, str(e)


def analyze_clip_worker(
    path,
    window_sec,
    max_segments,
    enable_energy,
    energy_weight,
    relevance_targets=None,
    relevance_weight=0.0,
    min_segment_gap_sec=DEFAULT_MIN_GAP_SEC,
):
    """Runs in a worker process (see `run_analysis`). Must be a plain module-level
    function -- not a method or a closure -- so it can be pickled and
    sent to the worker. No progress_cb is passed here: per-frame
    progress can't cross a process boundary cheaply, so progress is
    instead reported per-completed-file by the caller.

    If analyze_clip raises outright (rather than recording the problem
    in ClipResult.error itself), catch it here so one bad file can't
    crash the whole batch."""
    try:
        return analyze_clip(
            path,
            progress_cb=None,
            window_sec=window_sec,
            max_segments=max_segments,
            enable_energy=enable_energy,
            energy_weight=energy_weight,
            relevance_targets=relevance_targets,
            relevance_weight=relevance_weight,
            min_segment_gap_sec=min_segment_gap_sec,
        )
    except Exception as e:
        return failed_result(path, e)


def failed_result(path: str, error: Exception) -> ClipResult:
    return ClipResult(
        path=path,
        filename=os.path.basename(path),
        duration=0,
        fps=0,
        width=0,
        height=0,
        error=f"{error}\n{traceback.format_exc(limit=1)}",
    )


def worker_init():
    """Runs once per ProcessPoolExecutor worker process, before it
    analyzes any clips. Each worker here is already its own OS process running in parallel
    with `num_workers` siblings; without this, OpenCV's own internal
    multithreading (Laplacian, optical flow) would ALSO fan out across
    every CPU core inside each of those processes, causing severe
    oversubscription instead of clean parallel scaling."""
    limit_opencv_threads()
    # Same oversubscription story for torch: with content-aware scoring on,
    # each worker loads its own SigLIP 2 model, and torch's intra-op pool
    # defaults to every core. Guarded so the technical-only path (torch is
    # an optional extra) keeps working exactly as before.
    try:
        import torch

        torch.set_num_threads(1)
    except Exception:
        pass


@dataclass
class AnalysisOutcome:
    """Results sorted best first. Clips dropped by a cancel are absent."""

    results: list[ClipResult] = field(default_factory=list)
    cancelled: bool = False
    cache_hits: int = 0
    total: int = 0
    duplicates: int = 0


def run_analysis(
    files: list[str],
    folder: str,
    *,
    window_sec: float,
    max_segments: int,
    enable_energy: bool,
    energy_weight: float,
    max_workers: int,
    cancel_event,
    relevance_targets: np.ndarray | None = None,
    relevance_weight: float = 0.0,
    dedupe: bool = False,
    min_segment_gap_sec: float = DEFAULT_MIN_GAP_SEC,
    on_status: Callable[[str], None] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    executor_factory: Callable[..., concurrent.futures.Executor] | None = None,
) -> AnalysisOutcome:
    """Analyzes `files` (all inside `folder`) and refreshes the folder's cache.

    `relevance_targets` (from `content_scoring`) scores each clip against the editor's brief at
    `relevance_weight`; `dedupe` marks near-duplicate takes (`ClipResult.duplicate_of`). Both need
    `enable_energy`, whose per-frame embeddings they are computed from.

    `on_progress(percent, message)` is called after the cache pass and after each clip; `on_status`
    with plain status lines. `cancel_event` needs `is_set()`. `executor_factory(max_workers=,
    initializer=)` exists for tests; the default is a process pool."""
    on_status = on_status or (lambda _message: None)
    on_progress = on_progress or (lambda _percent, _message: None)
    executor_factory = executor_factory or concurrent.futures.ProcessPoolExecutor

    total = len(files)
    results: list[Any] = [None] * total
    fingerprints: list[Any] = [None] * total
    completed = 0

    # --- Cache pass: reuse any clip whose file hasn't changed and
    # whose cached samples already include content scoring (from the
    # current model, with its embeddings) if that's being requested now.
    # Re-scoring a cache hit for the current window/segment/weight/brief
    # settings is cheap (no decode), so it's done synchronously here
    # rather than farmed out to a worker process.
    cache_entries = result_cache.load_cache(folder)
    # Embeddings only matter (and are only rewritten) on content-aware
    # runs; a technical-only run leaves the sidecar file untouched.
    cached_embeddings = result_cache.load_embeddings(folder) if enable_energy else {}
    to_submit = []
    cache_hits = 0
    for i, path in enumerate(files):
        fp = result_cache.file_fingerprint(path)
        fingerprints[i] = fp
        rel = os.path.relpath(path, folder)
        try:
            result = result_cache.restore_cached_result(
                path,
                cache_entries.get(rel),
                fp,
                cached_embeddings.get(rel),
                need_energy=enable_energy,
                embed_model=vision_energy.EMBED_MODEL_ID,
            )
            if result is not None:
                rescore_clip(
                    result,
                    window_sec=window_sec,
                    max_segments=max_segments,
                    min_segment_gap_sec=min_segment_gap_sec,
                    energy_weight=energy_weight,
                    enable_energy=enable_energy,
                    relevance_targets=relevance_targets,
                    relevance_weight=relevance_weight,
                )
                results[i] = result
                cache_hits += 1
                completed += 1
                continue
        except Exception:
            pass  # any problem reusing the entry -> fall through to re-analysis
        to_submit.append(i)

    if cache_hits:
        on_progress(
            completed / total * 100,
            f"Loaded {cache_hits}/{total} clip(s) from cache...",
        )

    # --- Parallel pass: everything not served from cache.
    if to_submit and not cancel_event.is_set():
        num_workers = max(1, min(int(max_workers), len(to_submit)))
        on_status(f"Analyzing {len(to_submit)} clip(s) with {num_workers} parallel worker(s)...")

        executor = executor_factory(max_workers=num_workers, initializer=worker_init)
        try:
            # Only ever submit up to `num_workers` clips at a time,
            # rather than handing the executor the whole list
            # upfront. This keeps every not-yet-dispatched clip as
            # a plain Python list entry (trivially "cancellable" --
            # it's simply never submitted) instead of a Future
            # already queued inside the executor, which is what
            # lets Cancel drop the remaining queue instantly rather
            # than waiting for everything already handed off.
            submit_queue = list(to_submit)
            pending: dict[Any, int] = {}  # future -> file index

            def submit_next():
                while submit_queue and len(pending) < num_workers:
                    i = submit_queue.pop(0)
                    fut = executor.submit(
                        analyze_clip_worker,
                        files[i],
                        window_sec,
                        max_segments,
                        enable_energy,
                        energy_weight,
                        relevance_targets,
                        relevance_weight,
                        min_segment_gap_sec,
                    )
                    pending[fut] = i

            submit_next()
            while pending:
                # Poll with a short timeout (rather than blocking
                # indefinitely on as_completed) so this loop -- and
                # only this loop, on this thread -- notices a
                # Cancel and reacts to it itself, instead of a different
                # thread reaching into the executor concurrently.
                done, _ = concurrent.futures.wait(
                    pending.keys(),
                    timeout=0.2,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )

                if cancel_event.is_set():
                    submit_queue.clear()
                    for fut in list(pending.keys()):
                        if fut not in done:
                            fut.cancel()  # no-op if already running; fine either way

                for future in done:
                    i = pending.pop(future)
                    path = files[i]
                    try:
                        result = future.result()
                    except concurrent.futures.CancelledError:
                        continue  # dropped before it started; leave as None
                    except Exception as e:
                        # Belt-and-suspenders: analyze_clip_worker
                        # already catches analyze_clip's own
                        # exceptions, but a worker process could
                        # still die/crash outright (e.g. segfault in
                        # a native codec library), which surfaces
                        # here as a BrokenProcessPool-style error.
                        result = failed_result(path, e)
                    results[i] = result
                    completed += 1
                    on_progress(
                        completed / total * 100,
                        f"Analyzed ({completed}/{total}): {os.path.basename(path)}",
                    )

                if not cancel_event.is_set():
                    submit_next()
        finally:
            executor.shutdown(wait=True)

    cancelled = cancel_event.is_set()

    # --- Save a fresh cache for everything that analyzed cleanly
    # (skip errors, so a file that failed this run -- e.g. locked,
    # briefly unreadable -- still gets retried next time instead of
    # being remembered as permanently broken).
    new_entries = {}
    new_embeddings = {}
    for i, r in enumerate(results):
        if r is None or r.error:
            continue
        fp = fingerprints[i]
        if fp is None:
            continue
        rel = os.path.relpath(files[i], folder)
        new_entries[rel] = result_cache.entry_from_result(r, fp)
        if r.embeddings is not None:
            new_embeddings[rel] = r.embeddings
    result_cache.save_cache(folder, new_entries)
    if enable_energy:
        result_cache.save_embeddings(folder, new_embeddings)

    final_results = [r for r in results if r is not None]
    final_results.sort(key=lambda r: r.overall_score, reverse=True)
    # Marked after sorting so the best-scoring take of each group is the one kept.
    if enable_energy and dedupe:
        mark_near_duplicates(final_results)
    else:
        for r in final_results:
            r.duplicate_of = None
    return AnalysisOutcome(
        results=final_results,
        cancelled=cancelled,
        cache_hits=cache_hits,
        total=total,
        duplicates=sum(1 for r in final_results if r.duplicate_of),
    )


def select_results(
    results: list[ClipResult],
    mode: str,
    top_n: int = 10,
    min_score: float = 0.0,
    skip_duplicates: bool = False,
) -> list[ClipResult]:
    """The clips an export keeps: the best `top_n`, those scoring at least `min_score`, or all.
    `skip_duplicates` leaves out takes marked as near-duplicates of a better one."""
    ok_results = [r for r in results if not r.error and not (skip_duplicates and r.duplicate_of)]
    ok_results.sort(key=lambda r: r.overall_score, reverse=True)
    if mode == "topn":
        return ok_results[: max(1, int(top_n))]
    if mode == "threshold":
        return [r for r in ok_results if r.overall_score >= min_score]
    return ok_results


def order_for_sequence(selected: list[ClipResult], order: str) -> list[ClipResult]:
    """Sequence order for the exported timeline: by file name, or best first."""
    if order == "name":
        return sorted(selected, key=lambda r: r.filename.lower())
    return sorted(selected, key=lambda r: r.overall_score, reverse=True)
