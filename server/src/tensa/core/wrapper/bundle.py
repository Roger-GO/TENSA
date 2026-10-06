"""Reproducibility bundle import."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tensa.core.case_events import event_from_spec
from tensa.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec
from tensa.core.errors import DisturbanceValidationError, NoCaseLoadedError
from tensa.core.wrapper.case import CaseMixin


class BundleMixin(CaseMixin):
    """Import a reproducibility bundle: its case, then its disturbances."""

    def import_bundle(  # noqa: C901
        self,
        zip_bytes: bytes,
        *,
        force_resolve: bool = False,
        use_bundle_case: bool = True,
        accept_version_mismatch: bool = True,
    ) -> dict[str, Any]:
        """Import a reproducibility bundle — Unit 10.

        Two-phase orchestration:

        1. :func:`validate_bundle` decodes the manifest, verifies the
           case file is present, computes any conflicts (sha mismatch,
           ANDES version mismatch, addfile missing). If conflicts exist
           and ``force_resolve=False``, returns a plan dict so the
           route layer can short-circuit with a 409 + the conflict
           list for the UI to render.
        2. When ``force_resolve=True`` (or no conflicts surfaced):
           :func:`extract_bundle` writes the case file(s) into the
           workspace honouring the resolution choices, then
           :meth:`load_case` boots the new System and
           :meth:`add_disturbance` replays the bundle's disturbance
           list via the same path Unit 6.5's ``replay_disturbances``
           uses (one ``ss.add(...)`` per spec on a fresh pre-setup
           System).

        Returns a dict with keys:

        - ``status``: ``"plan"`` (conflicts surfaced; nothing committed)
          or ``"committed"`` (case + disturbances loaded successfully).
        - ``plan``: serialised :class:`BundleImportPlan` (always
          present, so the UI can echo manifest metadata even on commit).
        - ``warnings``: list of free-form strings from the extraction +
          replay steps. Populated on commit; empty on plan.
        - ``case_filename``, ``addfile_filenames``: post-commit only.
        - ``disturbances_replayed``: post-commit only; count of specs
          successfully re-applied to the new System.
        - ``layout_restored``: post-commit only; whether the bundle held a
          diagram layout that is now saved beside the case.
        """
        from tensa.core.bundle import (
            BundleResolveChoices,
            bundle_plan_to_dict,
            extract_bundle,
            read_bundle_disturbances,
            validate_bundle,
        )

        if self._workspace is None:
            raise NoCaseLoadedError(
                "bundle import requires a workspace; the substrate "
                "was launched without one"
            )

        import andes  # heavy import — kept lazy

        current_andes = str(getattr(andes, "__version__", "unknown"))
        plan = validate_bundle(
            zip_bytes,
            workspace=self._workspace,
            current_andes_version=current_andes,
        )

        plan_dict = bundle_plan_to_dict(plan)

        # Plan-only branch: surface the conflicts so the UI's
        # BundleConflictResolver can render the side-by-side diff.
        if plan.has_conflicts and not force_resolve:
            return {
                "status": "plan",
                "plan": plan_dict,
                "warnings": [],
            }

        # Commit branch — never reached when blocked even with
        # force_resolve, because extract_bundle re-checks ``plan.blocked``
        # and raises BundleValidationError("bundle-blocked") which the
        # worker boundary turns into a 422.
        resolve = BundleResolveChoices(
            use_bundle_case=use_bundle_case,
            accept_version_mismatch=accept_version_mismatch,
        )
        extraction = extract_bundle(
            zip_bytes,
            workspace=self._workspace,
            resolve=resolve,
            plan=plan,
        )

        primary_path = Path(extraction["primary_path"])
        addfile_paths = [Path(p) for p in extraction["addfile_paths"]]
        warnings = list(extraction.get("warnings") or [])

        # Hand off to load_case — it resets disturbance log + replay
        # buffer + se measurements (the contract documented at
        # load_case's docstring), so we replay disturbances AFTER.
        load_addfiles: list[str | Path] | None = (
            [Path(p) for p in addfile_paths] if addfile_paths else None
        )
        self.load_case(primary_path, addfiles=load_addfiles)

        replay_specs = read_bundle_disturbances(zip_bytes)
        replayed = 0
        for raw in replay_specs:
            kind = raw.get("kind")
            if kind == "fault":
                spec: DisturbanceSpec = FaultSpec(**raw)
            elif kind == "toggle":
                spec = ToggleSpec(**raw)
            elif kind == "alter":
                spec = AlterSpec(**raw)
            else:
                # Should be unreachable — read_bundle_disturbances rejects
                # unknown kinds at the validator boundary. Belt-and-braces.
                warnings.append(
                    f"skipped disturbance with unknown kind: {kind!r}"
                )
                continue
            try:
                self.add_disturbance(spec)
                replayed += 1
                self._restored_events.append(event_from_spec(spec))
            except DisturbanceValidationError as exc:
                # ANDES rejected the spec on the new System (e.g., bus
                # idx no longer present after a case-level edit). We
                # surface as a warning rather than aborting the import
                # — the user has the case loaded and can review the
                # disturbance list inline.
                warnings.append(
                    f"disturbance {raw} rejected on new System: {exc}"
                )

        return {
            "status": "committed",
            "plan": plan_dict,
            "warnings": warnings,
            "case_filename": primary_path.name,
            "addfile_filenames": [p.name for p in addfile_paths],
            "disturbances_replayed": replayed,
            "layout_restored": bool(extraction.get("layout_restored", False)),
        }
