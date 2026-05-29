# Per-route `_map_worker_error` audit (Unit 4a)

**Temporary.** Unit 4b migrates every route to `api/error_mapping.map_worker_error`
and DELETES this file. This is the CONTRACT Unit 4b must preserve: every status,
every extras shape, every per-route override below is load-bearing.

## How `WorkerError.category` is set (core/worker.py:1198-1265)

The worker re-raises across the Pipe as a `WorkerError(category, detail, extra=...)`.
`category` is **almost always** the `AndesAppError` subclass `__name__`, with three
exceptions:

| Source error                | wire `category`                         |
|-----------------------------|-----------------------------------------|
| `DisturbanceCommitError`    | `"disturbance-commit"` (hyphenated)     |
| `NoCaseLoadedError`         | `"no-case-loaded"` (hyphenated)         |
| `BundleValidationError`     | `"BundleValidationError:<sub-category>"`|
| any other `AndesAppError`   | `exc.__class__.__name__`                |
| any non-AndesAppError       | `"internal-error"` (last-resort `except Exception`) |

`ElementHasDependentsError` ships `extra={"dependents": [...], "total": N}`.
`BundleValidationError` ships `extra={"missing_fields": [...]}` when present.

## Shared-mapper design (error_mapping.py)

- `WORKER_ERROR_HTTP_MAP: dict[str, int]` keyed by **wire category** (class name
  OR the hyphenated aliases). Captures the **dominant/canonical** status per
  category. Per-route overrides (below) are NOT in the table — Unit 4b applies
  them at the call site (e.g. a `status=` kwarg on the migrated mapper).
- Recovery: resolve category -> `AndesAppError` subclass via a class-name
  registry built over the full hierarchy (`errors, session, bundle, report,
  snapshot, sweep, security/paths`), then read `cls.recovery_kind`. The class
  attribute is the single source of truth (cross-checked by the Unit 3
  reflection test). Hyphenated aliases + the `BundleValidationError:` composite
  are normalized to their class name first.
- `detail` is always a dict `{"detail": str, "recovery": descriptor|None, **extras}`
  so the `app.py` ProblemDetails handler lifts `recovery` onto the typed field
  and spreads the rest as extras.
- Unknown/unmapped category -> 500 + `log.error(...)` naming the category + NO
  recovery (no silent CTA). `BundleValidationError:<unknown-sub>` -> 422 (the
  bundle route keeps its own sub-category table; see below).

## Canonical category -> status (the table)

| wire category                  | status | recovery_kind (from class) |
|--------------------------------|--------|----------------------------|
| `no-case-loaded`               | 409    | load-case                  |
| `disturbance-commit`           | 409    | reload-case                |
| `SystemAlreadyLoadedError`     | 409    | reload-case                |
| `EigPrerequisiteError`         | 409    | run-pflow                  |
| `CpfPrerequisiteError`         | 409    | run-pflow                  |
| `SePrerequisiteError`          | 409    | run-pflow                  |
| `PflowNotConvergedError`       | 409    | None (no recovery_kind\*)  |
| `TdsNotRunError`               | 409    | None\*                     |
| `EigReportPrerequisiteError`   | 409    | None\*                     |
| `SnapshotCollisionError`       | 409    | None\*                     |
| `ElementNotFoundError`         | 404    | none                       |
| `SnapshotNotFoundError`        | 404    | None\*                     |
| `SetupFailedError`             | 422    | reload-case                |
| `EigDirtyDaeError`             | 422    | reload-case                |
| `EigComputationError`          | 422    | retry                      |
| `CpfDivergedError`             | 422    | retry                      |
| `SeNonConvergentError`         | 422    | retry                      |
| `SeUnderDeterminedError`       | 422    | add-measurements           |
| `ElementValidationError`       | 422    | none                       |
| `ElementHasDependentsError`    | 422    | none                       |
| `DisturbanceValidationError`   | 422    | none                       |
| `CaseLoadError`                | 422    | load-case                  |
| `SnapshotMetadataError`        | 422    | None\*                     |
| `SnapshotVersionMismatchError` | 422    | None\*                     |
| `SweepValidationError`†        | 422    | None\*                     |
| `ReportGenerationError`        | 500    | None\*                     |
| `internal-error` (unmapped)    | 500    | None                       |

\* These `AndesAppError` subclasses do NOT declare a `recovery_kind` (report.py
+ snapshot.py + sweep.py errors inherit the base `None`). They render without a
CTA — same UX as `"none"`. This is a known gap Unit 4b can leave as-is or
classify later; it is NOT a regression (the per-route helpers never emitted
recovery at all).

† `SweepValidationError` is NOT one of the audited 13 `_map_worker_error`
helpers and is NOT produced as a `WorkerError` wire category. `sweep.py:161`
catches it as a **live exception** (`except SweepValidationError`) and raises an
`HTTPException(422)` directly — it never crosses the worker Pipe as a category.
Its `WORKER_ERROR_HTTP_MAP` entry is therefore **forward-compat-only and
presently unreached**; it is kept so that, if a future worker path ever
re-raises it as a category, the canonical 422 is already pinned. A future
reviewer should not assume any route emits it through `map_worker_error`.

---

## Per-route helpers (the 13)

### 1. pflow.py:89 — `run_pflow`
- `no-case-loaded` -> 409 (detail verbatim)
- `SetupFailedError` -> 422, detail **appended** with `" — call POST /api/sessions/{id}/reload to recover."`
- `EigDirtyDaeError` -> 422 (detail verbatim; the reload hint is already in the wrapper detail)
- else -> 500 (`f"{category}: {detail}"`)
- **No extras.** No status override vs the table EXCEPT the appended-detail copy on `SetupFailedError`.

### 2. eig.py:182 — `run_eig` / mode endpoints (3 call sites)
- `no-case-loaded` -> 409
- `EigPrerequisiteError` -> 409
- `ElementNotFoundError` -> 404 (mode index out of range)
- `EigComputationError` -> 422
- `SetupFailedError` -> 422 + appended reload hint
- else -> 500
- **No extras.** Matches table.

### 3. cpf.py:204 — `run_cpf` / `run_cpf_qv` (2 call sites)
- `no-case-loaded` -> 409
- `CpfPrerequisiteError` -> 409
- `CpfDivergedError` -> 422
- `SetupFailedError` -> 422 + appended reload hint
- else -> 500
- **No extras.** Matches table.

### 4. se.py:174 — `run_se` / `generate_measurements` (2 call sites)
- `no-case-loaded` -> 409
- `SePrerequisiteError` -> 409
- `SeUnderDeterminedError` -> 422
- `SeNonConvergentError` -> 422
- `SetupFailedError` -> 422 + appended reload hint
- else -> 500
- **No extras.** Matches table.

### 5. tds.py:46 — `run_tds`
- `no-case-loaded` -> 409
- `SetupFailedError` -> 422 + appended reload hint
- else -> 500
- **No extras.** Matches table.

### 6. snapshot.py:138 — `export_bundle` (the BUNDLE-EXPORT helper, lives in snapshot.py)
- `no-case-loaded` -> 409
- `{ElementValidationError, CaseLoadError, AndesAppError}` -> 422, detail **appended** with `" — bundle export needs a roundtrip-capable case (reload to recover)."`
- else -> 500
- **OVERRIDE:** maps bare `AndesAppError` (category == `"AndesAppError"`) -> 422.
  The table has no `AndesAppError` key, so the shared mapper would 500 it. Unit 4b
  must pass an explicit `status=422` (or extend the per-call category set) for this route.
- **No extras.**

### 6b. snapshot.py:398 — `_map_snapshot_error` (snapshot save/restore/list/delete; NOT in the listed 13 but shares the module)
- `SnapshotNotFoundError` -> 404
- `SnapshotCollisionError` -> 409, detail **appended** with the force hint
- `{SnapshotMetadataError, SnapshotVersionMismatchError, SetupFailedError, DisturbanceValidationError}` -> 422
- `no-case-loaded` -> 409
- else -> 500
- **OVERRIDE (the plan's "422 vs 503" / "SetupFailedError differs by path"):**
  `SetupFailedError` -> **422** here (save-time ANDES failure), same as the table's
  422 default but reached via a different helper than the routine routes. The 503
  contrast is the APP-LEVEL `SweepInProgressError` handler (not a per-route helper).
- **No extras** (the dict-detail in the bundle-import helper is a different file; see #7).

### 7. bundle.py:153 — `import_bundle` (bundle-import side)
- `BundleValidationError:<sub>` -> **dict detail** `{"detail": str, "category": <sub>, "missing_fields": [...]?}`,
  status from `_BUNDLE_VALIDATION_STATUS`:
  - `corrupt-zip` -> 400
  - `oversize` -> 413
  - `manifest-missing | manifest-malformed | case-entry-missing | too-many-case-files | disturbances-malformed | bundle-blocked` -> 422
  - unknown sub -> 422 (fallback)
- `no-case-loaded` -> 409
- `{CaseLoadError, DisturbanceValidationError, ElementValidationError}` -> 422
- else -> 500
- **EXTRAS:** `category` (the bundle sub-category) + optional `missing_fields` list,
  embedded in a **dict** `detail`. The shared mapper supports arbitrary extras via
  the `extras=` kwarg, BUT the per-sub-category status table is bundle-specific —
  Unit 4b keeps `_BUNDLE_VALIDATION_STATUS` at the call site and passes the resolved
  status + `extras={"category": sub, "missing_fields": ...}`.
- **PRE-4b NOTE:** the shared mapper's default for `BundleValidationError:<sub>` is a
  flat 422; the bundle route MUST override status per sub-category (400/413/422). This
  is the one route whose extras+status shape does not fit the shared mapper's defaults
  and needs an explicit override path in 4b. Not a blocker — the `extras=` kwarg covers
  the body shape; only the status lookup stays route-local.

### 8. cases.py:101 — `load_case` / `reload` / `save` / `blank` (5 call sites)
- `no-case-loaded` -> 409
- `CaseLoadError` -> 422
- `SetupFailedError` -> 422 (detail verbatim — **NO appended reload hint** here, unlike pflow/eig/cpf/se/tds)
- else -> 500
- **No extras.** Minor copy difference (no appended hint) vs the routine routes — cosmetic, detail-string only.

### 9. elements.py:100 — add/edit/delete/undo elements (6 call sites)
- `{disturbance-commit, SetupFailedError}` -> **409** + appended `" — call POST /api/sessions/{id}/reload to return to pre-setup state."`
- `SystemAlreadyLoadedError` -> 409
- `no-case-loaded` -> 409
- `ElementNotFoundError` -> 404
- `{ElementValidationError, DisturbanceValidationError, CaseLoadError, ElementHasDependentsError}` -> 422 (detail verbatim)
- else -> 500
- **OVERRIDE:** `SetupFailedError` -> **409** here (pre-setup gate semantics), vs the
  table's 422. Unit 4b must pass `status=409` for the elements mutation routes.
- **EXTRAS — the DELETE path (delete_element, elements.py:529-545):** `ElementHasDependentsError`
  is handled **BEFORE** `_map_worker_error` and does NOT go through it. It builds a
  **`DeleteBlockedResponse`** (NOT `ProblemDetails`) returned as a raw `JSONResponse(422,
  body.model_dump())` with shape `{"dependents": [TopologyEntry...], "total": int}`
  (dependents capped at 25). Read from `exc.extra["dependents"]` / `exc.extra["total"]`.
  **This is the canonical extras shape** the plan calls out. Unit 4b: this route keeps
  its bespoke `DeleteBlockedResponse` branch (it is a 200-style typed body, not an error
  envelope) — the shared mapper's `extras={"dependents":..., "total":...}` path covers
  the *other* (non-DELETE) call sites where `ElementHasDependentsError` -> plain 422.

### 10. disturbances.py:69 — `add_disturbances`
- `disturbance-commit` -> 409 + appended reload hint
- `no-case-loaded` -> 409
- `{DisturbanceValidationError, CaseLoadError}` -> 422
- else -> 500
- **No extras.** Matches table.

### 11. pmu.py:137 — PMU add/list/delete/export (4 call sites)
- `no-case-loaded` -> 409
- `disturbance-commit` -> 409 + appended reload hint
- `SetupFailedError` -> **409** (PMU CSV export: TDS not run yet)
- `ElementNotFoundError` -> 404
- `{ElementValidationError, ElementHasDependentsError}` -> 422
- else -> 500
- **OVERRIDE:** `SetupFailedError` -> **409** here, vs the table's 422. Unit 4b must
  pass `status=409` for the PMU routes.
- **No extras** (`ElementHasDependentsError` -> plain 422, no dependents body on PMU).

### 12. profiles.py:211 — TimeSeries upload/add/list/delete (4 call sites)
- `no-case-loaded` -> 409
- `disturbance-commit` -> 409 + appended reload hint
- `ElementNotFoundError` -> 404
- `{ElementValidationError, ElementHasDependentsError}` -> 422
- `SetupFailedError` -> **500** (file write failure)
- else -> 500
- **OVERRIDE:** `SetupFailedError` -> **500** here, vs the table's 422. Unit 4b must
  pass `status=500` for the profiles routes.
- **No extras.**

### 13. reports.py:128 — `get_report`
- `no-case-loaded` -> 409
- `{PflowNotConvergedError, TdsNotRunError, EigReportPrerequisiteError}` -> 409 (detail verbatim, UI empty-state copy)
- `ReportGenerationError` -> 500
- else -> 500
- **No extras.** Matches table.

---

## Summary of overrides Unit 4b must carry at the call site

| route        | category            | per-route status | vs table |
|--------------|---------------------|------------------|----------|
| snapshot(export) | `AndesAppError` | 422              | (not in table -> 500) |
| elements     | `SetupFailedError`  | 409              | 422      |
| pmu          | `SetupFailedError`  | 409              | 422      |
| profiles     | `SetupFailedError`  | 500              | 422      |
| bundle(import) | `BundleValidationError:*` | 400/413/422 per sub | flat 422 |

## Detail-string differences (cosmetic; not status)

- pflow/eig/cpf/se/tds: `SetupFailedError` detail gets `" — call POST .../reload to recover."`
- elements/disturbances/pmu/profiles: `disturbance-commit` (+ elements `SetupFailedError`)
  detail gets `" — call POST .../reload to return to pre-setup state."`
- cases: `SetupFailedError` detail VERBATIM (no hint appended).
- snapshot(export): the 422 bucket detail gets `" — bundle export needs a roundtrip-capable case (reload to recover)."`
- snapshot(restore): `SnapshotCollisionError` detail gets the `force=true` hint.

These are detail-copy variations the shared mapper preserves by passing the
worker `detail` verbatim; Unit 4b reproduces the appended hints at the call site
(or folds them into the wrapper-side detail). They do NOT affect status or recovery.

## Extras shapes the shared mapper must support

1. `ElementHasDependentsError`: `{"dependents": list[TopologyEntry-dict], "total": int}`
   — but on the DELETE route this is a `DeleteBlockedResponse` body, NOT a ProblemDetails
   extra. On other routes it's a plain 422 with no body extras. The shared
   `map_worker_error(..., extras=...)` kwarg covers the generic case.
2. `BundleValidationError`: `{"category": <sub>, "missing_fields"?: list[str]}` in a
   dict detail. Covered by the `extras=` kwarg; the status lookup stays route-local.
