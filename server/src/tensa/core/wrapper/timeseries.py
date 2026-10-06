"""TimeSeries profiles."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tensa.core.errors import ElementValidationError, NoCaseLoadedError, SetupFailedError
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.elements import ElementsMixin
from tensa.core.wrapper.results import TopologyEntry
from tensa.core.wrapper.topology import _collect_models


class TimeseriesMixin(ElementsMixin):
    """TimeSeries profiles: upload a profile file and schedule a device's
    parameters from it."""

    # ----- TimeSeries profiles (Unit 15) -----
    #
    # Workflow: the user uploads an xlsx (or csv) hourly profile, the
    # substrate writes it under ``<workspace>/profiles/<uuid>.xlsx``,
    # then the user assigns the profile to a target device via
    # ``add_timeseries`` which calls ``ss.add('TimeSeries', ...)`` while
    # the System is still pre-setup. ANDES's ``TimeSeries`` model reads
    # the file at ``setup()`` time (see ``andes/models/timeseries.py``
    # ``list2array``), which is why the file MUST be on disk before
    # setup commits — we validate existence at add time so the user
    # gets a clean 422 instead of a setup-time crash.
    #
    # Mode constraint per the Unit 1a spike: ``apply_interpolate``
    # raises ``NotImplementedError`` (line 230 of timeseries.py) so the
    # substrate accepts only ``mode=1`` (exact-match step times). The
    # route layer rejects mode=2 with 422 + actionable hint.

    def upload_profile(
        self, filename: str, content_bytes: bytes
    ) -> str:
        """Persist an uploaded CSV/XLSX profile to ``<workspace>/profiles/``.

        Returns the absolute path of the written xlsx file. CSV uploads
        are transcoded to xlsx (single sheet named ``profile``) using
        openpyxl so ANDES's ``TimeSeries`` reader (which only handles
        xlsx/xls/csv but the substrate canonicalises to xlsx for
        consistency) sees a uniform input.

        ``filename`` is the original upload filename — used only to
        detect the ``.csv`` vs ``.xlsx`` extension. The on-disk filename
        is a fresh uuid to avoid collisions across uploads.

        Raises ``ElementValidationError`` on a malformed payload (CSV
        parse failure, openpyxl write failure, unsupported extension).
        Raises ``NoCaseLoadedError`` (→ 409) when the substrate was
        launched without a workspace — the route layer surfaces a
        "workspace not configured" hint.
        """
        import csv as _csv
        import io
        import uuid

        if self._workspace is None:
            raise NoCaseLoadedError(
                "profile upload requires a workspace; the substrate "
                "was launched without one"
            )
        ext = Path(filename).suffix.lower()
        if ext not in (".csv", ".xlsx"):
            raise ElementValidationError(
                f"unsupported profile extension {ext!r}; "
                "only .csv and .xlsx are accepted"
            )

        profiles_dir = self._workspace / "profiles"
        try:
            profiles_dir.mkdir(mode=0o700, exist_ok=True)
        except OSError as exc:
            raise SetupFailedError(
                f"failed to create profiles directory: "
                f"{_sanitize_message(str(exc))}"
            ) from exc
        target = profiles_dir / f"{uuid.uuid4().hex}.xlsx"

        if ext == ".xlsx":
            try:
                target.write_bytes(content_bytes)
            except OSError as exc:
                raise SetupFailedError(
                    f"failed to write profile file: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
        else:
            # CSV → XLSX via openpyxl. Single-sheet workbook named
            # "profile" so the ``add_timeseries(sheet=...)`` argument
            # has a stable default the UI can pre-fill.
            try:
                import openpyxl  # type: ignore[import-untyped,unused-ignore]
            except ImportError as exc:  # pragma: no cover — listed in deps
                raise SetupFailedError(
                    "openpyxl is required for CSV profile transcoding "
                    "but is not installed"
                ) from exc
            try:
                text = content_bytes.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise ElementValidationError(
                    f"profile CSV is not UTF-8 decodable: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            try:
                reader = _csv.reader(io.StringIO(text))
                rows = list(reader)
            except _csv.Error as exc:
                raise ElementValidationError(
                    f"profile CSV parse failed: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            if not rows:
                raise ElementValidationError(
                    "profile CSV is empty; need at least a header row"
                )
            wb = openpyxl.Workbook()
            ws = wb.active
            assert ws is not None
            ws.title = "profile"
            for row in rows:
                # Best-effort numeric coercion so xlsx cells aren't all
                # strings — pandas (which ANDES uses to read xlsx) will
                # round-trip the right dtypes when we hand it real
                # numbers.
                coerced: list[Any] = []
                for cell in row:
                    try:
                        coerced.append(float(cell))
                    except (TypeError, ValueError):
                        coerced.append(cell)
                ws.append(coerced)
            try:
                wb.save(str(target))
            except OSError as exc:
                raise SetupFailedError(
                    f"failed to write transcoded profile xlsx: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc

        return str(target)

    def add_timeseries(
        self,
        *,
        profile_path: str,
        sheet: str,
        fields: str,
        model: str,
        dev: int | str,
        dests: str,
        tkey: str = "t",
        mode: int = 1,
    ) -> TopologyEntry:
        """Add a TimeSeries device that schedules ``model.dev``'s
        ``dests`` from columns of ``profile_path`` keyed by ``tkey`` —
        Unit 15.

        Pre-conditions:
        - A case must be loaded; ANDES requires the System to exist
          before ``ss.add('TimeSeries', ...)``.
        - The profile file MUST already exist at ``profile_path`` (the
          ``upload_profile`` flow puts it under
          ``<workspace>/profiles/``). ANDES's ``list2array`` reads the
          file during setup; an absent file causes a setup-time
          ``FileNotFoundError`` that the substrate would have to map
          back to 422 anyway. We pre-validate so the failure happens
          synchronously at add time.
        - ``mode`` must be 1 (exact). Mode 2 (interpolated) raises
          ``NotImplementedError`` inside ANDES (verified per Unit 1a
          spike). The route layer rejects mode=2 at the schema before
          reaching the wrapper, but the gate here is the second line
          of defence.
        - The session must be pre-setup. Same gate as ``add_pmu`` /
          ``add_disturbance``.

        On success the call is recorded in ``self._edit_log`` so
        the TimeSeries survives a blank-session ``reload_case`` cycle
        (Unit 6.5 disturbance-replay parity for non-disturbance
        ``ss.add`` calls).
        """
        ss = self._require_editable()
        self._require_room_in_edit_log()
        if int(mode) != 1:
            raise ElementValidationError(
                "TimeSeries mode=2 (interpolated) raises NotImplementedError "
                "in ANDES (verified per Unit 1a spike); use mode=1 (exact)."
            )

        path_obj = Path(profile_path)
        if not path_obj.exists():
            raise ElementValidationError(
                f"profile file does not exist at {profile_path!r}; "
                "upload it first via POST /sessions/{id}/profiles/upload"
            )
        # The substrate only writes profile files under
        # ``<workspace>/profiles/``. Reject attempts to point at files
        # outside the workspace so a malicious payload can't trick the
        # wrapper into reading arbitrary user files at setup time.
        if self._workspace is not None:
            try:
                resolved = path_obj.resolve()
                workspace_resolved = self._workspace.resolve()
                resolved.relative_to(workspace_resolved)
            except (OSError, ValueError) as exc:
                raise ElementValidationError(
                    f"profile path is outside the workspace: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc

        # Pre-validate the target model + device exists so the user
        # sees an actionable 422 rather than ANDES's opaque "device
        # not exist" later.
        target_model_obj = getattr(ss, model, None)
        if target_model_obj is None:
            raise ElementValidationError(
                f"target model {model!r} not present on the loaded System"
            )
        target_idx_var = getattr(target_model_obj, "idx", None)
        target_idx_values = list(
            getattr(target_idx_var, "v", []) if target_idx_var is not None else []
        )
        dev_str = str(dev)
        resolved_dev: int | str | None = None
        for value in target_idx_values:
            if str(value) == dev_str:
                resolved_dev = value
                break
        if resolved_dev is None:
            raise ElementValidationError(
                f"no {model} with idx={dev!r} on the loaded System; "
                "TimeSeries needs an existing target device"
            )

        params: dict[str, Any] = {
            "mode": int(mode),
            "path": str(path_obj),
            "sheet": str(sheet),
            "fields": str(fields),
            "tkey": str(tkey),
            "model": str(model),
            "dev": resolved_dev,
            "dests": str(dests),
        }
        replay_snapshot = dict(params)
        try:
            new_idx = ss.add("TimeSeries", params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected TimeSeries add: "
                f"{_sanitize_message(str(exc))}"
            ) from exc

        # Record into the edit log so blank-session reload-and-replay
        # carries the TimeSeries (parity with PMU / add_element).
        self._record_add("TimeSeries", replay_snapshot, new_idx)

        entry = self._lookup_topology_entry("TimeSeries", new_idx)
        if entry is None:
            raise ElementValidationError(
                f"ANDES accepted TimeSeries add but no device with "
                f"idx={new_idx!r} was found on read-back"
            )
        return entry

    def list_timeseries(self) -> list[TopologyEntry]:
        """Return every TimeSeries instance currently on the loaded
        System — Unit 15.

        Empty list when none have been added. Reads via
        ``_collect_models`` so works pre- or post-setup.
        """
        ss = self._require_loaded()
        return _collect_models(ss, ["TimeSeries"])

    def delete_timeseries(self, idx: int | str) -> None:
        """Remove a TimeSeries, whether :meth:`add_timeseries` added it or
        the case file brought it — Unit 15.

        Same pre-setup gate as ``delete_element``. Implementation
        delegates to ``delete_element`` so the edit log and its
        reload-and-replay machinery are shared. Nothing names a
        TimeSeries, so the walk for dependents finds none.

        Raises ``ElementNotFoundError`` (→ 404) when no TimeSeries
        with that idx exists; ``DisturbanceCommitError`` (→ 409) when
        setup is committed.
        """
        self.delete_element("TimeSeries", idx)
