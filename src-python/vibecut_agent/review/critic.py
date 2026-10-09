"""The ``critique`` sidecar command (PLAN.md, "Phase 14b"), ported from VibeCut's rough-cut-studio
``gemini_critic.py`` and its headless ``run_critique``.

The edit critic: one multimodal call that looks at stills from the connected timeline (the frames either
side of each cut, plus a middle frame of longer shots) together with what is said there and what the
editor was asked to do, and returns what a picture editor would flag: pacing, continuity, framing,
B-roll that doesn't fit the line, story.

It is deliberately a separate, fresh-context call rather than a question put to the chat agent itself:
an agent asked to review its own conversation tends to defend the choices it just made. The chat agent
only ever sees this call's structured findings (the app's `review_edit` tool).

What differs from VibeCut's:
- Any of the chat's three providers (Gemini, the Claude API, or Claude Code on the subscription), through
  story/models.py's general calls, which take the parts with their images.
- Frames are read with media/frames.py's ``grab`` (the local ffmpeg), sent inline, never written to disk.
- There are no editor-rendered stills, so the rubric's sentence about them is left out.

request: {
    "provider": "gemini" | "claude" | "claude-code" (optional, "gemini"; the chat's), "model": str (optional),
    "apiKey": str (injected by Rust; not for "claude-code"), "claudeCode": {...} (injected by Rust),
    "frames": [{"path": a media file, "sourceTime": seconds in it, "time": timeline seconds, "label": str}]
              (1..MAX_FRAMES, timeline order),
    "brief", "snapshot", "transcript": str (optional),
    "lint": [...] (the automatic check's findings, passed through as context)
}
result: {"overall": str, "findings": [{"time", "severity", "category", "issue", "suggestedFix"}],
         "framesSent": int, "framesFailed": int}
"""

from __future__ import annotations

import base64
import io
import json
import math
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TextIO

from vibecut_agent.agent.chat import provider_of
from vibecut_agent.agent.redact import register_secret, scrub
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request, require_absolute_paths

MAX_FRAMES = 32
FRAME_WIDTH = 384
EXTRACT_WORKERS = 4
MAX_FINDINGS = 20
MAX_TEXT = 20_000
MAX_LINT = 60
CLAUDE_MAX_TOKENS = 8000
WHO = {"gemini": "Gemini", "claude": "Claude", "claude-code": "Claude (subscription)"}

SEVERITIES = ("high", "medium", "low")
CATEGORIES = ("pacing", "continuity", "framing", "broll_relevance", "audio", "story", "other")

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "overall": {"type": "STRING", "description": "Two or three sentences: how well the cut works and the most important thing to fix."},
        "findings": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "time": {"type": "NUMBER", "description": "Timeline seconds the finding is about (usually a cut)."},
                    "severity": {"type": "STRING", "enum": list(SEVERITIES)},
                    "category": {"type": "STRING", "enum": list(CATEGORIES)},
                    "issue": {"type": "STRING"},
                    "suggestedFix": {"type": "STRING"},
                },
                "required": ["time", "severity", "category", "issue", "suggestedFix"],
            },
        },
    },
    "required": ["overall", "findings"],
}

SYSTEM_INSTRUCTION = """You are a senior picture editor reviewing a rough cut made by an assistant
editor. You are shown stills from the cut in timeline order, each labelled with its timeline time and
its place (the last frame before a cut, the first frame after it, or the middle of a shot), what is
said around each cut, the editor's brief, the timeline layout, and a list of mechanical problems an
automatic check already found.

Judge what only a person looking at the pictures can judge:
- continuity and jarring cuts (jump cuts on the same framing, eyeline or screen-direction breaks,
  a cut between two near-identical shots),
- framing and quality (out of focus, badly exposed, the subject cut off, a shaky or unusable shot),
- B-roll that doesn't match what is being said over it,
- pacing and story (a slow opening, a shot held too long or too short, a weak ending, the brief not met).

Rules:
- Only report problems you can support from the stills, the words or the layout. Say "the frame at
  12.4s" rather than guessing about footage you were not shown.
- The stills are raw frames from the source files: fades, dissolves, grades and volume are not
  applied to them, so don't report a frame as "too dark" because a fade would make it so.
- Don't repeat the automatic check's findings unless you have something to add about them.
- Every suggestedFix must be a concrete edit (trim, move, replace the shot, cut the line, add a
  dissolve), not general advice.
- Report at most 12 findings, the most important first. An empty list is the right answer for a
  cut with nothing worth changing."""

Grab = Callable[[str, float, int], bytes]


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value) or math.isinf(value):
        raise RequestError(f"{field} must be a number")
    return float(value)


def parse_frames(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise RequestError("frames must be a non-empty list")
    if len(raw) > MAX_FRAMES:
        raise RequestError(f"At most {MAX_FRAMES} frames can be reviewed at once")
    frames = []
    for i, frame in enumerate(raw):
        if not isinstance(frame, dict):
            raise RequestError(f"frames[{i}] must be an object")
        require_absolute_paths([frame.get("path")], "media file")
        source = _number(frame.get("sourceTime"), f"frames[{i}].sourceTime")
        label = frame.get("label")
        frames.append(
            {
                "path": str(frame["path"]),
                "sourceTime": max(0.0, source),
                "time": _number(frame.get("time"), f"frames[{i}].time"),
                "label": str(label)[:80] if label else "frame",
            }
        )
    return frames


def grab_jpeg(path: str, time: float, width: int) -> bytes:
    """One frame as a JPEG, `width` px wide at most (media/frames.py's ffmpeg grab)."""
    from vibecut_agent.media.frames import grab

    image, _past_end = grab(path, time, width)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=80, optimize=True)
    return out.getvalue()


def extract_frames(frames: list[dict[str, Any]], grab: Grab = grab_jpeg) -> tuple[list[tuple[dict[str, Any], bytes]], list[dict[str, Any]]]:
    """Reads each frame's JPEG in parallel. Returns (the frames read with their bytes, in request order;
    the frames that couldn't be read)."""

    def one(frame: dict[str, Any]) -> bytes | None:
        try:
            return grab(frame["path"], frame["sourceTime"], FRAME_WIDTH)
        except Exception:  # noqa: BLE001 - an unreadable frame is left out; the rest are still reviewed
            return None

    with ThreadPoolExecutor(max_workers=EXTRACT_WORKERS) as pool:
        images = list(pool.map(one, frames))
    ok = [(f, img) for f, img in zip(frames, images) if img]
    failed = [f for f, img in zip(frames, images) if not img]
    return ok, failed


def _frame_caption(frame: dict[str, Any]) -> str:
    label = frame.get("label") or "frame"
    return f"{label} — timeline {float(frame['time']):.2f}s"


def build_parts(
    frames: list[tuple[dict[str, Any], bytes]],
    brief: str,
    snapshot: str,
    transcript: str,
    lint: list[Any],
) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = [
        {"text": f"Editor's brief: {brief.strip() or '(none given — judge the cut on its own merits)'}"},
        {"text": f"Timeline layout:\n{snapshot.strip() or '(not provided)'}"},
        {"text": f"What is said (timeline seconds):\n{transcript.strip() or '(no transcript)'}"},
        {"text": f"Automatic check findings:\n{json.dumps(lint, ensure_ascii=False) if lint else '(none)'}"},
        {"text": f"Stills from the cut, in timeline order ({len(frames)}):"},
    ]
    for frame, jpeg in frames:
        parts.append({"text": _frame_caption(frame)})
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpeg).decode("ascii")}})
    parts.append({"text": "Review the cut now."})
    return parts


class CriticError(Exception):
    """The critique could not be completed."""


def findings_from(answer: Any) -> dict[str, Any]:
    """The model's answer, keeping only well-formed findings (a model's output is untrusted, as
    everywhere else in this sidecar). VibeCut's ``findings_from_text``, over the parsed object."""
    if not isinstance(answer, dict):
        raise CriticError("The review was not a JSON object.")
    findings = []
    for raw in answer.get("findings") or []:
        if not isinstance(raw, dict):
            continue
        time = raw.get("time")
        issue = raw.get("issue")
        if not isinstance(time, (int, float)) or isinstance(time, bool) or not isinstance(issue, str) or not issue.strip():
            continue
        severity = raw.get("severity") if raw.get("severity") in SEVERITIES else "medium"
        category = raw.get("category") if raw.get("category") in CATEGORIES else "other"
        fix = raw.get("suggestedFix")
        findings.append(
            {
                "time": round(max(0.0, float(time)), 2),
                "severity": severity,
                "category": category,
                "issue": issue.strip(),
                "suggestedFix": fix.strip() if isinstance(fix, str) else "",
            }
        )
    overall = answer.get("overall")
    return {"overall": overall.strip() if isinstance(overall, str) else "", "findings": findings[:MAX_FINDINGS]}


def findings_from_text(text: str) -> dict[str, Any]:
    try:
        answer = json.loads(text)
    except json.JSONDecodeError as e:
        raise CriticError("The review was not valid JSON.") from e
    return findings_from(answer)


def _text(request: dict[str, Any], key: str) -> str:
    value = request.get(key) or ""
    if not isinstance(value, str):
        raise RequestError(f"{key} must be a string")
    return value[:MAX_TEXT]


def run(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag | None = None, grab: Grab = grab_jpeg) -> int:
    from vibecut_agent.story.models import StoryModelError, claude_code_json_answer, claude_json, gemini_json

    register_secret(request.get("apiKey"))
    provider = provider_of(request)
    api_key = (request.get("apiKey") or "").strip()
    if provider == "claude-code":
        if not isinstance(request.get("claudeCode"), dict):
            raise RequestError("Claude Code isn't set up. See Settings → Claude subscription.")
    elif not api_key:
        raise RequestError(f"No {WHO[provider]} API key was provided.")
    frames = parse_frames(request.get("frames"))
    lint = request.get("lint") or []
    if not isinstance(lint, list):
        raise RequestError("lint must be a list")
    brief, snapshot, transcript = _text(request, "brief"), _text(request, "snapshot"), _text(request, "transcript")
    model = request.get("model") or None
    should_abort = cancel.is_set if cancel else (lambda: False)

    emitter.progress(0, len(frames), phase="stills", detail=f"Reading {len(frames)} still(s)")
    ok, failed = extract_frames(frames, grab)
    if not ok:
        emitter.error("None of the stills could be read (are the media files there?)")
        return 1
    parts = build_parts(ok, brief, snapshot, transcript, lint[:MAX_LINT])
    emitter.progress(len(frames), len(frames), phase="reviewing", detail=f"{WHO[provider]} is reviewing the cut")
    try:
        if provider == "claude-code":
            answer = claude_code_json_answer(
                request.get("claudeCode"), SYSTEM_INSTRUCTION, parts, RESPONSE_SCHEMA, model, effort="medium", should_abort=should_abort
            )
        elif provider == "claude":
            answer = claude_json(
                api_key, SYSTEM_INSTRUCTION, parts, RESPONSE_SCHEMA, model, should_abort=should_abort, effort="medium",
                max_tokens=CLAUDE_MAX_TOKENS,
            )
        else:
            answer = gemini_json(api_key, SYSTEM_INSTRUCTION, parts, RESPONSE_SCHEMA, model, temperature=0.3)
        review = findings_from(answer)
    except (StoryModelError, CriticError) as e:
        emitter.error(scrub(e, api_key))
        return 1
    emitter.emit("result", **review, framesSent=len(ok), framesFailed=len(failed))
    return 0


def main(stdin: TextIO, emitter: Emitter) -> int:
    cancel = CancelFlag()
    cancel.install_sigterm_handler()
    emitter.emit("starting", tool="critique", command="critique")
    try:
        code = run(read_request(stdin), emitter, cancel)
    except RequestError as exc:
        emitter.error(scrub(exc))
        code = 2
    emitter.emit("done", cancelled=cancel.is_set())
    return code
