"""EIG (eigenvalue analysis) result dataclasses for Unit 6 of the v2.0 plan.

Wraps :meth:`andes.routines.eig.EIG.run`'s outputs. Returned by
:meth:`andes_app.core.wrapper.Wrapper.run_eig` and serialized over the
worker Pipe before crossing the FastAPI boundary.

ANDES exposes complex eigenvalues as a ``np.ndarray[complex128]`` on
``EIG.mu``. The wire format splits each complex value into a
``ComplexNumber`` ``{real, imag}`` pair so the JSON payload doesn't have
to invent an out-of-band complex encoding.

Per Unit 1a spike (``docs/spikes/2026-05-09-andes-routine-surface-spike.md``):

- The eigenvalue count is the *reduced* state count (post fold/elimination),
  not ``dae.n``. Stock IEEE 14 (no dyn models) → 0 eigenvalues; full
  IEEE 14 + dyr → 62; kundur_full → 52.
- Calling ``EIG.run()`` mutates dae state — sets ``TDS.initialized=True``
  and advances ``dae.t`` to 0. The ``tds_initialized`` field surfaces
  this so the UI can warn the user (per Unit 6's Approach addendum).
"""

from __future__ import annotations

import dataclasses


@dataclasses.dataclass(frozen=True)
class ComplexNumber:
    """JSON-friendly complex-number wrapper.

    ANDES eigenvalues are ``complex128``; we split into real / imag so the
    wire format is plain JSON. Use ``ComplexNumber.from_complex(z)`` to
    build one from a Python ``complex``.
    """

    real: float
    imag: float

    @classmethod
    def from_complex(cls, z: complex) -> "ComplexNumber":
        return cls(real=float(z.real), imag=float(z.imag))


@dataclasses.dataclass(frozen=True)
class EigResult:
    """Eigenvalue analysis result returned by ``Wrapper.run_eig``.

    Field semantics:

    - ``eigenvalues``: list of complex eigenvalues (``EIG.mu``), each
      wrapped as :class:`ComplexNumber`. Length == ``mode_count``.
    - ``damping_ratios``: per-mode damping ratio
      ``-Re(mu) / |mu|`` (1 for purely real negative-Re eigenvalues, 0
      for purely imaginary). NaN guards collapsed to 0.0.
    - ``frequencies_hz``: per-mode oscillation frequency
      ``|Im(mu)| / (2 * pi)``. 0 for purely real eigenvalues.
    - ``mode_count``: number of eigenvalues == ``len(EIG.mu)``.
    - ``state_count``: same as ``mode_count`` — kept as a separate field
      for clarity in the UI (state-matrix shape is ``[state_count,
      state_count]``).
    - ``state_names``: ANDES-side names of the reduced states (post
      ``_fold_zstates`` + ``_apply_state_constraints``). Indexed
      identically to ``eigenvalues`` participation slicing.
    - ``tds_initialized``: always ``True`` after a successful EIG.run
      (per the spike — ``EIG._pre_check`` calls ``TDS.init()`` +
      ``TDS.itm_step()`` if not already initialised).
    """

    eigenvalues: list[ComplexNumber]
    damping_ratios: list[float]
    frequencies_hz: list[float]
    mode_count: int
    state_count: int
    state_names: list[str]
    tds_initialized: bool


__all__ = ["ComplexNumber", "EigResult"]
