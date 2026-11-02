"""Frame-exact time (core/timecode_math.py): rates, snapping, SMPTE (drop-frame and not) and overlaps."""

from fractions import Fraction

import pytest

from vibecut_agent.core.timecode_math import (
    SUPPORTED_RATES,
    exact_rate,
    ranges_overlap,
    rational_time,
    rational_to_fraction,
    rational_to_seconds,
    rational_to_smpte,
    seconds_to_rational,
    smpte_to_rational,
    snap_rate,
    time_range_from_seconds,
)


def test_ntsc_rates_are_exact():
    assert exact_rate(23.976) == Fraction(24000, 1001)
    assert exact_rate(29.97) == Fraction(30000, 1001)
    assert exact_rate(59.94) == Fraction(60000, 1001)
    assert exact_rate(25) == 25
    with pytest.raises(ValueError, match="not a supported rate"):
        exact_rate(48)


@pytest.mark.parametrize(
    ("fps", "rate"),
    [
        (23.976023976, 23.976),
        (24.0, 24.0),
        (29.97002997, 29.97),
        (30.0, 30.0),
        (59.94005994, 59.94),
        (50, 50.0),
    ],
)
def test_snap_rate(fps, rate):
    assert snap_rate(fps) == rate


def test_snap_rate_rejects_other_rates():
    for fps in (12.0, 29.95, 48.0, 120.0):
        with pytest.raises(ValueError):
            snap_rate(fps)


def test_seconds_snap_to_whole_frames():
    assert seconds_to_rational(1.0, 25) == {"OTIO_SCHEMA": "RationalTime.1", "value": 25, "rate": 25.0}
    # An hour at 23.976 is 86313.69 frames.
    assert seconds_to_rational(3600, 23.976)["value"] == 86314
    assert seconds_to_rational(3600, 23.976, "floor")["value"] == 86313
    assert seconds_to_rational(0.02, 25, "ceil")["value"] == 1
    # Halves round up.
    assert seconds_to_rational(Fraction(1, 50), 25)["value"] == 1
    assert seconds_to_rational(Fraction(3, 50), 25)["value"] == 2


def test_no_drift_on_ntsc_round_trips():
    for rate in SUPPORTED_RATES:
        for frame in (0, 1, 1799, 1800, 17982, 107892, 1_000_003):
            time = rational_time(frame, rate)
            assert seconds_to_rational(rational_to_seconds(time), rate) == time
            assert rational_to_fraction(time) * exact_rate(rate) == frame


def test_rational_time_needs_a_whole_frame():
    with pytest.raises(TypeError):
        rational_time(1.5, 25)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        rational_time(True, 25)


@pytest.mark.parametrize(
    ("frame", "rate", "label"),
    [
        (0, 29.97, "00:00:00;00"),
        (1799, 29.97, "00:00:59;29"),
        (1800, 29.97, "00:01:00;02"),
        (3598, 29.97, "00:02:00;02"),
        (17982, 29.97, "00:10:00;00"),
        (17983, 29.97, "00:10:00;01"),
        (107892, 29.97, "01:00:00;00"),
        (3600, 59.94, "00:01:00;04"),
        (215784, 59.94, "01:00:00;00"),
        (86400, 23.976, "01:00:00:00"),
        (90000, 25, "01:00:00:00"),
        (49, 25, "00:00:01:24"),
        (1800, 30, "00:01:00:00"),
    ],
)
def test_smpte_both_ways(frame, rate, label):
    assert rational_to_smpte(rational_time(frame, rate)) == label
    assert smpte_to_rational(label, rate)["value"] == frame


def test_every_drop_frame_label_round_trips():
    for rate in (29.97, 59.94):
        for frame in range(0, 40_000, 7):
            label = rational_to_smpte(rational_time(frame, rate))
            assert smpte_to_rational(label, rate)["value"] == frame


def test_non_drop_at_29_97_counts_in_30s():
    assert rational_to_smpte(rational_time(1800, 29.97), drop_frame=False) == "00:01:00:00"
    assert smpte_to_rational("00:01:00:00", 29.97)["value"] == 1800


def test_bad_timecodes():
    with pytest.raises(ValueError, match="skipped"):
        smpte_to_rational("00:01:00;00", 29.97)
    with pytest.raises(ValueError, match="skipped"):
        smpte_to_rational("00:01:00;03", 59.94)
    with pytest.raises(ValueError, match="only for 29.97"):
        smpte_to_rational("00:00:01;00", 25)
    with pytest.raises(ValueError, match="only for 29.97"):
        rational_to_smpte(rational_time(10, 23.976), drop_frame=True)
    with pytest.raises(ValueError, match="valid"):
        smpte_to_rational("00:00:00:25", 25)
    with pytest.raises(ValueError, match="isn't a timecode"):
        smpte_to_rational("1:2:3", 25)
    with pytest.raises(ValueError, match="negative"):
        rational_to_smpte(rational_time(-1, 25))


def test_time_range_from_seconds_touches_its_neighbour():
    a = time_range_from_seconds(0.0, 1.01, 29.97)
    b = time_range_from_seconds(1.01, 2.5, 29.97)
    assert a["start_time"]["value"] + a["duration"]["value"] == b["start_time"]["value"]
    assert not ranges_overlap(a, b)
    with pytest.raises(ValueError, match="before its start"):
        time_range_from_seconds(2.0, 1.0, 25)


def test_ranges_overlap_across_rates():
    a = time_range_from_seconds(0, 2, 25)
    assert ranges_overlap(a, time_range_from_seconds(1.9, 3, 29.97))
    assert not ranges_overlap(a, time_range_from_seconds(2, 3, 50))
    assert ranges_overlap(a, time_range_from_seconds(0.5, 1, 23.976))
    empty = time_range_from_seconds(1, 1, 25)
    assert not ranges_overlap(a, empty)
    assert not ranges_overlap(empty, empty)
