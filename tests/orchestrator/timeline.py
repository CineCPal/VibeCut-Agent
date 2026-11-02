"""A timeline snapshot and OTIO delta builders, shared by the delta and validator tests."""

from __future__ import annotations


def rt(value, rate=25.0):
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate}


def tr(start, duration, rate=25.0):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(start, rate), "duration": rt(duration, rate)}


def make_media(tmp_path):
    """Empty files standing in for media (their lengths come from the test's media_duration)."""
    paths = {}
    for name in ("a.mov", "b.mov", "c d.mov", "music.wav"):
        path = tmp_path / name
        path.write_bytes(b"")
        paths[name] = str(path)
    return paths


def make_snapshot(media):
    """Cut, 25 fps: V1 c1 0-4 s (a.mov 10-14), c2 4-8 s (b.mov 0-4); A1 their sound, linked; A2 music 0-20 s."""
    return {
        "project": "P",
        "timeline": "Cut",
        "fps": 25,
        "playhead": 3.2,
        "tracks": [
            {
                "type": "video",
                "index": 1,
                "clips": [
                    {
                        "id": "c1",
                        "start": 0,
                        "end": 4,
                        "sourceIn": 10,
                        "sourceOut": 14,
                        "filePath": media["a.mov"],
                        "linkedIds": ["a1"],
                    },
                    {
                        "id": "c2",
                        "start": 4,
                        "end": 8,
                        "sourceIn": 0,
                        "sourceOut": 4,
                        "filePath": media["b.mov"],
                        "linkedIds": ["a2"],
                    },
                ],
            },
            {
                "type": "audio",
                "index": 1,
                "clips": [
                    {
                        "id": "a1",
                        "start": 0,
                        "end": 4,
                        "sourceIn": 10,
                        "sourceOut": 14,
                        "filePath": media["a.mov"],
                        "linkedIds": ["c1"],
                    },
                    {
                        "id": "a2",
                        "start": 4,
                        "end": 8,
                        "sourceIn": 0,
                        "sourceOut": 4,
                        "filePath": media["b.mov"],
                        "linkedIds": ["c2"],
                    },
                ],
            },
            {
                "type": "audio",
                "index": 2,
                "clips": [
                    {
                        "id": "m1",
                        "start": 0,
                        "end": 20,
                        "sourceIn": 0,
                        "sourceOut": 20,
                        "filePath": media["music.wav"],
                    }
                ],
            },
            {"type": "subtitle", "index": 1, "clips": []},
        ],
    }


def delta(*operations, host="premiere", fps=25.0):
    return {
        "schema_version": "vibecut.otio.delta.v1",
        "delta_id": "delta_0001",
        "target_host": host,
        "target_timeline": "Cut",
        "timeline_fps": fps,
        "narrative_rationale": "test",
        "operations": list(operations),
    }


def op(op_id, op_type, kind="Video", index=1, **fields):
    return {"op_id": op_id, "op_type": op_type, "track_Selector": {"kind": kind, "index": index}, **fields}


def ref(path):
    return {"OTIO_SCHEMA": "ExternalReference.1", "target_url": f"file://{path}", "source_name": "x"}
