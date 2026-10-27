"""The media-titles command (vibecut_agent/media/titles.py, Phase 18d), on real Pillow and ffmpeg output."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import titles
from vibecut_agent.protocol import Emitter, RequestError

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture(autouse=True)
def renders(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    return tmp_path / "renders"


def run(request: dict) -> tuple[int, dict]:
    out = io.StringIO()
    code = titles.run(request, Emitter(out))
    return code, next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)


def probe(path: str) -> dict:
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,profile,pix_fmt,width,height,r_frame_rate:format=duration", "-of", "json", path],
        capture_output=True, check=True,
    )  # fmt: skip
    data = json.loads(done.stdout)
    return {**data["streams"][0], "duration": float(data["format"]["duration"])}


def alpha_at(path: str, seconds: float) -> list[int]:
    """The alpha of every pixel of one frame, at a tenth of the size."""
    done = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(seconds), "-i", path, "-frames:v", "1", "-vf",
         "scale=iw/10:ih/10,format=rgba,alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    )  # fmt: skip
    return list(done.stdout)


def test_the_command_is_registered():
    assert "media-titles" in COMMANDS


@needs_ffmpeg
def test_renders_prores_4444_with_alpha_faded_in_and_reuses_it(renders: Path):
    request = {
        "titles": [{"name": "Ana Lima", "title": "Director"}, {"name": "Ben Cho"}],
        "width": 1920, "height": 1080, "fps": 25, "seconds": 3, "project": "Doc",
    }  # fmt: skip
    code, result = run(request)
    assert code == 0
    assert Path(result["folder"]) == renders / "Doc" / "Lower thirds"
    ana, ben = result["files"]
    assert (ana["name"], ana["title"], ana["reused"]) == ("Ana Lima", "Director", False)
    assert ana["output"].endswith(".mov") and "Ana Lima - Director" in ana["output"]
    assert ben["title"] == "" and Path(ben["output"]).name.startswith("Ben Cho ")
    info = probe(ana["output"])
    assert (info["codec_name"], info["width"], info["height"], info["r_frame_rate"]) == (
        "prores",
        1920,
        1080,
        "25/1",
    )
    assert info["pix_fmt"].startswith("yuva444")
    assert info["duration"] == pytest.approx(3, abs=0.05)
    # Faded in from nothing; in the middle the bar is there, near the bottom left, and the top is clear.
    assert max(alpha_at(ana["output"], 0)) == 0
    middle = alpha_at(ana["output"], 1.5)
    width = 192
    rows = [middle[r * width : (r + 1) * width] for r in range(108)]
    assert max(rows[85][10:40]) > 150
    assert max(max(r) for r in rows[:60]) == 0
    assert not list((renders / "Doc" / "Lower thirds").glob(".*")), "no still or partial file is left"
    # The same again reuses both; another look is a new file.
    _code, again = run(request)
    assert [f["reused"] for f in again["files"]] == [True, True]
    _code, other = run({**request, "look": "clean"})
    assert other["files"][0]["output"] != ana["output"]


def test_a_long_name_is_shrunk_to_the_frame_and_its_title_stays_smaller():
    options = {
        "width": 1080,
        "height": 1920,
        "fps": 25,
        "seconds": 5,
        "fade": 0.3,
        "look": "bar",
        "accent": "#f5a623",
        "position": "left",
    }
    image = titles.draw({"name": "Samantha Reyes-Whitfield de la Cruz Montgomery", "title": "Host"}, options)
    left, _top, right, bottom = image.getchannel("A").getbbox()
    # Inside the title-safe area, and higher than a landscape one (clear of a vertical app's buttons).
    assert left >= 1080 * 0.08 - 1 and right <= 1080 * 0.92 + 1
    assert bottom <= 1920 * 0.78 + 2  # getbbox is exclusive
    name = titles._fitted(
        "Samantha Reyes-Whitfield de la Cruz Montgomery", titles.BOLD_FONTS, 63, 1080 * 0.84 * 0.9
    )
    assert name.size < 63


def test_bad_requests_are_refused():
    with pytest.raises(RequestError, match="1 to 20"):
        titles.parse_request({"titles": []})
    with pytest.raises(RequestError, match=r"titles\[0\].name"):
        titles.parse_request({"titles": [{"title": "Director"}]})
    with pytest.raises(RequestError, match="accent"):
        titles.parse_request({"titles": [{"name": "Ana"}], "accent": "orange"})
    with pytest.raises(RequestError, match="seconds"):
        titles.parse_request({"titles": [{"name": "Ana"}], "seconds": 60})
    with pytest.raises(RequestError, match="over 80"):
        titles.parse_request({"titles": [{"name": "A" * 81}]})
    specs, options = titles.parse_request({"titles": [{"name": "  Ana \n Lima "}], "seconds": 1, "fade": 2})
    assert specs == [{"name": "Ana Lima", "title": ""}]
    assert options["fade"] == pytest.approx(1 / 3), "a fade never takes more than a third of it"
