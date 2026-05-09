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
