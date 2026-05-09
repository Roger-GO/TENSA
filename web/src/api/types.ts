/**
 * Project-narrowed API types.
 *
 * Re-exports the codegen-shaped schemas from `generated.ts` under stable,
 * import-friendly names AND adds hand-authored branded types
 * (`SessionId`, `RunId`, `WorkspacePath`) so a string that has flowed
 * through `parseSessionId` is structurally distinct from "any string".
 *
 * The brands are nominal (a phantom field unique per brand). `parseSessionId`
 * is the only sanctioned construction site; everywhere else, accept the
 * branded type so the compiler enforces the boundary check happened.
 *
 * Per Unit 5 plan + key tech decision: openapi-typescript produces
 * structural types only, so brands belong here, not in `generated.ts`.
 */
import type { components } from './generated';

// ---- re-exports ------------------------------------------------------------

export type ProblemDetails = components['schemas']['ProblemDetails'];

export type SessionDescriptor = components['schemas']['SessionDescriptor'];
export type SessionList = components['schemas']['SessionList'];

export type LoadCaseRequest = components['schemas']['LoadCaseRequest'];
export type TopologyEntry = components['schemas']['TopologyEntry'];
export type TopologySummary = components['schemas']['TopologySummary'];

export type PflowRunRequest = components['schemas']['PflowRunRequest'];
export type PflowResult = components['schemas']['PflowResult'];
export type LineFlow = components['schemas']['LineFlow'];

export type WorkspaceFile = components['schemas']['WorkspaceFile'];
export type WorkspaceFileList = components['schemas']['WorkspaceFileList'];
export type SidecarLayout = components['schemas']['SidecarLayout'];
export type BusCoord = components['schemas']['BusCoord'];

export type AddElementRequest = components['schemas']['AddElementRequest'];
export type EditElementRequest = components['schemas']['EditElementRequest'];
export type ElementCreated = components['schemas']['ElementCreated'];
export type BlankSystemResponse = components['schemas']['BlankSystemResponse'];
/**
 * Successful body of ``DELETE /sessions/{id}/elements/{model}/{idx}``.
 * Transparent alias for ``TopologySummary`` — the substrate returns the
 * post-delete topology snapshot so the client can refresh without an
 * extra GET round-trip. Aliased here for self-documenting call sites.
 */
export type DeleteElementResponse = TopologySummary;
/**
 * 422 body of ``DELETE /sessions/{id}/elements/{model}/{idx}`` when the
 * deletion is blocked by cascade dependents. ``dependents`` is capped at
 * 25 entries; ``total`` reports the full count for the truncation footer.
 */
export type DeleteBlockedResponse = components['schemas']['DeleteBlockedResponse'];
export type TopologySchema = components['schemas']['TopologySchema'];
export type TopologyParamMeta = components['schemas']['TopologyParamMeta'];
export type SaveCaseRequest = components['schemas']['SaveCaseRequest'];
export type SaveCaseResponse = components['schemas']['SaveCaseResponse'];
export type GeneratorOutput = components['schemas']['GeneratorOutput'];
export type LoadConsumption = components['schemas']['LoadConsumption'];
/** ANDES param value types in API request/response payloads. */
export type ParamValue = number | string | boolean;

// ---- TDS run lifecycle (Unit 7 — abort + disturbance commit + reset) -----

/**
 * Request body for ``POST /sessions/{id}/disturbances``. Re-export of the
 * codegen type under a stable alias so Unit 7 call sites don't have to
 * dig into the generated tree.
 */
export type AddDisturbancesRequest = components['schemas']['AddDisturbancesRequest'];
/** Response body for ``POST /sessions/{id}/disturbances``. */
export type AddDisturbancesResponse = components['schemas']['AddDisturbancesResponse'];
/** One ack entry returned by the disturbance commit endpoint. */
export type DisturbanceAck = components['schemas']['DisturbanceAck'];

/**
 * Response body for ``POST /sessions/{id}/abort`` (Unit 1b endpoint).
 *
 * The substrate-side ``AbortResponse`` schema is defined in
 * ``server/src/andes_app/api/schemas.py`` but the web ``generated.ts`` was
 * regenerated before Unit 7 landed. Hand-authored here so Unit 7 doesn't
 * block on a codegen sweep; the field shape is identical and a one-to-one
 * alias substitution will work when codegen is re-run.
 */
export interface AbortResponse {
  /**
   * Always ``true`` on a successful response. The actual TDS exit happens
   * cooperatively at the next ``callpert`` tick on the worker — the WS
   * stream emits the terminal ``done`` message with ``final_t < tf`` once
   * the integration loop exits.
   */
  aborted: true;
}

// ---- disturbance specs (Unit 6 — mirrors substrate's discriminated union) --

/**
 * Substrate's ``FaultSpec`` (``server/src/andes_app/core/disturbance.py``).
 * Re-exported under a stable name so consumers don't have to dig into the
 * generated tree. The generated type is the canonical shape; this is a
 * named alias only.
 */
export type FaultSpec = components['schemas']['FaultSpec'];
export type ToggleSpec = components['schemas']['ToggleSpec'];
export type AlterSpec = components['schemas']['AlterSpec'];
/** Discriminated union over the three disturbance variants — mirrors the substrate. */
export type DisturbanceSpec = FaultSpec | ToggleSpec | AlterSpec;

/**
 * Response body for ``GET /sessions/{id}/topology/models/{model}/alterable_params``
 * (Unit 1b endpoint).
 *
 * The OpenAPI spec on the substrate side already defines this (see
 * ``server/src/andes_app/api/schemas.py:AlterableParamsResponse``), but the
 * web ``generated.ts`` is regenerated out-of-band. Defined here as a
 * hand-authored type so Unit 6 can land before the next codegen sweep
 * without blocking on the regen step. When ``generated.ts`` is regenerated
 * the codegen-shaped type can replace this alias one-to-one
 * (the field shape is identical).
 */
export interface AlterableParamsResponse {
  /** ANDES model class name the params belong to (echoed back from the path). */
  model: string;
  /**
   * Ordered list of parameter names that ``ss.<model>.alter(src=...)`` will
   * accept. Order matches ANDES's internal declaration order. Empty when
   * the model has no alterable params.
   */
  params: string[];
}

// ---- EIG result (Unit 6 — eigenvalue analysis) ---------------------------

/**
 * JSON-friendly complex number ``{real, imag}``. Mirrors the substrate's
 * :class:`andes_app.core.eig_result.ComplexNumber` 1:1. Each ANDES
 * eigenvalue (``EIG.mu[i]``) is split this way for transport so the
 * JSON payload doesn't need an out-of-band complex encoding.
 */
export interface ComplexNumber {
  real: number;
  imag: number;
}

/**
 * One per-state participation factor row entry, returned by
 * ``GET /sessions/{id}/eig/modes/{mode_idx}/participation``.
 *
 * ``factor`` is a real-valued participation magnitude by ANDES
 * convention (see ``calc_pfactor`` in ``routines/eig.py``).
 */
export interface ParticipationFactor {
  state_name: string;
  factor: number;
}

/**
 * EIG (eigenvalue analysis) result returned by ``POST /sessions/{id}/eig``.
 *
 * The state matrix itself (``As``) is intentionally omitted — for NPCC
 * 140-bus it would be ~110k entries. UI fetches it on demand via
 * ``GET /eig/state-matrix.mat``.
 *
 * Per Unit 1a spike: ``mode_count`` is the *reduced* state count
 * (post fold/elimination), not ``dae.n``. Stock IEEE 14 → 0; full
 * IEEE 14 + dyr → 62; kundur_full → 52.
 *
 * ``tds_initialized`` is always ``true`` after a successful EIG.run —
 * the UI surfaces an info banner per Unit 6's Approach addendum so
 * users know the dynamic state has been initialised as a side effect.
 */
export interface EigResult {
  eigenvalues: ComplexNumber[];
  damping_ratios: number[];
  frequencies_hz: number[];
  mode_count: number;
  state_count: number;
  state_names: string[];
  tds_initialized: boolean;
}

/**
 * Wire shape of ``GET /sessions/{id}/eig/modes/{mode_idx}/participation``.
 */
export interface EigParticipationResponse {
  mode_idx: number;
  participation: ParticipationFactor[];
}

// ---- CPF result (Unit 12 — continuation power flow) ----------------------

/**
 * CPF (continuation power flow) result returned by
 * ``POST /sessions/{id}/cpf`` and ``POST /sessions/{id}/cpf/qv``.
 *
 * Mirrors :class:`andes_app.core.cpf_result.CpfResult` 1:1.
 *
 * Field semantics (per Unit 1a spike):
 *
 * - ``lambdas`` — per-step continuation parameter values. For PV-curve
 *   runs (``mode === 'pv'``) this is ``CPF.lam`` (lambda); for QV-curve
 *   runs (``mode === 'qv'``) it's ``CPF.qv_q`` (reactive injection).
 *   The chart's X-axis label switches based on ``mode``.
 * - ``voltages_per_bus`` — mapping ``bus_idx -> [V0, V1, ...]``,
 *   index-aligned with ``lambdas``. PV runs include all buses; QV runs
 *   include only the requested bus.
 * - ``bus_idxes`` — ordered list of bus idxes (stringified) matching
 *   the canonical render order. Surfaced separately so the UI doesn't
 *   rely on dict-key iteration order.
 * - ``nose_idx`` — index into ``lambdas`` where lambda is maximised
 *   (the nose / voltage-collapse margin). ``-1`` when truncated.
 * - ``max_lam`` — peak lambda value reached. Always populated.
 * - ``truncated`` — ``true`` when the run terminated without finding a
 *   nose point. UI surfaces the truncation note from ``done_msg``.
 * - ``done_msg`` — ANDES's terminal status string (e.g.,
 *   ``"Nose point at lambda=3.258046"``,
 *   ``"Reached max steps (5)"``).
 * - ``mode`` — ``"pv"`` for the full sweep, ``"qv"`` for single-bus.
 */
export interface CpfResult {
  lambdas: number[];
  voltages_per_bus: Record<string, number[]>;
  bus_idxes: string[];
  nose_idx: number;
  max_lam: number;
  truncated: boolean;
  done_msg: string;
  mode: 'pv' | 'qv';
}

// ---- SE result (Unit 13 — state estimation) ------------------------------

/**
 * SE (state estimation) result returned by ``POST /sessions/{id}/se``.
 *
 * Mirrors :class:`andes_app.core.se_result.SeResult` 1:1.
 *
 * Field semantics (per Unit 1a spike + ANDES SE.run output):
 *
 * - ``converged`` — ``true`` when ANDES's ``SE.run`` returned True.
 *   ``false`` cases surface as 422 errors rather than ``converged=false``
 *   payloads, so the UI always sees a converged result on a 200.
 * - ``iterations`` — WLS Gauss-Newton iterations to convergence.
 * - ``mismatch`` — final WLS objective ``J = sum(w * r^2)``. Smaller
 *   is better; UI surfaces it as the headline "mismatch" stat.
 * - ``residuals`` — per-measurement residuals ``z - h(x_est)``. The UI
 *   bins these into a histogram.
 * - ``measurement_count`` — ``len(residuals)``. Includes the angle-
 *   reference pseudo-measurement that ``SE.init`` injects per island.
 * - ``flagged_indices`` — indices into ``residuals`` whose normalised
 *   residual ``|r_i| / sigma_i`` exceeds 3-sigma. UI highlights the
 *   corresponding histogram bars in red.
 */
export interface SeResult {
  converged: boolean;
  iterations: number;
  mismatch: number;
  residuals: number[];
  measurement_count: number;
  flagged_indices: number[];
}

/**
 * Wire shape of ``POST /sessions/{id}/se/measurements/generate``.
 *
 * ``count`` is the number of scalar measurements before SE.init's
 * angle-reference injection; the eventual ``SeResult.measurement_count``
 * will be larger by 1 per island.
 */
export interface SeMeasurementsGeneratedResponse {
  count: number;
}

// ---- branded types ---------------------------------------------------------

/**
 * A session id returned by `POST /sessions`. Use `parseSessionId` to mint
 * one from a raw server response; everywhere else, accept `SessionId`
 * directly so the compiler proves the parse happened.
 */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** A PF run id returned by `POST /sessions/{id}/pflow`. */
export type RunId = string & { readonly __brand: 'RunId' };

/**
 * A workspace-relative path the user has selected. Path-canonicalization
 * lives on the server; this brand only enforces "non-empty + no `..`
 * segment" as a fast client-side guard before the request is even sent.
 */
export type WorkspacePath = string & { readonly __brand: 'WorkspacePath' };

// ---- parse wrappers --------------------------------------------------------

export function parseSessionId(s: string): SessionId {
  if (!s) throw new TypeError('empty session id');
  return s as SessionId;
}

export function parseRunId(s: string): RunId {
  if (!s) throw new TypeError('empty run id');
  return s as RunId;
}

export function parseWorkspacePath(s: string): WorkspacePath {
  if (!s) throw new TypeError('empty workspace path');
  // Defense in depth: the server canonicalizes too, but a fast client-side
  // reject of obvious traversal saves a round-trip and surfaces UI errors
  // sooner. We do NOT attempt full canonicalization here.
  if (s.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new TypeError(`workspace path contains '..' segment: ${s}`);
  }
  return s as WorkspacePath;
}
