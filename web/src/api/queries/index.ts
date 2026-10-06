/**
 * TanStack Query v5 hooks — one per substrate endpoint.
 *
 * Conventions:
 *
 * - Query keys: `[<scope>, <id>?]` with `scope` matching the API path
 *   segment ("topology", "workspace-files", "sidecar"). Keys are exported
 *   so other hooks can invalidate by prefix.
 * - Mutations write through to the Zustand stores after a successful
 *   response (sessionId, topology, lastRun). Queries do NOT — components
 *   consume queries directly via `data` and let React reconcile.
 *
 * Cache invalidation rules (per the plan):
 *
 * - Case load → invalidate topology (the new case has a new topology).
 * - PF run → invalidate topology (state flips from "pre-setup" to
 *   "committed" after `ss.setup()`).
 * - Reload → invalidate topology + clear PF cache.
 * - Sidecar PUT → invalidate sidecar GET for the same case path.
 *
 * Layout: one module per domain in this folder, all re-exported here, so every
 * caller imports from `@/api/queries`. Import from here and not from a module of
 * the folder: tests mock `@/api/queries`, and a component that reached past it
 * would run the real hook. `jobGlue.ts` and `caseReady.ts` are shared by the
 * modules and are not re-exported, and neither is `snapshotsKey` of `keys.ts`.
 */
export { queryKeys } from './keys';
export type { ReportRoutine } from './keys';
export * from './queryClient';
export * from './session';
export * from './serverInfo';
export * from './workspace';
export * from './topology';
export * from './case';
export * from './elements';
export * from './pflow';
export * from './tds';
export * from './tdsCatalogue';
export * from './bundle';
export * from './snapshots';
export * from './report';
export * from './analysis';
export * from './pmu';
export * from './profiles';
export * from './sweeps';
export * from './clone';
