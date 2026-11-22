/**
 * The public surface of `@/api/queries`.
 *
 * The hooks live in one module per domain under `src/api/queries/`, and the
 * folder's `index.ts` re-exports them so every caller (and every
 * `vi.mock('@/api/queries')`) keeps one import path. These tests pin what that
 * path offers: a hook left out of the barrel, a helper that leaks into it, or a
 * rename fails here and not in some component's import.
 */
import { describe, expect, it } from 'vitest';
import * as queries from '@/api/queries';
import { parseSessionId } from '@/api/types';
import type {
  AddElementVars,
  AddExampleVars,
  AddPmuVars,
  AddProfileVars,
  BundleCaseMetadataDiff,
  BundleConflict,
  BundleImportPlan,
  BundleImportResponse,
  BundleManifest,
  CancelJobVars,
  CloneEditVars,
  CloneSaveAsVars,
  CommitDisturbancesVars,
  CpfQvRunVars,
  CpfRunVars,
  DeleteElementVars,
  DeletePmuVars,
  DeleteProfileVars,
  DeleteSnapshotVars,
  EditElementVars,
  EditElementsVars,
  EigSweepVars,
  ExternalResultsResponse,
  ExternalSeries,
  ExportBundleVars,
  ExportPmuCsvVars,
  ImportBundleVars,
  ImportExternalResultsVars,
  ListSnapshotsResponse,
  LoadCaseVars,
  PutSidecarVars,
  ReportResponse,
  ReportRoutine,
  ReportTable,
  RestoreSnapshotResponse,
  RestoreSnapshotVars,
  SaveCaseVars,
  SaveSnapshotResponse,
  SaveSnapshotVars,
  SeGenerateMeasurementsVars,
  SnapshotListEntry,
  SnapshotMetadata,
  StartSweepResponse,
  StartSweepVars,
  SweepParamKind,
  TdsInitVars,
  UploadProfileVars,
  UploadWorkspaceFileVars,
} from '@/api/queries';

/**
 * The types the barrel re-exports. Naming each one here is the check: the file
 * stops compiling (`pnpm typecheck`) when one is missing from `index.ts`.
 */
export type PublicTypes = [
  AddElementVars,
  AddExampleVars,
  AddPmuVars,
  AddProfileVars,
  BundleCaseMetadataDiff,
  BundleConflict,
  BundleImportPlan,
  BundleImportResponse,
  BundleManifest,
  CancelJobVars,
  CloneEditVars,
  CloneSaveAsVars,
  CommitDisturbancesVars,
  CpfQvRunVars,
  CpfRunVars,
  DeleteElementVars,
  DeletePmuVars,
  DeleteProfileVars,
  DeleteSnapshotVars,
  EditElementVars,
  EditElementsVars,
  EigSweepVars,
  ExternalResultsResponse,
  ExternalSeries,
  ExportBundleVars,
  ExportPmuCsvVars,
  ImportBundleVars,
  ImportExternalResultsVars,
  ListSnapshotsResponse,
  LoadCaseVars,
  PutSidecarVars,
  ReportResponse,
  ReportRoutine,
  ReportTable,
  RestoreSnapshotResponse,
  RestoreSnapshotVars,
  SaveCaseVars,
  SaveSnapshotResponse,
  SaveSnapshotVars,
  SeGenerateMeasurementsVars,
  SnapshotListEntry,
  SnapshotMetadata,
  StartSweepResponse,
  StartSweepVars,
  SweepParamKind,
  TdsInitVars,
  UploadProfileVars,
  UploadWorkspaceFileVars,
];

/** Every value `@/api/queries` exports: the hooks, the fetchers, the keys and the recovery wiring. */
const PUBLIC_VALUES = [
  'CLONE_EDIT_BUSY_RETRY_DELAYS_MS',
  'SAVE_CASE_MUTATION_KEY',
  '__resetRecoveryDebounceForTests',
  'fetchComtradeRecord',
  'fetchResponseMetrics',
  'handleGlobalRecoveryError',
  'isWaitingForSession',
  'loadOperatingPointIntoStore',
  'makeQueryClient',
  'queryKeys',
  'useAbortRun',
  'useAddElement',
  'useAddExample',
  'useAddPmu',
  'useAddProfile',
  'useAlterableParams',
  'useBlankSystem',
  'useCancelJob',
  'useCloneDiff',
  'useCloneEdit',
  'useCloneRedo',
  'useCloneReset',
  'useCloneSaveAs',
  'useCloneUndo',
  'useCommitDisturbances',
  'useConnectivity',
  'useCpfQvRun',
  'useCpfRun',
  'useCreateSession',
  'useCurrentTopology',
  'useDaeVariables',
  'useDeleteElement',
  'useDeletePmu',
  'useDeleteProfile',
  'useDeleteSession',
  'useDeleteSnapshot',
  'useEditElement',
  'useEditElements',
  'useEigParticipation',
  'useEngines',
  'useEigRun',
  'useEigSweepRun',
  'useExportBundle',
  'useExportPmuCsv',
  'useForgetYbus',
  'useGetSidecar',
  'useImportBundle',
  'useImportExternalResults',
  'useInitClone',
  'useListExamples',
  'useListPmus',
  'useListProfiles',
  'useListSnapshots',
  'useListWorkspaceFiles',
  'useLoadCase',
  'useModelDoc',
  'useNetworkMatrix',
  'usePutSidecar',
  'useRedoEdit',
  'useRefreshTopology',
  'useReloadCase',
  'useReport',
  'useResetRun',
  'useRestoreSnapshot',
  'useRunPflow',
  'useSaveCase',
  'useSaveSnapshot',
  'useSeGenerateMeasurements',
  'useSeRun',
  'useStartSweep',
  'useSupportedModels',
  'useTdsControllers',
  'useTdsInit',
  'useTopology',
  'useTopologyRefetching',
  'useTopologySchema',
  'useUndoLastEdit',
  'useUploadProfile',
  'useUploadWorkspaceFile',
  'useVersionInfo',
  'useYbus',
  'wireGlobalErrorRecovery',
];

describe('@/api/queries public surface', () => {
  it('exports exactly the hooks and helpers the callers import', () => {
    expect(Object.keys(queries).sort()).toEqual([...PUBLIC_VALUES].sort());
  });

  it('keeps the helpers the modules share out of the barrel', () => {
    for (const internal of [
      'registerJob',
      'reconcileJobSuccess',
      'failJob',
      'useCaseReady',
      'snapshotsKey',
    ]) {
      expect(queries).not.toHaveProperty(internal);
    }
  });

  it('keeps the query keys the invalidations rely on', () => {
    const id = parseSessionId('s1');
    expect(queries.queryKeys.topology(id)).toEqual(['topology', 's1']);
    expect(queries.queryKeys.ybus(id)).toEqual(['ybus', 's1']);
    expect(queries.queryKeys.report(id, 'pflow')).toEqual(['report', 's1', 'pflow']);
    expect(queries.SAVE_CASE_MUTATION_KEY).toEqual(['save-case']);
  });
});
