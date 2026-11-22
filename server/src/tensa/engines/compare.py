"""Comparison of two results documents (section 10 of ``design/multiengine/spec.md``).

The definitions, for a reference series ``r`` and a comparison series ``c`` of one
quantity and key:

- The overlap is ``[max(r.t[0], c.t[0]), min(r.t[-1], c.t[-1])]``. Nothing outside
  it is compared, ever; nothing is extrapolated. A pair with no overlap is listed
  as not comparable, with the reason.
- A ``null`` in ``y`` is a gap. A gap splits a series: nothing is interpolated
  across it, and an instant inside either side's gap is left out of both the
  maximum and the integral, and the span the RMS is taken over is reduced by it.
- A time that occurs twice in a series is a step (ANDES records a time twice when
  an event changes the system at that instant): the interpolant uses the left
  value up to that time and the right value from it, and the difference at that
  instant is taken on both sides, the larger counting for the maximum. A step
  contributes nothing to the integral, which is over time.
- Interpolation is linear between a series' own samples, because both engines
  write piecewise-linear trajectories between output steps and nothing smoother
  is justified.
- The difference is ``d(t) = c(t) - r(t)`` (comparison minus reference; the
  request's ``reference`` document is the reference). For quantities whose unit
  is ``rad`` the difference is wrapped to ``[-pi, pi)`` before anything else is
  computed from it, so 0.1 and 2*pi + 0.05 rad are 0.05 rad apart, not one turn.
- ``rms_diff`` is time-weighted: ``d*d`` is integrated by the trapezoid rule over
  the union of the two series' sample times inside the overlap (the endpoints
  added), and ``rms_diff = sqrt(integral / span)``. A sampling that is denser
  around an event does not weigh that stretch more. With an overlap of zero
  length (a single common instant) the RMS is the absolute difference there.
- ``max_diff`` is the largest ``|d|`` on that union, with the time it occurs at
  (the first occurrence if tied).
- ``swing_ref`` is the reference series' max minus min over the compared stretch,
  so a difference can be read against how far the quantity actually moved.
- The tolerance is an absolute number in the series' unit. Relative tolerances
  are rejected as a design choice: a voltage band of 1e-4 pu means the same at
  0.9 and 1.05 pu, and a relative band does not.

Power flow tables compare row by row on the element key; angles compare in
radians with no wrapping, because power flow angles of the same case from two
engines differ by far less than pi and a wrapped comparison would hide a
genuinely different operating point. Each part of the table (buses, branches,
generators, loads) is compared with the same part only: a generator and a load
share the quantities ``p`` and ``q`` in the same units, and matching by quantity
and unit alone would compare a reference's loads with the comparison's
generators. When the power flow comparison is outside
its tolerance the result carries ``operating_point_differs``: a dynamic
difference that starts from a different operating point is reported as that
(section 10: "A power flow comparison is always shown first").

Eigenvalues are matched by optimal one-to-one assignment on distance in the
complex plane (the Hungarian method, through `scipy.optimize.linear_sum_assignment`),
not greedy: a
greedy pass can pair the two members of a close cluster the wrong way round and
leave a third mode unmatched, and the modes of two engines on one case are
exactly such clusters (the spike's three oscillatory modes sit at 0.64, 1.10 and
1.13 Hz). Each conjugate pair is counted once, by its member with the
non-negative imaginary part, because a conjugate pair is one mode. Before the
assignment every cost past ``max_mode_distance`` is replaced by a value larger
than it, so the assignment prefers every pair within the cap over one past it;
pairs still past the cap afterwards are left unmatched on both sides. Zero
eigenvalues (both parts exactly zero, the angle-reference mode) are matched
among themselves. Unmatched modes are listed, never ignored.

``state`` series (an engine's raw state) are for one engine only and are never
compared: they are listed as not comparable. A quantity with no default
tolerance and none in the request is reported without a verdict
(``within_tolerance`` and ``tolerance`` are ``None``).

The document models of ``tensa.engines.results_doc`` are named under
``TYPE_CHECKING`` only: that module imports ``tensa.api.schemas.tds``, whose
package imports the comparison schemas, which import this module's defaults, so
a module-level import here would be circular. ``ComparisonInput.from_document``
imports them on first use.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np
from numpy.typing import NDArray

if TYPE_CHECKING:
    from tensa.engines.results_doc import (
        EigenvalueRow,
        EngineBlock,
        PflowTable,
        ResultsDocument,
        Series,
    )

_Array = NDArray[np.float64]

# Default tolerances, each with its reason (the magnitudes are from
# design/multiengine/reports/phase-1-spike.md section 1).
DEFAULT_TOLERANCES: dict[str, float] = {
    "voltage": 1e-4,  # pu; like-for-like bus voltage RMS diff is 5e-5 to 4e-4 pu
    "angle": 1e-4,  # rad; power flow angles agree to 4.7e-5 deg (8e-7 rad)
    "p": 0.1,  # MW; 1e-3 pu on a 100 MVA base
    "q": 0.1,  # MVAr; as p
    "p_from": 0.1,  # MW; as p
    "q_from": 0.1,  # MVAr; as p
    "p_to": 0.1,  # MW; as p
    "q_to": 0.1,  # MVAr; as p
    "rotor_speed": 1e-4,  # pu; like-for-like max diff is 1e-5 pu on a swing of 1e-2
    "rotor_angle": 1e-2,  # rad; relative rotor angle max diff is 6.7e-3 rad on a swing of 0.17
    "angle_rel": 1e-4,  # rad; as angle
    "rotor_angle_rel": 1e-2,  # rad; as rotor_angle
}
DEFAULT_FREQ_TOLERANCE_HZ = 1e-3  # Hz; like-for-like modes agree to 4 digits
DEFAULT_DAMPING_TOLERANCE = 1e-3  # damping ratio; like-for-like modes agree to 4 digits
# 1/s. The spike's worst confirmed same-mode distance is the governor mode at
# |0.0706 - 0.0684| Hz * 2 pi, about 0.014 1/s before the known difference is
# accounted, and the closest distinct modes are 0.033 Hz apart in frequency
# alone (0.2 1/s); 0.05 sits between.
DEFAULT_MAX_MODE_DISTANCE = 0.05

MIN_SAMPLES = 2  # a difference of two points is defined

__all__ = [
    "DEFAULT_DAMPING_TOLERANCE",
    "DEFAULT_FREQ_TOLERANCE_HZ",
    "DEFAULT_MAX_MODE_DISTANCE",
    "DEFAULT_TOLERANCES",
    "MIN_SAMPLES",
    "CompareError",
    "ComparisonInput",
    "ComparisonResult",
    "EigenvaluePair",
    "NotComparable",
    "PflowComparison",
    "SeriesDifference",
    "TableRowDifference",
    "UnmatchedKeys",
    "clean_series",
    "compare_documents",
    "compare_rows",
    "compare_series",
    "match_eigenvalues",
    "wrap_angle",
]


class CompareError(ValueError):
    """A series or table cannot be compared (times that run backwards, fewer
    than two usable samples, a unit mismatch)."""


def wrap_angle(d: float) -> float:
    """``d`` wrapped to ``[-pi, pi)``: the shorter way round the circle."""
    return (d + math.pi) % (2.0 * math.pi) - math.pi


def _prepare(t: Sequence[float], y: Sequence[float | None]) -> tuple[_Array, _Array]:
    """Length, finiteness and order checks; ``None`` in ``y`` becomes ``nan``."""
    if len(t) != len(y):
        raise CompareError(
            f"t has {len(t)} samples and y has {len(y)}; they must be the same length"
        )
    tt = np.array(t, dtype=np.float64)
    yy = np.array([math.nan if v is None else v for v in y], dtype=np.float64)
    keep = np.isfinite(tt)
    tt, yy = tt[keep], yy[keep]
    if tt.size > 1 and np.any(np.diff(tt) < 0):
        raise CompareError("t must not decrease")
    return tt, yy


def clean_series(
    t: Sequence[float], y: Sequence[float | None]
) -> tuple[_Array, _Array]:
    """The finite samples in time order, repeated times kept as steps.

    Samples where ``t`` or ``y`` is not finite are dropped (``None`` in ``y``
    marks a gap and becomes ``nan`` first). Times must not decrease. A time
    that occurs twice is kept twice, left value first: ANDES records a time
    twice when an event changes the system at that instant, and the two samples
    are the states before and after it.
    """
    tt, yy = _prepare(t, y)
    finite = np.isfinite(yy)
    return tt[finite], yy[finite]


def _segments(
    t: Sequence[float], y: Sequence[float | None]
) -> list[tuple[_Array, _Array]]:
    """The maximal runs of usable samples; a gap (``null`` or a non-finite
    value) splits the series, and nothing is interpolated across it."""
    tt, yy = _prepare(t, y)
    finite = np.isfinite(yy)
    segments: list[tuple[_Array, _Array]] = []
    start: int | None = None
    for i in range(tt.size):
        if finite[i] and start is None:
            start = i
        elif not finite[i] and start is not None:
            segments.append((tt[start:i], yy[start:i]))
            start = None
    if start is not None:
        segments.append((tt[start:], yy[start:]))
    return segments


def _covers(seg: tuple[_Array, _Array], a: float, b: float) -> bool:
    """Whether the segment spans the whole interval ``[a, b]``."""
    return bool(seg[0].size > 0 and seg[0][0] <= a and seg[0][-1] >= b)


def _value_at(seg_t: _Array, seg_y: _Array, x: float, *, right: bool) -> float:
    """The series' interpolant at ``x``, linear between its own samples.

    At a time that occurs twice the value is the left sample up to that time
    and the right sample from it: ``right=False`` reads the left value,
    ``right=True`` the right one.
    """
    n = seg_t.size
    j = int(np.searchsorted(seg_t, x, side="left"))
    if j >= n:
        return float(seg_y[-1])
    if seg_t[j] == x:
        if right:
            while j + 1 < n and seg_t[j + 1] == x:
                j += 1
        return float(seg_y[j])
    if j == 0:
        return float(seg_y[0])
    t0, t1 = float(seg_t[j - 1]), float(seg_t[j])
    y0, y1 = float(seg_y[j - 1]), float(seg_y[j])
    return y0 + (y1 - y0) * (x - t0) / (t1 - t0)


@dataclass(frozen=True)
class SeriesDifference:
    """The difference of one pair of series; see the module docstring."""

    quantity: str
    key: str
    unit: str
    samples: int
    t_start: float
    t_end: float
    max_diff: float
    max_diff_t: float
    rms_diff: float
    swing_ref: float
    within_tolerance: bool | None
    tolerance: float | None


def compare_series(
    quantity: str,
    key: str,
    unit: str,
    t_ref: Sequence[float],
    y_ref: Sequence[float | None],
    t_new: Sequence[float],
    y_new: Sequence[float | None],
    *,
    tolerance: float | None,
) -> SeriesDifference:
    """Compare two series of one quantity and key; see the module docstring.

    Raises :class:`CompareError` when a side has fewer than
    :data:`MIN_SAMPLES` usable samples or the series do not overlap in time.
    """
    seg_ref = _segments(t_ref, y_ref)
    seg_new = _segments(t_new, y_new)
    for segments, side in ((seg_ref, "reference"), (seg_new, "comparison")):
        usable = sum(int(seg[0].size) for seg in segments)
        if usable < MIN_SAMPLES:
            raise CompareError(
                f"the {side} series for {key} has {usable} usable samples; "
                f"at least {MIN_SAMPLES} are needed"
            )
    lo = max(float(seg_ref[0][0][0]), float(seg_new[0][0][0]))
    hi = min(float(seg_ref[-1][0][-1]), float(seg_new[-1][0][-1]))
    if lo > hi:
        raise CompareError(
            f"the series for {key} do not overlap in time "
            f"({float(seg_ref[0][0][0])}..{float(seg_ref[-1][0][-1])} and "
            f"{float(seg_new[0][0][0])}..{float(seg_new[-1][0][-1])})"
        )
    rad = unit == "rad"
    # The grid is the union of both sides' sample times inside the overlap,
    # with the endpoints added, so each side's own kinks are points where the
    # difference is measured and the grid spans exactly the overlap.
    times = np.concatenate([seg[0] for seg in seg_ref + seg_new])
    inside = times[(times >= lo) & (times <= hi)]
    grid = np.union1d(inside, np.array([lo, hi], dtype=np.float64))

    def _covered(x: float) -> bool:
        return any(_covers(seg, x, x) for seg in seg_ref) and any(
            _covers(seg, x, x) for seg in seg_new
        )

    def _diff_at(x: float, *, right: bool) -> float:
        seg_r = next(seg for seg in seg_ref if _covers(seg, x, x))
        seg_n = next(seg for seg in seg_new if _covers(seg, x, x))
        d = _value_at(seg_n[0], seg_n[1], x, right=right) - _value_at(
            seg_r[0], seg_r[1], x, right=right
        )
        return wrap_angle(d) if rad else d

    usable_grid = [float(x) for x in grid if _covered(float(x))]
    if not usable_grid:
        raise CompareError(f"the series for {key} share no instant outside their gaps")
    ref_values: list[float] = []
    for x in usable_grid:
        seg_r = next(seg for seg in seg_ref if _covers(seg, x, x))
        ref_values.append(_value_at(seg_r[0], seg_r[1], x, right=False))
    swing = float(max(ref_values) - min(ref_values))
    max_diff = 0.0
    max_diff_t = usable_grid[0]
    if lo == hi:
        # An overlap of zero length: the RMS is the absolute difference there.
        d0 = _diff_at(lo, right=False)
        max_diff = abs(d0)
        rms = max_diff
    else:
        span = 0.0
        integral = 0.0
        for a, b in zip(usable_grid[:-1], usable_grid[1:], strict=True):
            if b <= a:
                continue
            if not (
                any(_covers(seg, a, b) for seg in seg_ref)
                and any(_covers(seg, a, b) for seg in seg_new)
            ):
                continue  # an interval inside either side's gap is left out
            # The difference at a step is taken on both sides: the interval
            # ending at the step reads the left value, the one starting at it
            # the right value, and the larger counts for the maximum.
            d_a = _diff_at(a, right=True)
            d_b = _diff_at(b, right=False)
            span += b - a
            integral += 0.5 * (d_a * d_a + d_b * d_b) * (b - a)
            if abs(d_a) > max_diff:
                max_diff = abs(d_a)
                max_diff_t = a
            if abs(d_b) > max_diff:
                max_diff = abs(d_b)
                max_diff_t = b
        if span <= 0.0:
            raise CompareError(
                f"the series for {key} share no instant outside their gaps"
            )
        rms = math.sqrt(integral / span)
    within = None if tolerance is None else bool(max_diff <= tolerance)
    return SeriesDifference(
        quantity=quantity,
        key=key,
        unit=unit,
        samples=len(usable_grid),
        t_start=usable_grid[0],
        t_end=usable_grid[-1],
        max_diff=max_diff,
        max_diff_t=max_diff_t,
        rms_diff=rms,
        swing_ref=swing,
        within_tolerance=within,
        tolerance=tolerance,
    )


@dataclass(frozen=True)
class TableRowDifference:
    """One power flow value compared by element key."""

    quantity: str
    key: str
    unit: str
    reference: float
    value: float
    diff: float  # value - reference
    within_tolerance: bool | None
    tolerance: float | None


@dataclass(frozen=True)
class UnmatchedKeys:
    """Keys present on one side only, sorted; never ignored."""

    missing_in_comparison: list[str]
    missing_in_reference: list[str]


def compare_rows(
    quantity: str,
    unit: str,
    reference: Mapping[str, float],
    value: Mapping[str, float],
    *,
    tolerance: float | None,
) -> tuple[list[TableRowDifference], UnmatchedKeys]:
    """Compare two mappings of element key to value, row by row, sorted by key."""
    rows: list[TableRowDifference] = []
    for key in sorted(reference.keys() & value.keys()):
        diff = float(value[key] - reference[key])
        within = None if tolerance is None else bool(abs(diff) <= tolerance)
        rows.append(
            TableRowDifference(
                quantity=quantity,
                key=key,
                unit=unit,
                reference=float(reference[key]),
                value=float(value[key]),
                diff=diff,
                within_tolerance=within,
                tolerance=tolerance,
            )
        )
    unmatched = UnmatchedKeys(
        missing_in_comparison=sorted(reference.keys() - value.keys()),
        missing_in_reference=sorted(value.keys() - reference.keys()),
    )
    return rows, unmatched


@dataclass(frozen=True)
class EigenvaluePair:
    """Two eigenvalues matched as one mode, with frequency and damping side by
    side as the results document carries them."""

    index_ref: int
    index_new: int
    eigenvalue_ref: complex
    eigenvalue_new: complex
    distance: float
    frequency_hz_ref: float
    frequency_hz_new: float
    damping_ratio_ref: float
    damping_ratio_new: float
    within_tolerance: bool


def _representatives(z: Sequence[complex]) -> list[int]:
    """One index per mode: of a conjugate pair the member with the non-negative
    imaginary part; a real eigenvalue itself."""
    keep: list[int] = []
    for i, zi in enumerate(z):
        if zi.imag < 0.0 and any(
            abs(zj - zi.conjugate()) <= 1e-12 for zj in z
        ):
            continue
        keep.append(i)
    return keep


def _is_zero(z: complex) -> bool:
    return z.real == 0.0 and z.imag == 0.0


def _hungarian(cost: _Array) -> list[tuple[int, int]]:
    """The minimum-cost one-to-one assignment of rows to columns, sorted.

    ``scipy.optimize.linear_sum_assignment``, which is compiled: a case with
    some 800 modes (Nordic 44) is matched in milliseconds, where a pure Python
    Hungarian method takes minutes. scipy comes with ANDES, which the server
    already relies on for it (``core/wrapper/eig.py``, ``core/wrapper/pflow.py``).
    Every row is matched when there are at least as many columns as rows, and
    the other way round.
    """
    from scipy.optimize import linear_sum_assignment  # type: ignore[import-untyped]

    rows, cols = linear_sum_assignment(cost)
    return sorted((int(r), int(c)) for r, c in zip(rows, cols, strict=True))


def match_eigenvalues(
    ref: Sequence[complex],
    new: Sequence[complex],
    *,
    max_distance: float = DEFAULT_MAX_MODE_DISTANCE,
    freq_tolerance_hz: float = DEFAULT_FREQ_TOLERANCE_HZ,
    damping_tolerance: float = DEFAULT_DAMPING_TOLERANCE,
    frequency_hz_ref: Sequence[float] | None = None,
    frequency_hz_new: Sequence[float] | None = None,
    damping_ratio_ref: Sequence[float] | None = None,
    damping_ratio_new: Sequence[float] | None = None,
) -> tuple[list[EigenvaluePair], list[int], list[int]]:
    """Match the modes of two eigenvalue tables; see the module docstring.

    ``frequency_hz_*`` and ``damping_ratio_*`` are the values the results
    document carries; left out they are recomputed as ``imag(z) / (2*pi)`` and
    ``-real(z) / |z|`` (a zero eigenvalue has damping ratio 1). Returns the
    pairs sorted by the reference frequency, and the unmatched indices of each
    side, sorted.
    """
    def freq(z: complex, values: Sequence[float] | None, i: int) -> float:
        if values is not None:
            return float(values[i])
        return float(z.imag / (2.0 * math.pi))

    def damp(z: complex, values: Sequence[float] | None, i: int) -> float:
        if values is not None:
            return float(values[i])
        if _is_zero(z):
            return 1.0
        return float(-z.real / abs(z))

    rep_ref = _representatives(ref)
    rep_new = _representatives(new)
    zero_ref = [i for i in rep_ref if _is_zero(ref[i])]
    zero_new = [i for i in rep_new if _is_zero(new[i])]
    osc_ref = [i for i in rep_ref if not _is_zero(ref[i])]
    osc_new = [i for i in rep_new if not _is_zero(new[i])]

    matched: list[tuple[int, int]] = []
    # Zero eigenvalues are matched among themselves, in order.
    matched.extend(zip(zero_ref, zero_new, strict=False))
    if osc_ref and osc_new:
        cost = np.array(
            [[abs(ref[i] - new[j]) for j in osc_new] for i in osc_ref],
            dtype=np.float64,
        )
        # Cap every cost at a value past max_distance: two pairs farther than
        # the cap then cost the same, so the assignment prefers every pair
        # within it, and the drop below still leaves the rest unmatched.
        capped = np.minimum(cost, max_distance + 1.0)
        for r, c in _hungarian(capped):
            matched.append((osc_ref[r], osc_new[c]))
    pairs: list[EigenvaluePair] = []
    used_ref: set[int] = set()
    used_new: set[int] = set()
    for i, j in matched:
        distance = abs(ref[i] - new[j])
        if distance > max_distance:
            continue  # farther apart than the cap: unmatched on both sides
        used_ref.add(i)
        used_new.add(j)
        fr = freq(ref[i], frequency_hz_ref, i)
        fn = freq(new[j], frequency_hz_new, j)
        dr = damp(ref[i], damping_ratio_ref, i)
        dn = damp(new[j], damping_ratio_new, j)
        pairs.append(
            EigenvaluePair(
                index_ref=i,
                index_new=j,
                eigenvalue_ref=ref[i],
                eigenvalue_new=new[j],
                distance=float(distance),
                frequency_hz_ref=fr,
                frequency_hz_new=fn,
                damping_ratio_ref=dr,
                damping_ratio_new=dn,
                within_tolerance=bool(
                    abs(fn - fr) <= freq_tolerance_hz
                    and abs(dn - dr) <= damping_tolerance
                ),
            )
        )
    pairs.sort(key=lambda pair: pair.frequency_hz_ref)
    # A conjugate pair is one mode: only the representatives can be unmatched.
    unmatched_ref = sorted(i for i in rep_ref if i not in used_ref)
    unmatched_new = sorted(j for j in rep_new if j not in used_new)
    return pairs, unmatched_ref, unmatched_new


@dataclass(frozen=True)
class ComparisonInput:
    """The part of a results document comparison reads."""

    engine: EngineBlock
    series: list[Series] = field(default_factory=list)
    pflow: PflowTable | None = None
    eigenvalues: list[EigenvalueRow] | None = None

    @classmethod
    def from_document(cls, doc: ResultsDocument) -> ComparisonInput:
        """The comparison input of a landed results document: the series as
        they are, the ``pflow`` table (``None`` when absent) and the rows of
        the ``eig`` table (``None`` when absent)."""
        return cls(
            engine=doc.engine,
            series=list(doc.series),
            pflow=doc.tables.pflow,
            eigenvalues=(
                None
                if doc.tables.eig is None
                else list(doc.tables.eig.eigenvalues)
            ),
        )


@dataclass(frozen=True)
class PflowComparison:
    """The power flow comparison, always shown first."""

    converged_reference: bool
    converged_comparison: bool
    rows: list[TableRowDifference]
    unmatched: UnmatchedKeys


@dataclass(frozen=True)
class NotComparable:
    """A pair of series that cannot be compared, with the reason."""

    quantity: str
    key: str
    reason: str


@dataclass(frozen=True)
class ComparisonResult:
    """The whole comparison: power flow first, then series, then eigenvalues."""

    engine_reference: EngineBlock
    engine_comparison: EngineBlock
    operating_point_differs: bool
    power_flow: PflowComparison | None
    series: list[SeriesDifference]
    not_comparable: list[NotComparable]
    unmatched_series_reference: list[str]
    unmatched_series_comparison: list[str]
    eigenvalues: list[EigenvaluePair]
    unmatched_eigenvalues_reference: list[int]
    unmatched_eigenvalues_comparison: list[int]
    errors: list[str]


def _pflow_mappings(
    table: PflowTable,
) -> list[tuple[str, str, str, dict[str, float]]]:
    """The table as ``(part, quantity, unit, mapping)`` per value kind.

    ``part`` names the section of the table the mapping comes from (``buses``,
    ``branches``, ``generators``, ``loads``): a part is only ever compared
    with the same part, because a generator and a load share the quantities
    ``p`` and ``q`` in the same units.
    """
    buses_v = {row.key: row.v_pu for row in table.buses}
    buses_a = {row.key: row.angle_rad for row in table.buses}
    branches_p: dict[str, float] = {}
    branches_q: dict[str, float] = {}
    for row in table.branches:
        branches_p[row.key] = row.p_from_mw
        if row.q_from_mvar is not None:
            branches_q[row.key] = row.q_from_mvar
    gens_p: dict[str, float] = {}
    gens_q: dict[str, float] = {}
    for gen_row in table.generators:
        gens_p[gen_row.key] = gen_row.p_mw
        if gen_row.q_mvar is not None:
            gens_q[gen_row.key] = gen_row.q_mvar
    loads_p: dict[str, float] = {}
    loads_q: dict[str, float] = {}
    for load_row in table.loads:
        loads_p[load_row.key] = load_row.p_mw
        if load_row.q_mvar is not None:
            loads_q[load_row.key] = load_row.q_mvar
    return [
        ("buses", "voltage", "pu", buses_v),
        ("buses", "angle", "rad", buses_a),
        ("branches", "p_from", "MW", branches_p),
        ("branches", "q_from", "MVAr", branches_q),
        ("generators", "p", "MW", gens_p),
        ("generators", "q", "MVAr", gens_q),
        ("loads", "p", "MW", loads_p),
        ("loads", "q", "MVAr", loads_q),
    ]


def compare_documents(
    reference: ComparisonInput,
    comparison: ComparisonInput,
    *,
    tolerances: Mapping[str, float],
    freq_tolerance_hz: float = DEFAULT_FREQ_TOLERANCE_HZ,
    damping_tolerance: float = DEFAULT_DAMPING_TOLERANCE,
    max_mode_distance: float = DEFAULT_MAX_MODE_DISTANCE,
) -> ComparisonResult:
    """Compare two results documents; see the module docstring.

    The power flow comparison comes first, then the series, then the
    eigenvalues. A series that cannot be compared (times that run backwards,
    too few usable samples, no overlap) does not fail the request: it is listed
    in ``not_comparable`` with the reason. A unit mismatch on a pair raises
    :class:`CompareError`, because the two documents disagree about what the
    number is.
    """
    errors: list[str] = []
    power_flow: PflowComparison | None = None
    operating_point_differs = False
    if reference.pflow is not None and comparison.pflow is not None:
        rows: list[TableRowDifference] = []
        missing_in_comparison: list[str] = []
        missing_in_reference: list[str] = []
        comparison_mappings = _pflow_mappings(comparison.pflow)
        for part, quantity, unit, ref_map in _pflow_mappings(reference.pflow):
            new_map: dict[str, float] = {}
            for new_part, q, u, m in comparison_mappings:
                if new_part == part and q == quantity and u == unit:
                    new_map = m
                    break
            tolerance = tolerances.get(quantity, DEFAULT_TOLERANCES.get(quantity))
            part_rows, unmatched = compare_rows(
                quantity, unit, ref_map, new_map, tolerance=tolerance
            )
            rows.extend(part_rows)
            missing_in_comparison.extend(unmatched.missing_in_comparison)
            missing_in_reference.extend(unmatched.missing_in_reference)
        power_flow = PflowComparison(
            converged_reference=reference.pflow.converged,
            converged_comparison=comparison.pflow.converged,
            rows=rows,
            unmatched=UnmatchedKeys(
                missing_in_comparison=sorted(set(missing_in_comparison)),
                missing_in_reference=sorted(set(missing_in_reference)),
            ),
        )
        operating_point_differs = any(
            row.within_tolerance is False for row in rows
        ) or reference.pflow.converged != comparison.pflow.converged

    ref_series = {(s.quantity, s.of): s for s in reference.series}
    new_series = {(s.quantity, s.of): s for s in comparison.series}
    series_rows: list[SeriesDifference] = []
    not_comparable: list[NotComparable] = []
    for pair_key in sorted(ref_series.keys() & new_series.keys()):
        quantity, of = pair_key
        ref_s = ref_series[pair_key]
        new_s = new_series[pair_key]
        if quantity == "state" or quantity.startswith("state"):
            not_comparable.append(
                NotComparable(
                    quantity=quantity,
                    key=of,
                    reason="state series are an engine's raw state and are never compared",
                )
            )
            continue
        if ref_s.unit != new_s.unit:
            raise CompareError(
                f"series {of} ({quantity}) has unit {ref_s.unit} in the reference "
                f"and {new_s.unit} in the comparison; they must match"
            )
        tolerance = tolerances.get(quantity, DEFAULT_TOLERANCES.get(quantity))
        try:
            series_rows.append(
                compare_series(
                    quantity,
                    of,
                    ref_s.unit,
                    ref_s.t,
                    ref_s.y,
                    new_s.t,
                    new_s.y,
                    tolerance=tolerance,
                )
            )
        except CompareError as exc:
            errors.append(str(exc))
            not_comparable.append(
                NotComparable(quantity=quantity, key=of, reason=str(exc))
            )
    unmatched_series_reference = sorted(
        f"{quantity}|{of}" for (quantity, of) in ref_series.keys() - new_series.keys()
    )
    unmatched_series_comparison = sorted(
        f"{quantity}|{of}" for (quantity, of) in new_series.keys() - ref_series.keys()
    )

    eigen_pairs: list[EigenvaluePair] = []
    unmatched_eig_ref: list[int] = []
    unmatched_eig_new: list[int] = []
    if reference.eigenvalues is not None and comparison.eigenvalues is not None:
        ref_z = [complex(row.re, row.im) for row in reference.eigenvalues]
        new_z = [complex(row.re, row.im) for row in comparison.eigenvalues]
        eigen_pairs, unmatched_eig_ref, unmatched_eig_new = match_eigenvalues(
            ref_z,
            new_z,
            max_distance=max_mode_distance,
            freq_tolerance_hz=freq_tolerance_hz,
            damping_tolerance=damping_tolerance,
            frequency_hz_ref=[row.frequency_hz for row in reference.eigenvalues],
            frequency_hz_new=[row.frequency_hz for row in comparison.eigenvalues],
            damping_ratio_ref=[row.damping_ratio for row in reference.eigenvalues],
            damping_ratio_new=[row.damping_ratio for row in comparison.eigenvalues],
        )

    return ComparisonResult(
        engine_reference=reference.engine,
        engine_comparison=comparison.engine,
        operating_point_differs=operating_point_differs,
        power_flow=power_flow,
        series=series_rows,
        not_comparable=not_comparable,
        unmatched_series_reference=unmatched_series_reference,
        unmatched_series_comparison=unmatched_series_comparison,
        eigenvalues=eigen_pairs,
        unmatched_eigenvalues_reference=unmatched_eig_ref,
        unmatched_eigenvalues_comparison=unmatched_eig_new,
        errors=errors,
    )
