/**
 * Query keys, shared by the hooks that read a query and the ones that invalidate it.
 *
 * ``index.ts`` re-exports ``queryKeys`` and ``ReportRoutine``. ``snapshotsKey`` stays
 * between the hooks: a case load and the snapshot mutations invalidate that listing.
 */
import type { SessionId, WorkspacePath } from '@/api/types';

/**
 * Routine name accepted by ``GET /sessions/{id}/report``.
 *
 * Declared at module top so the ``queryKeys`` block (below) can
 * reference it for the ``report`` key factory.
 */
export type ReportRoutine = 'pflow' | 'tds' | 'eig';

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: SessionId) => ['sessions', id] as const,
  /** The idle-timeout heartbeat poll, scoped per session (``useSessionHeartbeat``). */
  sessionHeartbeat: (id: SessionId) => ['session-heartbeat', id] as const,
  topology: (id: SessionId) => ['topology', id] as const,
  workspaceFiles: ['workspace-files'] as const,
  sidecar: (casePath: WorkspacePath) => ['sidecar', casePath] as const,
  topologySchema: ['topology-schema'] as const,
  version: ['version'] as const,
  /** Alterable-params lookup, scoped per (session, model). */
  alterableParams: (id: SessionId, model: string) => ['alterable-params', id, model] as const,
  /** Report payload, scoped per (session, routine). */
  report: (id: SessionId, routine: ReportRoutine) => ['report', id, routine] as const,
  /** EIG result, scoped per session (Unit 6). */
  eig: (id: SessionId) => ['eig', id] as const,
  /** Per-mode participation factor row (Unit 6). */
  eigParticipation: (id: SessionId, modeIdx: number) => ['eig-participation', id, modeIdx] as const,
  /** CPF result, scoped per session (Unit 12). */
  cpf: (id: SessionId) => ['cpf', id] as const,
  /** SE result, scoped per session (Unit 13). */
  se: (id: SessionId) => ['se', id] as const,
  /** SE measurements-generated count, scoped per session (Unit 13). */
  seMeasurements: (id: SessionId) => ['se-measurements', id] as const,
  /** Connectivity / island-detection result, scoped per session (Unit 17). */
  connectivity: (id: SessionId) => ['connectivity', id] as const,
  /** PMU placements list, scoped per session (Unit 14). */
  pmus: (id: SessionId) => ['pmus', id] as const,
  /** TimeSeries profile assignments, scoped per session (Unit 15). */
  profiles: (id: SessionId) => ['profiles', id] as const,
  /**
   * The ANDES variables a TDS run can record, scoped per (session, case, search
   * words, page size). The case is part of the key because the list is a
   * property of what is loaded.
   */
  daeVariables: (id: SessionId, casePath: string, q: string, limit: number) =>
    ['dae-variables', id, casePath, q, limit] as const,
  /**
   * The devices a TDS run's controllers can command, scoped per (session,
   * case, number of dynamic devices): a property of what is loaded, like the
   * variables above. The count makes a battery added or deleted a new list.
   */
  tdsControllers: (id: SessionId, casePath: string, devices: number) =>
    ['tds-controllers', id, casePath, devices] as const,
  /** Clone-vs-original param diff, scoped per (session, model, idx) (Unit 23). */
  cloneDiff: (id: SessionId, model: string, idx: string) => ['clone-diff', id, model, idx] as const,
} as const;

/** Query-key factory for the snapshot listing. Exported so the snapshot mutations
 *  (save / restore / delete) and a case load can invalidate it on success. */
export function snapshotsKey(sessionId: SessionId) {
  return ['snapshots', sessionId] as const;
}
