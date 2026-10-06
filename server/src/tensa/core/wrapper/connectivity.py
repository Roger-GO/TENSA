"""Island detection."""

from __future__ import annotations

from tensa.core.connectivity_result import ConnectivityResult
from tensa.core.wrapper.base import WrapperBase


class ConnectivityMixin(WrapperBase):
    """Island detection on the loaded System."""

    def compute_connectivity(self) -> ConnectivityResult:
        """Run topology / island detection on the loaded System — Unit 17.

        Calls ANDES's ``ss.connectivity()`` (which delegates to
        ``ConnMan.check_connectivity``). The routine itself returns
        ``None`` and writes its output as side-effects on ``ss.Bus``:

        - ``Bus.island_sets`` — list of connected components (excluding
          degree-zero buses), each entry a list of 0-based bus
          *addresses* (positions in ``Bus.idx.v``).
        - ``Bus.islanded_buses`` — list of degree-zero bus addresses.
        - ``Bus.islands`` — unified list combining singletons for
          ``islanded_buses`` with the full components from
          ``island_sets``. ``len(Bus.islands)`` is the wire-payload's
          ``island_count``.

        The substrate translates bus addresses to user-facing idx
        values (case-file identifiers) via ``Bus.idx.v[address]`` so
        the SLD can index by the same idx it already uses for bus
        nodes. Idx values are stringified for stable JSON keying.

        Pre-condition: a case must be loaded *and* setup must be
        committed (ANDES populates ``Bus.a.a`` / address arrays during
        ``ss.setup()``; without setup the connectivity check would
        raise on missing attributes).

        Per the v2.0 plan's Unit 17 auto-fix: post-run only — no
        per-frame recomputation. The streaming pipeline's
        ``VAR_GROUPS`` schema (``server/src/tensa/core/stream.py``)
        is not touched here.

        Side-effects: ANDES's connectivity routine logs at INFO level
        when ``info=True``; we pass ``info=False`` so the substrate
        stays quiet (the wire payload carries everything the UI needs).
        """
        ss = self._require_loaded()
        self._ensure_setup()

        ss.connectivity(info=False)

        bus = ss.Bus
        # ANDES exposes idx values on the dynamically-built ``idx`` param;
        # ``.v`` is the underlying ndarray / list. We coerce to a plain
        # list so indexing is uniform across NumPy and list backings and
        # the result is JSON-friendly without type tagging.
        idx_v = list(bus.idx.v)

        def _addr_to_idx(addr: int) -> str:
            # Defensive: clamp into range so a misordered island never
            # raises on a stale address; in practice ANDES's
            # ``_find_islands`` only emits addresses in [0, n_buses).
            try:
                return str(idx_v[int(addr)])
            except (IndexError, ValueError):
                return str(addr)

        islands_addr_lists = list(getattr(bus, "islands", None) or [])
        islands: list[list[str]] = [
            [_addr_to_idx(a) for a in island] for island in islands_addr_lists
        ]
        islanded_addr_list = list(getattr(bus, "islanded_buses", None) or [])
        islanded_bus_idxes: list[str] = [
            _addr_to_idx(a) for a in islanded_addr_list
        ]
        return ConnectivityResult(
            island_count=len(islands),
            islands=islands,
            islanded_bus_idxes=islanded_bus_idxes,
        )
