"""``tensa.core.comtrade``: the record a set of sampled signals is written as.

Every record is read back through ``tests/_comtrade.py``, a reader written from
the standard's layout that shares nothing with the writer, so these check the
files against the format: the lines of the configuration, the integers of the
data file and the conversion that turns them back into the signal.
"""

from __future__ import annotations

import io
import math
import re
import zipfile
from datetime import UTC, datetime, timedelta, timezone

import numpy as np
import pytest

from tensa.core.comtrade import (
    ComtradeChannel,
    ComtradeError,
    ComtradeRecord,
    comtrade_record,
    comtrade_zip,
)
from tests._comtrade import ReadRecord, read_comtrade, read_comtrade_zip

pytestmark = pytest.mark.unit

START = datetime(2026, 10, 5, 14, 3, 22, 123456)


def _write(t: object, channels: list[ComtradeChannel], **options: object) -> ComtradeRecord:
    options.setdefault("start", START)
    return comtrade_record(t, channels, **options)  # type: ignore[arg-type]


def _read(t: object, channels: list[ComtradeChannel], **options: object) -> ReadRecord:
    record = _write(t, channels, **options)
    return read_comtrade(record.cfg, record.dat)


def _swing(seconds: float = 4.0, rate: float = 30.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A rotor speed and a bus voltage after a disturbance, sampled evenly."""
    t = np.arange(int(seconds * rate) + 1) / rate
    omega = 1.0 + 0.004 * np.exp(-0.4 * t) * np.sin(2 * np.pi * 1.1 * t)
    voltage = 1.02 - 0.3 * np.exp(-3.0 * t)
    return t, omega, voltage


# ---- the configuration file --------------------------------------------------------


def test_the_configuration_has_the_lines_of_the_1999_revision() -> None:
    t, omega, voltage = _swing()

    record = _write(
        t,
        [
            ComtradeChannel("omega GENROU 1", omega, "pu"),
            ComtradeChannel("Bus_3_v", voltage, "pu"),
        ],
        station="ieee14",
        device="TENSA 0.4.0",
        frequency_hz=50.0,
    )

    lines = record.cfg.split("\r\n")
    assert lines[0] == "ieee14,TENSA 0.4.0,1999"
    assert lines[1] == "2,2A,0D"
    # An,ch_id,ph,ccbm,uu,a,b,skew,min,max,primary,secondary,PS
    assert lines[2].startswith("1,omega GENROU 1,,,pu,")
    assert lines[2].endswith(",0,-99999,99998,1,1,P")
    # The conversion factors are reals in the standard's notation: a mantissa and
    # an E exponent for the small one, plain digits for the one near 1.
    a, b = lines[2].split(",")[5:7]
    assert re.fullmatch(r"\d\.\d+E-08", a), a
    assert re.fullmatch(r"1\.\d+", b), b
    assert lines[3].startswith("2,Bus_3_v,,,pu,")
    assert lines[4:] == [
        "50",
        "1",
        "30,121",
        "05/10/2026,14:03:22.123456",
        "05/10/2026,14:03:22.123456",
        "ASCII",
        "1",
        "",
    ]
    assert (record.samples, record.channels, record.sample_rate_hz) == (121, 2, 30.0)


def test_a_record_reads_back_as_the_signals_it_was_written_from() -> None:
    t, omega, voltage = _swing()

    read = _read(
        t,
        [ComtradeChannel("omega", omega, "pu"), ComtradeChannel("v", voltage, "pu")],
        station="kundur",
        device="run 3",
    )

    assert (read.station, read.device, read.rev_year) == ("kundur", "run 3", "1999")
    assert [(c.name, c.unit) for c in read.channels] == [("omega", "pu"), ("v", "pu")]
    assert read.frequency == 60.0
    assert read.file_type == "ASCII"
    # Time stamps are whole microseconds from the first sample.
    assert np.abs(read.t - t).max() <= 0.5e-6
    for channel, signal in zip(read.channels, (omega, voltage), strict=True):
        # Half a step of the conversion is the most a stored value is off by.
        assert np.abs(channel.values - signal).max() <= channel.a / 2 * (1 + 1e-9)
        assert (channel.skew, channel.primary, channel.secondary, channel.scaling) == (
            0.0,
            1.0,
            1.0,
            "P",
        )
        assert (channel.minimum, channel.maximum) == (-99999, 99998)
        assert (channel.phase, channel.component) == ("", "")


def test_each_channel_is_spread_over_the_whole_range_of_a_data_file() -> None:
    """What gives a channel its resolution: a signal that moves by a thousandth
    is stored as finely as one that moves by hundreds."""
    t, omega, _ = _swing()
    flow = 250.0 + 180.0 * np.sin(t)

    read = _read(t, [ComtradeChannel("omega", omega), ComtradeChannel("p", flow, "MW")])

    for channel, signal in zip(read.channels, (omega, flow), strict=True):
        assert (channel.stored.min(), channel.stored.max()) == (-99998, 99998)
        assert channel.a == pytest.approx(np.ptp(signal) / (2 * 99998))
        assert channel.b == pytest.approx((signal.max() + signal.min()) / 2)


def test_a_channel_that_never_changes_is_zeros_on_its_value() -> None:
    read = _read([0.0, 0.1, 0.2], [ComtradeChannel("omega", [1.0, 1.0, 1.0], "pu")])

    (channel,) = read.channels
    assert channel.stored.tolist() == [0, 0, 0]
    assert (channel.a, channel.b) == (1.0, 1.0)
    assert channel.values.tolist() == [1.0, 1.0, 1.0]


def test_a_single_sample_makes_a_record() -> None:
    read = _read([2.5], [ComtradeChannel("v", [1.04], "pu")])

    assert read.stamps.tolist() == [0]
    assert (read.nrates, read.rates) == (0, [(0.0, 1)])
    assert read.channels[0].values.tolist() == [1.04]
    # The first sample is at 2.5 s of simulated time.
    assert read.first == START + timedelta(seconds=2.5)


# ---- missing values -----------------------------------------------------------------


def test_a_missing_value_is_stored_as_99999_and_does_not_set_the_scale() -> None:
    values = [1.0, None, 3.0, math.nan, 2.0, math.inf]

    read = _read([0, 1, 2, 3, 4, 5], [ComtradeChannel("v", values)])

    (channel,) = read.channels
    assert channel.stored.tolist() == [-99998, 99999, 99998, 99999, 0, 99999]
    assert channel.values[[0, 2, 4]].tolist() == pytest.approx([1.0, 3.0, 2.0])
    assert np.isnan(channel.values[[1, 3, 5]]).all()


def test_a_channel_with_no_value_at_all_is_all_missing() -> None:
    read = _read([0, 1], [ComtradeChannel("gone", [None, None], "pu")])

    (channel,) = read.channels
    assert channel.stored.tolist() == [99999, 99999]
    assert (channel.a, channel.b) == (1.0, 0.0)


# ---- time ------------------------------------------------------------------------


def test_evenly_spaced_samples_declare_their_rate() -> None:
    t = np.arange(301) / 30

    read = _read(t, [ComtradeChannel("v", np.sin(t))])

    assert (read.nrates, read.rates) == (1, [(30.0, 301)])
    # One thirtieth of a second is not a whole number of microseconds: the stamps
    # are the rounded times, a third of a microsecond off the rate at most.
    assert read.stamps[:4].tolist() == [0, 33333, 66667, 100000]


def test_an_event_that_repeats_its_time_leaves_the_record_without_a_rate() -> None:
    """ANDES records a time twice when an event changes the system at that
    instant. Both samples are kept, and with no rate declared a reader must go by
    the time stamps."""
    t = [0.0, 0.1, 0.2, 0.2, 0.3, 0.4]
    voltage = [1.0, 1.0, 1.0, 0.2, 0.25, 0.3]

    read = _read(t, [ComtradeChannel("v", voltage, "pu")])

    assert (read.nrates, read.rates) == (0, [(0.0, 6)])
    assert read.stamps.tolist() == [0, 100000, 200000, 200000, 300000, 400000]
    assert read.channels[0].values.tolist() == pytest.approx(voltage, abs=1e-5)


def test_steps_of_changing_size_leave_the_record_without_a_rate() -> None:
    t = np.cumsum([0.0, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032])

    read = _read(t, [ComtradeChannel("v", np.cos(t))])

    assert (read.nrates, read.rates) == (0, [(0.0, 7)])
    assert np.abs(read.t - t).max() <= 0.5e-6


def test_one_late_sample_among_even_ones_is_enough_to_drop_the_rate() -> None:
    t = np.arange(100) / 50
    t[60] += 5e-6

    record = _write(t, [ComtradeChannel("v", np.cos(t))])

    assert record.sample_rate_hz is None


def test_samples_closer_than_the_stamps_resolve_declare_no_rate() -> None:
    """Every sample at one instant, and samples a microsecond apart with one
    repeated: neither is a rate, and the second would pass for one if a repeat
    could hide inside the rounding of a stamp."""
    same = _read([1.0, 1.0, 1.0], [ComtradeChannel("v", [1.0, 0.4, 0.5])])
    close = _read([0.0, 1e-6, 1e-6, 3e-6], [ComtradeChannel("v", [1.0, 0.4, 0.5, 0.6])])

    assert (same.nrates, same.rates) == (0, [(0.0, 3)])
    assert same.stamps.tolist() == [0, 0, 0]
    assert (close.nrates, close.rates) == (0, [(0.0, 4)])
    assert close.stamps.tolist() == [0, 1, 1, 3]


def test_the_stamps_count_from_the_first_sample_and_the_date_is_its_time() -> None:
    t = [10.0, 10.5, 11.0]

    read = _read(t, [ComtradeChannel("v", [1.0, 2.0, 3.0])])

    assert read.stamps.tolist() == [0, 500000, 1000000]
    assert read.first == START + timedelta(seconds=10)
    assert read.trigger == read.first
    assert (read.nrates, read.rates) == (1, [(2.0, 3)])


def test_the_trigger_is_the_instant_the_caller_names() -> None:
    read = _read(
        [0.0, 0.5, 1.0, 1.5, 2.0],
        [ComtradeChannel("v", [1, 1, 0.2, 0.9, 1])],
        trigger_t=1.0,
    )

    assert read.first == START
    assert read.trigger == START + timedelta(seconds=1)


def test_the_date_is_the_clock_reading_of_the_start_whatever_its_zone() -> None:
    """The format has nowhere to put a time zone, so none is applied."""
    tokyo = datetime(2026, 3, 1, 9, 30, 0, tzinfo=timezone(timedelta(hours=9)))

    for start in (tokyo, datetime(2026, 3, 1, 9, 30, 0, tzinfo=UTC)):
        record = comtrade_record([0.0, 1.0], [ComtradeChannel("v", [1, 2])], start=start)
        first_date_line = record.cfg.split("\r\n")[-5]
        assert first_date_line == "01/03/2026,09:30:00.000000"


def test_without_a_start_the_record_is_dated_now() -> None:
    before = datetime.now()
    record = comtrade_record([0.0, 1.0], [ComtradeChannel("v", [1, 2])])
    after = datetime.now()

    read = read_comtrade(record.cfg, record.dat)

    assert before <= read.first <= after


def test_a_record_too_long_for_microsecond_stamps_raises_the_time_multiplier() -> None:
    # Three and a half hours: 1.26e10 microseconds, past the ten digits of a stamp.
    t = [0.0, 5000.0, 12600.0]

    read = _read(t, [ComtradeChannel("v", [1.0, 2.0, 3.0])])

    assert read.timemult == 10.0
    assert read.stamps.tolist() == [0, 500_000_000, 1_260_000_000]
    assert read.t.tolist() == pytest.approx(t)


# ---- names and units -----------------------------------------------------------------


def test_text_is_reduced_to_what_a_configuration_line_can_hold() -> None:
    """A comma would start another field, and the 1999 files are ASCII."""
    read = _read(
        [0.0, 1.0],
        [
            ComtradeChannel("Línea 4,5\tnorte\r\n", [1, 2], "MW, net"),
            ComtradeChannel("x" * 80, [1, 2], "u" * 40),
            ComtradeChannel("母线", [1, 2], "°"),
        ],
        station="Subestación Ñuñoa, 220 kV",
        device="run\n7",
    )

    assert read.station == "Subestacion Nunoa 220 kV"
    assert read.device == "run 7"
    assert [(c.name, c.unit) for c in read.channels] == [
        ("Linea 4 5 norte", "MW net"),
        ("x" * 64, "u" * 32),
        # Nothing of the name or the unit is ASCII: the channel is numbered and
        # has the unit of a channel given none.
        ("channel 3", "NONE"),
    ]


def test_a_channel_given_no_unit_is_written_with_none() -> None:
    read = _read([0.0, 1.0], [ComtradeChannel("vf GENROU 2", [1, 2]), ComtradeChannel("b", [1, 2], "")])

    assert [c.unit for c in read.channels] == ["NONE", "NONE"]


# ---- the data file -------------------------------------------------------------------


def test_the_data_file_is_one_crlf_line_per_sample_and_ends_with_the_eof_mark() -> None:
    record = _write([0.0, 0.5, 1.0], [ComtradeChannel("a", [0, 1, 2]), ComtradeChannel("b", [5, 5, 5])])

    assert record.dat == (
        "1,0,-99998,0\r\n"
        "2,500000,0,0\r\n"
        "3,1000000,99998,0\r\n"
        "\x1a"
    )


def test_a_long_record_of_many_channels_keeps_its_lines_in_order() -> None:
    """More samples than are formatted in one go."""
    samples, width = 5000, 7
    t = np.arange(samples) / 100
    signals = [np.sin(t * (k + 1)) + k for k in range(width)]

    read = _read(t, [ComtradeChannel(f"s{k}", signal) for k, signal in enumerate(signals)])

    assert read.stamps.size == samples
    for channel, signal in zip(read.channels, signals, strict=True):
        assert np.abs(channel.values - signal).max() <= channel.a / 2 * (1 + 1e-9)


def test_values_at_the_ends_of_what_a_float_holds_do_not_overflow() -> None:
    huge = [-1.7e308, 0.0, 1.7e308]
    tiny = [1.0, 1.0 + 2.3e-16, 1.0]

    read = _read([0, 1, 2], [ComtradeChannel("huge", huge), ComtradeChannel("tiny", tiny)])

    big, small = read.channels
    assert big.stored.tolist() == [-99998, 0, 99998]
    assert big.values.tolist() == pytest.approx(huge)
    assert small.values.tolist() == pytest.approx(tiny)


# ---- what makes no record --------------------------------------------------------------


@pytest.mark.parametrize(
    ("t", "channels", "options", "message"),
    [
        ([], [ComtradeChannel("v", [])], {}, "at least one sample"),
        ([0.0, 1.0], [], {}, "at least one channel"),
        ([0.0, 2.0, 1.0], [ComtradeChannel("v", [1, 2, 3])], {}, r"t\[2\] = 1 is earlier"),
        ([0.0, math.nan], [ComtradeChannel("v", [1, 2])], {}, "finite"),
        ([0.0, math.inf], [ComtradeChannel("v", [1, 2])], {}, "finite"),
        ([0.0, 1.0], [ComtradeChannel("Bus_3_v", [1, 2, 3])], {}, "'Bus_3_v' has 3 values for 2"),
        ([0.0, 1.0], [ComtradeChannel("v", ["a", "b"])], {}, "must hold numbers"),  # type: ignore[list-item]
        ([0.0, 1.0], [ComtradeChannel("v", [1, 2])], {"trigger_t": 1.5}, "outside the record"),
        ([0.0, 1.0], [ComtradeChannel("v", [1, 2])], {"trigger_t": -0.1}, "outside the record"),
        ([0.0, 1.0], [ComtradeChannel("v", [1, 2])], {"frequency_hz": 0.0}, "frequency_hz"),
        ([0.0, 1.0], [ComtradeChannel("v", [1, 2])], {"frequency_hz": math.nan}, "frequency_hz"),
        ([1e300, 2e300], [ComtradeChannel("v", [1, 2])], {}, "do not add up to a date"),
        ([-1e308, 1e308], [ComtradeChannel("v", [1, 2])], {}, "do not add up to a date"),
        ([0.0, 1e305], [ComtradeChannel("v", [1, 2])], {}, "span more than a record can stamp"),
    ],
)
def test_signals_that_make_no_record_are_refused_with_the_reason(
    t: list[float],
    channels: list[ComtradeChannel],
    options: dict[str, float],
    message: str,
) -> None:
    with pytest.raises(ComtradeError, match=message):
        _write(t, channels, **options)


# ---- the archive ----------------------------------------------------------------------


def test_the_archive_holds_the_two_files_under_one_name() -> None:
    t, omega, _ = _swing(1.0)
    record = _write(t, [ComtradeChannel("omega", omega, "pu")], station="wscc9")

    archive = comtrade_zip(record, "wscc9_run-1")

    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        assert zf.namelist() == ["wscc9_run-1.cfg", "wscc9_run-1.dat"]
        assert zf.read("wscc9_run-1.cfg") == record.cfg.encode("ascii")
        assert zf.read("wscc9_run-1.dat") == record.dat.encode("ascii")
    name, read = read_comtrade_zip(archive)
    assert name == "wscc9_run-1"
    assert read.station == "wscc9"
