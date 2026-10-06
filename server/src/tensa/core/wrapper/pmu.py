"""PMU placement and export."""

from __future__ import annotations

from typing import Any

from tensa.core.errors import ElementValidationError, SetupFailedError
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.elements import ElementsMixin
from tensa.core.wrapper.results import TopologyEntry
from tensa.core.wrapper.topology import _collect_models


class PmuMixin(ElementsMixin):
    """PMU placement and the CSV of what the PMUs measured in a run."""

    # ----- PMU placement (Unit 14) -----
    #
    # PMUs are a separate vertical from generic add_element on the API
    # surface (per Unit 14 plan): the placement dialog, the listing
    # endpoint, and the post-run CSV export are all PMU-scoped. The
    # wrapper-side mechanics still re-use the generic ``add_element`` /
    # ``delete_element`` paths so PMUs participate in the existing
    # ``_edit_log`` reload-and-replay machinery without growing a
    # parallel buffer.
    #
    # PMU outputs during TDS:
    # - ``am`` (state) — phase angle measurement, low-pass-filtered with
    #   time constant ``Ta`` (default 0.1s; substrate ships 0.05s).
    # - ``vm`` (state) — voltage magnitude measurement, low-pass-filtered
    #   with time constant ``Tv``. Both states track their respective
    #   bus values via ``e_str = a - am`` / ``v - vm``.
    # ANDES auto-generates ``PMU_<n>`` idx values when not supplied.

    def add_pmu(
        self, bus_idx: int | str, Ta: float = 0.05, Tv: float = 0.05
    ) -> TopologyEntry:
        """Add a PMU instance attached to ``bus_idx`` — Unit 14.

        Pre-setup gate matches ``add_element``: ANDES rejects all
        post-setup ``ss.add()`` calls regardless of model, and the route
        layer maps the resulting ``DisturbanceCommitError`` to a 409 with
        a "reload to recover" hint.

        ``bus_idx`` is forwarded as-is to ANDES. Cases loaded from .raw
        files use integer-typed bus idx values; .xlsx / .json cases use
        strings. The wrapper's bus-existence check looks up against
        ``ss.Bus.idx.v`` with string-equality coercion so either form
        works on the API surface.

        Returns the freshly-built ``TopologyEntry`` for the new PMU
        (``kind="PMU"``, ``params`` includes ``bus`` / ``Ta`` / ``Tv``).

        Raises ``ElementValidationError`` (→ 422) when the bus does not
        exist on the loaded System (the underlying ANDES error is
        opaque; we pre-validate so the user sees an actionable message).
        """
        ss = self._require_editable()
        self._require_room_in_edit_log()

        # Pre-validate bus existence so the user gets a clean 422 instead
        # of ANDES's internal "no such ACNode" exception inside ss.add.
        bus_obj = getattr(ss, "Bus", None)
        bus_idx_var = getattr(bus_obj, "idx", None) if bus_obj is not None else None
        bus_values = list(
            getattr(bus_idx_var, "v", []) if bus_idx_var is not None else []
        )
        bus_idx_str = str(bus_idx)
        # Look up the resolved bus value with the same type ANDES has on
        # ``ss.Bus.idx.v``. PSS/E .raw cases store integer-typed idxes;
        # .xlsx / .json cases store strings. The API surface always sends
        # strings, so we resolve the matching value and forward it with
        # ANDES's native type — otherwise ``ss.setup`` would later crash
        # with "<Bus>: device not exist with idx=1." (string vs int
        # mismatch in the cross-reference table).
        resolved_bus: int | str | None = None
        for value in bus_values:
            if str(value) == bus_idx_str:
                resolved_bus = value
                break
        if resolved_bus is None:
            raise ElementValidationError(
                f"no Bus with idx={bus_idx!r} on the loaded System; "
                f"PMU placement requires an existing bus"
            )

        params: dict[str, Any] = {
            "bus": resolved_bus,
            "Ta": float(Ta),
            "Tv": float(Tv),
        }
        # Snapshot for replay BEFORE ANDES mutates the dict in-place
        # (ss.add can pop fields during model registration).
        replay_snapshot = dict(params)
        try:
            new_idx = ss.add("PMU", params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected PMU add for bus {bus_idx!r}: "
                f"{_sanitize_message(str(exc))}"
            ) from exc

        # Record via the same log ``add_element`` uses so reload-and-
        # replay carries the PMU, with the idx ANDES assigned.
        self._record_add("PMU", replay_snapshot, new_idx)

        entry = self._lookup_topology_entry("PMU", new_idx)
        if entry is None:
            raise ElementValidationError(
                f"ANDES accepted PMU add but no device with idx={new_idx!r} "
                "was found on read-back"
            )
        return entry

    def list_pmus(self) -> list[TopologyEntry]:
        """Return every PMU instance currently on the loaded System.

        Empty list when no PMUs have been placed (the common case for a
        freshly-loaded stock case — ANDES's bundled IEEE 14 / 39 /
        kundur cases ship with zero PMUs). Works pre- or post-setup —
        the read goes through ``_collect_models`` which is state-agnostic.
        """
        ss = self._require_loaded()
        return _collect_models(ss, ["PMU"])

    def delete_pmu(self, idx: int | str) -> None:
        """Remove a PMU, whether :meth:`add_pmu` placed it or the case file
        brought it — Unit 14.

        Same pre-setup gate as ``delete_element``. Implementation
        delegates to ``delete_element`` so the edit log and its
        reload-and-replay machinery are shared.

        Raises ``ElementNotFoundError`` (→ 404) when no PMU with that
        idx exists; ``DisturbanceCommitError`` (→ 409) when setup is
        committed.
        """
        # delete_element handles the pre-setup gate and the walk for
        # dependents (nothing names a PMU, so it finds none).
        self.delete_element("PMU", idx)

    def export_pmu_csv(self) -> str:
        """Build a long-form CSV of every PMU's am/vm trajectories from
        the most recent TDS run — Unit 14.

        Columns:
        - ``t`` — simulation time (seconds), one row per integration step
          (full TDS rate; NOT decimated).
        - ``<pmu_idx>_am`` — phase angle measurement (radians) for each PMU.
        - ``<pmu_idx>_vm`` — voltage magnitude measurement (pu) for each PMU.

        PMU idx values appear in the header in the order ANDES holds them
        on ``ss.PMU.idx.v``. Two columns per PMU (am, vm).

        Pre-conditions:
        - A case must be loaded and setup must have been committed (TDS
          requires it). Raises ``NoCaseLoadedError`` (→ 409) otherwise.
        - At least one TDS step must have completed — i.e., ``ss.dae.ts``
          must have populated time-series data. An empty ``ts.t`` array
          surfaces as an empty CSV body (header only) so the caller can
          distinguish "no PMUs placed" (header has only ``t``) from "PMUs
          placed but no TDS run" (header carries the columns, body has
          zero rows).
        - At least one PMU must be present. When the System has zero
          PMUs the CSV body is just the ``t`` column with one row per
          recorded step. Callers should typically gate the export
          button on ``list_pmus()`` returning a non-empty list.

        The CSV is built in-memory (not streamed) — at full TDS rate a
        20-second IEEE 39 run with 5 PMUs is ~50 KB, well under the
        Pipe-send threshold.
        """
        import csv
        import io

        ss = self._require_loaded()
        # Gate on setup so the caller sees a clean 409 rather than an
        # opaque KeyError when ``ss.dae.ts`` hasn't been populated yet.
        if not ss.is_setup:
            raise SetupFailedError(
                "PMU export requires a TDS run; setup() has not been "
                "committed on this session"
            )

        pmu = getattr(ss, "PMU", None)
        pmu_idx_v = list(
            getattr(getattr(pmu, "idx", None), "v", []) if pmu is not None else []
        )

        # ``dae.ts`` exposes ``t`` (1-D) and ``x`` (2-D, [steps, n_states])
        # arrays once unpacked. ``unpack`` is safe to call repeatedly —
        # it's the documented bridge from the dict-based per-step storage
        # to the numpy-array post-run view.
        ts = ss.dae.ts
        # Trigger unpack into numpy arrays (warn_empty=False so an
        # uncalled-TDS session doesn't spam the log; we surface the
        # empty case as a header-only CSV instead).
        ts.unpack_np(attr=None, warn_empty=False)
        t_arr = list(getattr(ts, "t", []))

        # Collect (am.a, vm.a) addresses per PMU. ANDES's ``State.a``
        # array holds the integer addresses into ``dae.x`` for that
        # state's per-device entries (so ``am.a[i]`` is the column in
        # ``dae.ts.x`` for the i-th PMU's am state).
        am_addrs: list[int] = []
        vm_addrs: list[int] = []
        if pmu is not None and pmu_idx_v:
            am_addrs = [int(a) for a in getattr(pmu.am, "a", [])]
            vm_addrs = [int(a) for a in getattr(pmu.vm, "a", [])]

        # Build the column header. Two columns per PMU: <idx>_am, <idx>_vm.
        header: list[str] = ["t"]
        for pidx in pmu_idx_v:
            header.append(f"{pidx}_am")
            header.append(f"{pidx}_vm")

        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow(header)

        x_matrix = getattr(ts, "x", None)
        # ``x`` shape: (n_steps, n_states). Empty when no TDS step has
        # fired (or the run was aborted at t=0). Either way ship the
        # header-only body and let the caller decide.
        n_steps = len(t_arr)
        for i in range(n_steps):
            row: list[str] = [f"{float(t_arr[i]):.10g}"]
            x_row = x_matrix[i] if x_matrix is not None and i < len(x_matrix) else None
            for j in range(len(pmu_idx_v)):
                am_val: float
                vm_val: float
                if (
                    x_row is not None
                    and j < len(am_addrs)
                    and j < len(vm_addrs)
                    and am_addrs[j] < len(x_row)
                    and vm_addrs[j] < len(x_row)
                ):
                    am_val = float(x_row[am_addrs[j]])
                    vm_val = float(x_row[vm_addrs[j]])
                else:
                    am_val = 0.0
                    vm_val = 0.0
                row.append(f"{am_val:.10g}")
                row.append(f"{vm_val:.10g}")
            writer.writerow(row)

        return buf.getvalue()
