/**
 * Shared recovery-action descriptor (v3.1 Phase 3, Unit 7).
 *
 * ONE shape, two producers:
 *
 * 1. **Readiness preconditions** (`useRunReadiness`) — the gate computes a
 *    proactive recovery a user can take *before* clicking a disabled Run
 *    button (e.g. "Reload case" when EIG mutated the dae state).
 * 2. **Post-error recoveries** (`ProblemDetailsError.recovery`) — the
 *    substrate attaches a typed `{kind, label}` descriptor to every 4xx/5xx
 *    ProblemDetails body so the client can offer the exact recovery CTA
 *    (`server/src/tensa/api/schemas.py::RecoveryDescriptor`).
 *
 * Before Unit 7 these were two divergent local unions
 * (`useRunReadiness.RecoveryAction` vs the wire's `RecoveryKind`). Sharing
 * the type here means the SINGLE error primitive
 * (`<ProblemDetailsErrorSurface>` / `<RecoveryActionButton>`) routes both
 * sources through the same switch.
 *
 * `RecoveryKind` mirrors the substrate's `RecoveryKind` Literal 1:1. The
 * union is closed for exhaustiveness checks, but the client treats any
 * value it does not recognise (forward-compat: the server adds a kind the
 * web build predates) as "render the label as plain text, no side effect" —
 * see `RecoveryActionButton`.
 */

/**
 * Machine-readable discriminator for a recovery call-to-action. Mirrors
 * `tensa.api.schemas.RecoveryKind` exactly.
 *
 * - `load-case` — no case loaded; focus the case picker.
 * - `reload-case` — re-parse the case (clears EIG-induced dae mutation,
 *   `SetupFailed`, etc.) so the routine can re-run.
 * - `run-pflow` — the routine needs a converged operating point first;
 *   select the PF run mode.
 * - `retry` — re-run the failed mutation (variables come from the
 *   `JobRecord.request_summary`, Unit 6).
 * - `add-measurements` — SE needs measurements; open the SE affordance.
 * - `none` — considered but no canonical action; render NO CTA.
 * - `wait-for-job` — an op is already in flight; focus the Activity panel.
 * - `wait-for-sweep` — a sweep holds the session lock; focus the Activity
 *   panel.
 *
 * The first eight kinds mirror `tensa.api.schemas.RecoveryKind` 1:1
 * (the wire shape attached to post-error ProblemDetails bodies). `open-pf`
 * is a READINESS-ONLY kind the substrate never emits — `useRunReadiness`
 * surfaces it proactively for the "Run PFlow first" precondition; the
 * router treats it identically to the wire's `run-pflow` (both select the
 * PF run mode). Keeping it in the shared union lets readiness preconditions
 * and post-error recoveries flow through the SAME `RecoveryDescriptor`.
 */
export type RecoveryKind =
  | 'load-case'
  | 'reload-case'
  | 'run-pflow'
  | 'retry'
  | 'add-measurements'
  | 'none'
  | 'wait-for-job'
  | 'wait-for-sweep'
  // readiness-only (never on the wire)
  | 'open-pf';

/**
 * A recovery call-to-action. `kind` is the stable discriminator the UI keys
 * off; `label` is the human-facing button copy. Both readiness preconditions
 * and post-error recoveries produce this shape.
 *
 * Forward-compat: the wire may carry a `kind` this build doesn't know. We
 * keep the field typed as the closed union for ergonomic switches, but the
 * runtime guard `isKnownRecoveryKind` lets the router fall back to plain
 * text for an unrecognised value rather than crashing the exhaustive switch.
 */
export interface RecoveryDescriptor {
  kind: RecoveryKind;
  label: string;
}

/** The closed set of kinds this client build knows how to route. */
const KNOWN_RECOVERY_KINDS: ReadonlySet<string> = new Set<RecoveryKind>([
  'load-case',
  'reload-case',
  'run-pflow',
  'retry',
  'add-measurements',
  'none',
  'wait-for-job',
  'wait-for-sweep',
  'open-pf',
]);

/**
 * Narrow an arbitrary string to a known `RecoveryKind`. Returns false for a
 * forward-compat kind the server emits that this build predates — callers
 * render the descriptor's `label` as plain text with no side effect.
 */
export function isKnownRecoveryKind(kind: string): kind is RecoveryKind {
  return KNOWN_RECOVERY_KINDS.has(kind);
}

/**
 * Runtime guard: coerce an unknown value (e.g. the `recovery` field read off
 * a raw ProblemDetails body or a `JobProblem`) into a `RecoveryDescriptor`,
 * or `null` when it isn't one. Accepts ANY string `kind` (forward-compat) so
 * the router can decide whether to route or render-as-text; rejects shapes
 * missing a string `kind` or `label`.
 */
export function parseRecoveryDescriptor(value: unknown): RecoveryDescriptor | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || typeof obj.label !== 'string') return null;
  return { kind: obj.kind as RecoveryKind, label: obj.label };
}
