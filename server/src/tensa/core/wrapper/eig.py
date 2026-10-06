"""Eigenvalue analysis."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from tensa.core.eig_result import ComplexNumber, EigResult
from tensa.core.errors import EigComputationError, EigPrerequisiteError, ElementNotFoundError
from tensa.core.wrapper.base import WrapperBase

if TYPE_CHECKING:
    from andes.system import System


class EigMixin(WrapperBase):
    """Eigenvalue analysis: the run, one mode's participation, the state matrix."""

    def run_eig(self) -> EigResult:
        """Run eigenvalue analysis (small-signal stability) — Unit 6.

        Substrate-side gate (per Unit 1a spike): ``EIG._pre_check`` only
        warns on non-converged PFlow but falls through to ``TDS.init()``
        and crashes. We MUST gate on ``ss.PFlow.converged is True``
        ourselves and raise :class:`EigPrerequisiteError` otherwise.

        Side effects (documented for the UI banner):

        - ``EIG.run()`` sets ``TDS.initialized=True`` and advances
          ``dae.t`` from ``-1.0`` to ``0.0``. The result carries
          ``tds_initialized=True`` so the UI can surface a "EIG
          initialised the dynamic state" info banner per the plan's
          Approach addendum.
        - The reduced state count (``len(EIG.mu)``) is what we report,
          not ``dae.n``. Stock IEEE 14 → 0; full IEEE 14 + dyr → 62;
          kundur_full → 52.
        """
        ss = self._require_loaded()
        self._ensure_setup()
        # Independent PF gate — ANDES's own check is unsafe (see docstring).
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise EigPrerequisiteError(
                "Run PFlow first; EIG requires a converged operating point."
            )

        try:
            ss.EIG.run()
        except EigPrerequisiteError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise EigComputationError(
                f"Eigenvalue analysis failed: {exc}"
            ) from exc

        mu = getattr(ss.EIG, "mu", None)
        eigenvalues: list[ComplexNumber] = []
        damping_ratios: list[float] = []
        frequencies_hz: list[float] = []
        if mu is not None:
            try:
                mu_iter = list(mu)
            except TypeError:
                mu_iter = []
            for z in mu_iter:
                z_complex = complex(z)
                eigenvalues.append(ComplexNumber.from_complex(z_complex))
                damping_ratios.append(_compute_damping_ratio(z_complex))
                frequencies_hz.append(_compute_frequency_hz(z_complex))

        mode_count = len(eigenvalues)
        # Reduced state names — derived from the shape of ``EIG.As``
        # (which is sized identically to ``EIG.mu``) by indexing into
        # ``ss.dae.x_name`` when the lengths match. When they don't
        # (folded states), fall back to generic ``state_<i>`` labels so
        # the UI table always has something to render.
        state_names = _eig_state_names(ss, mode_count)
        return EigResult(
            eigenvalues=eigenvalues,
            damping_ratios=damping_ratios,
            frequencies_hz=frequencies_hz,
            mode_count=mode_count,
            state_count=mode_count,
            state_names=state_names,
            tds_initialized=bool(getattr(ss.TDS, "initialized", False)),
        )

    def eig_participation(self, mode_idx: int) -> dict[str, object]:
        """Return per-mode participation factors as a dict suitable for
        the routes layer to ship verbatim.

        ``EIG.pfactors`` is a 2-D ``np.ndarray`` of shape
        ``[mode_count, state_count]`` (computed inside ``EIG.run()``).
        Per the spike, there is no per-mode lazy slicing API in ANDES —
        we just slice the in-memory matrix. Substrate-side gating:

        - Returns 404 (via :class:`ElementNotFoundError`) if
          ``mode_idx`` is out of range OR EIG has not been run yet
          (``EIG.pfactors`` would be ``None``).
        """
        ss = self._require_loaded()
        pfactors = getattr(ss.EIG, "pfactors", None)
        if pfactors is None:
            raise EigPrerequisiteError(
                "EIG has not been run on this session; run /eig first"
            )
        try:
            n_modes = int(pfactors.shape[0])
        except (AttributeError, IndexError, TypeError) as exc:
            raise EigComputationError(
                f"EIG.pfactors has unexpected shape: {exc}"
            ) from exc
        if mode_idx < 0 or mode_idx >= n_modes:
            raise ElementNotFoundError(
                f"mode_idx {mode_idx} out of range [0, {n_modes - 1}]"
            )
        try:
            row = pfactors[mode_idx]
        except (IndexError, TypeError) as exc:
            raise EigComputationError(
                f"failed to slice EIG.pfactors[{mode_idx}]: {exc}"
            ) from exc

        # Coerce row to a Python list of floats (pfactors are real-valued
        # magnitudes by ANDES convention — see ``calc_pfactor``).
        try:
            row_list = [float(v) for v in row]
        except (TypeError, ValueError) as exc:
            raise EigComputationError(
                f"failed to coerce participation row: {exc}"
            ) from exc

        state_names = _eig_state_names(ss, len(row_list))
        participation = [
            {"state_name": name, "factor": factor}
            for name, factor in zip(state_names, row_list, strict=False)
        ]
        return {"mode_idx": mode_idx, "participation": participation}

    def get_eig_state_matrix(self) -> bytes:
        """Return ``EIG.As`` (and ``EIG.mu``) packed as a ``.mat`` file
        via ``scipy.io.savemat`` — Unit 6 EIG export integration with
        Unit 2's MAT exporter.

        Pre-condition: EIG.run() must have populated ``EIG.As`` (raises
        :class:`EigPrerequisiteError` otherwise so the routes layer can
        surface a 409 with the same recovery message as the per-mode
        participation route).
        """
        ss = self._require_loaded()
        As = getattr(ss.EIG, "As", None)
        mu = getattr(ss.EIG, "mu", None)
        if As is None or mu is None:
            raise EigPrerequisiteError(
                "EIG has not been run on this session; run /eig first"
            )
        try:
            from io import BytesIO

            from scipy.io import savemat  # type: ignore[import-untyped]
        except ImportError as exc:  # pragma: no cover — scipy is an ANDES dep
            raise EigComputationError(
                f"scipy.io.savemat unavailable: {exc}"
            ) from exc

        buf = BytesIO()
        try:
            savemat(
                buf,
                {
                    "As": As,
                    "mu": mu,
                },
                format="5",
                do_compression=True,
            )
        except Exception as exc:  # noqa: BLE001
            raise EigComputationError(
                f"savemat failed for EIG.As: {exc}"
            ) from exc
        return buf.getvalue()


# ---- EIG helpers (Unit 6) --------------------------------------------------


def _compute_damping_ratio(z: complex) -> float:
    """Per-mode damping ratio.

    Convention used by power-systems texts (and ANDES's own
    plotting): ``zeta = -Re(z) / |z|``. NaN guards collapse to 0.0
    so the wire payload never carries non-finite floats (which would
    fail JSON serialization in the routes layer).
    """
    magnitude = (z.real * z.real + z.imag * z.imag) ** 0.5
    if magnitude == 0.0 or not math.isfinite(magnitude):
        return 0.0
    zeta = -z.real / magnitude
    if not math.isfinite(zeta):
        return 0.0
    return float(zeta)


def _compute_frequency_hz(z: complex) -> float:
    """Per-mode oscillation frequency in Hz.

    ``f = |Im(z)| / (2*pi)``. Returns 0 for purely real eigenvalues.
    """
    return float(abs(z.imag) / (2.0 * math.pi))


def _eig_state_names(ss: System, mode_count: int) -> list[str]:
    """Best-effort labels for the reduced state vector EIG operates on.

    ANDES's ``EIG.run()`` reduces the state set via ``_fold_zstates``
    + ``_apply_state_constraints`` (see Unit 1a spike, lines 50-54).
    Our preferred source of names is ``ss.dae.x_name``; when the
    lengths match we use it directly. When they don't (folded
    states), fall back to generic ``state_<i>`` labels so the
    participation table always has stable labels.
    """
    dae = getattr(ss, "dae", None)
    if dae is not None:
        x_name = getattr(dae, "x_name", None)
        if x_name is not None:
            try:
                names = [str(n) for n in x_name]
            except (TypeError, ValueError):
                names = []
            if len(names) == mode_count:
                return names
    return [f"state_{i}" for i in range(mode_count)]
