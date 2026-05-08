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
