/**
 * BundleExportDialog (Unit 3 of the v2.0 plan).
 *
 * Modal that lets the user export a reproducibility ``.zip`` bundle
 * for the current session. Shows a preview of what will be in the
 * bundle (case file, disturbances, sim params, results CSV) before
 * the user confirms.
 *
 * Wiring:
 *
 * - Trigger: ``<BundleExportButton />`` (mounted in the TopBar). On
 *   click, opens the dialog via ``useBundleStore.openDialog()``.
 * - Confirm: fires ``useExportBundle.mutateAsync({...})`` which POSTs
 *   to ``/api/sessions/{id}/bundle/export`` with the local
 *   disturbance / sim-params / CSV inputs. The substrate streams back
 *   a ``application/zip`` body which the mutation returns as a
 *   ``Blob``; the dialog then triggers a browser download via
 *   ``downloadBlob`` (Unit 2's helper).
 * - Cancel / close: closes the dialog without firing the request.
 *
 * The preview list is computed locally from the same inputs that go
 * into the request body, so what the user sees is exactly what the
 * substrate will produce. The substrate echoes the actual file list
 * back via the response body's manifest; the dialog could re-render
 * the manifest's list post-export, but for v2.0 we keep the preview
 * purely client-side (one less round-trip, one less failure mode).
 */
import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { downloadBlob } from '@/components/export/downloadBlob';
import { timeSeriesToCsv } from '@/components/export/exportToCsv';
import { useExportBundle } from '@/api/queries';
import { useBundleStore, type BundlePreviewFile } from '@/store/bundle';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useUiStore } from '@/store/ui';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

/**
 * Compute the list of files that will land in the bundle, given the
 * current local state. Used for the preview list AND for shaping the
 * request body (so the two can't drift).
 */
function computePreviewFiles(args: {
  caseFilename: string | null;
  caseDirty: boolean;
  addfiles: readonly string[];
  disturbanceCount: number;
  hasSimParams: boolean;
  hasResultsCsv: boolean;
}): readonly BundlePreviewFile[] {
  const out: BundlePreviewFile[] = [];
  if (args.caseFilename !== null) {
    // When dirty, the substrate writes a canonical xlsx export. The
    // displayed name reflects the substrate's behavior so the preview
    // matches the actual zip contents.
    if (args.caseDirty) {
      const stem = args.caseFilename.replace(/\.[^.]+$/, '');
      out.push({ name: `case/${stem}.xlsx` });
    } else {
      out.push({ name: `case/${args.caseFilename}` });
      for (const af of args.addfiles) out.push({ name: `case/${af}` });
    }
  }
  if (args.disturbanceCount > 0) out.push({ name: 'disturbances.json' });
  if (args.hasSimParams) out.push({ name: 'sim_params.json' });
  if (args.hasResultsCsv) out.push({ name: 'results.csv' });
  out.push({ name: 'manifest.json' });
  return out;
}

/** Strip the leading workspace dir from a workspace-relative path. */
function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

export function BundleExportButton() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const openDialog = useBundleStore((s) => s.openDialog);
  const enabled = sessionId !== null && caseSelection !== null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={openDialog}
      data-testid="bundle-export-button"
    >
      Export bundle
    </Button>
  );
}

/**
 * Outer wrapper. Reads ``dialogOpen`` from the bundle store and only
 * mounts the inner dialog (which uses ``useMutation`` and therefore
 * needs a QueryClientProvider) once the user has opened the dialog.
 *
 * This deferred mount is load-bearing for tests: the TopBar component
 * is rendered in unit tests that do NOT mount a QueryClientProvider;
 * if the dialog mounted unconditionally those tests would crash on
 * ``useMutation``. Deferring the mount keeps the test surface clean.
 */
export function BundleExportDialog() {
  const dialogOpen = useBundleStore((s) => s.dialogOpen);
  const closeDialog = useBundleStore((s) => s.closeDialog);
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      {dialogOpen ? <BundleExportDialogInner /> : null}
    </Dialog>
  );
}

function BundleExportDialogInner() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const disturbances = useDisturbanceStore((s) => s.disturbances);
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const runs = useRunsStore((s) => s.runs);
  const tdsConfig = useUiStore((s) => s.tdsConfig);

  const status = useBundleStore((s) => s.status);
  const errorMessage = useBundleStore((s) => s.errorMessage);
  const closeDialog = useBundleStore((s) => s.closeDialog);
  const markPending = useBundleStore((s) => s.markPending);
  const markSuccess = useBundleStore((s) => s.markSuccess);
  const markError = useBundleStore((s) => s.markError);

  const exportMutation = useExportBundle();

  // Resolve the user-visible case filename + addfiles from the case
  // store. ``primaryPath`` is workspace-relative; we display the basename.
  const caseFilename = useMemo(() => {
    if (!caseSelection || caseSelection.primaryPath === null) return null;
    return basename(caseSelection.primaryPath);
  }, [caseSelection]);
  const addfiles = useMemo(
    () => (caseSelection?.addfiles ?? []).map((p) => basename(p)),
    [caseSelection],
  );

  // Plan-divergence note: there is no `case.dirty` flag on the case
  // store today (Unit 5 of v0.2 hasn't added one). We approximate it
  // by checking whether a blank session has been started — `blank` is
  // the only currently-known signal of "the workspace file is not
  // canonical for what the substrate has". When neither flag is set,
  // we treat the case as clean and ship the original file verbatim.
  // The substrate's own ``_replay_buffer`` check is the ground truth;
  // the preview list is best-effort and the substrate's manifest is
  // authoritative.
  const caseDirty = !!caseSelection?.blank;

  const activeRun = activeRunId ? (runs[activeRunId] ?? null) : null;
  const hasResultsCsv = activeRun !== null && activeRun.seqCount > 0;
  const hasSimParams = activeRun !== null;

  const previewFiles = useMemo(
    () =>
      computePreviewFiles({
        caseFilename,
        caseDirty,
        addfiles,
        disturbanceCount: disturbances.length,
        hasSimParams,
        hasResultsCsv,
      }),
    [caseFilename, caseDirty, addfiles, disturbances.length, hasSimParams, hasResultsCsv],
  );

  const submit = async () => {
    if (sessionId === null) return;
    markPending();

    // Build the body. The substrate echoes whatever we send back as
    // bundle contents — keep it shaped exactly like the preview list.
    const body: {
      disturbances: readonly { kind: string }[];
      sim_params: Record<string, unknown> | null;
      results_csv: string | null;
      run_id: string | null;
    } = {
      disturbances: disturbances.map((d) => d.spec),
      sim_params: hasSimParams
        ? {
            tf: activeRun?.tf ?? tdsConfig.tf,
            h: tdsConfig.h,
            vars: [...tdsConfig.vars],
            decimation: 'mean',
            max_rate_hz: tdsConfig.maxRateHz,
          }
        : null,
      results_csv: null,
      run_id: activeRun?.runId ?? null,
    };

    if (hasResultsCsv && activeRun !== null) {
      // Re-use Unit 2's CSV serialiser. The runs slice stores typed
      // arrays; we slice to ``seqCount`` so over-allocated tails don't
      // leak into the export.
      const tSlice = activeRun.t.subarray(0, activeRun.seqCount);
      const columns: Record<string, Float64Array> = {};
      for (const name of activeRun.columnNames) {
        const col = activeRun.columns[name];
        if (col !== undefined) columns[name] = col.subarray(0, activeRun.seqCount);
      }
      const blob = timeSeriesToCsv({ t: tSlice, columns });
      body.results_csv = await blob.text();
    }

    try {
      const zipBlob = await exportMutation.mutateAsync({ sessionId, body });
      const filename = `andes-bundle-${sessionId.slice(0, 8)}.zip`;
      downloadBlob(zipBlob, filename);
      markSuccess(filename, previewFiles);
      // Auto-close after a brief beat so the user sees the success
      // state. The 800ms matches the SaveSystemButton's auto-dismiss.
      setTimeout(() => closeDialog(), 800);
    } catch (err) {
      const detail =
        err instanceof ProblemDetailsError
          ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
          : err instanceof Error
            ? err.message
            : 'unknown error';
      markError(`Export failed: ${detail}`);
    }
  };

  const isPending = status === 'pending';

  return (
    <DialogContent data-testid="bundle-export-dialog">
      <DialogTitle>Export reproducibility bundle</DialogTitle>
      <DialogDescription className="mt-2">
        Bundle the current case + disturbances + last TDS run into a single <code>.zip</code> a
        colleague can re-load to reproduce your results on the same ANDES version.
      </DialogDescription>

      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            Bundle contents (preview)
          </span>
          <ul
            data-testid="bundle-export-preview-list"
            className={cn(
              'border-border bg-muted/30 max-h-48 overflow-y-auto',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 font-mono text-xs',
            )}
          >
            {previewFiles.map((f) => (
              <li key={f.name} data-testid={`bundle-export-preview-item-${f.name}`}>
                {f.name}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground text-[11px] leading-snug">
          Snapshots are intentionally NOT included — their dill payload is ANDES-version-locked and
          would defeat the bundle&apos;s portability. The manifest records the ANDES version the
          bundle was produced against so a re-load surfaces a warning if the receiving session is on
          a different version.
        </p>
        {errorMessage !== null ? (
          <div
            role="alert"
            data-testid="bundle-export-error"
            className={cn(
              'border-destructive/30 bg-destructive/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            {errorMessage}
          </div>
        ) : null}
        {status === 'success' ? (
          <div
            role="status"
            data-testid="bundle-export-success"
            className={cn(
              'border-success/30 bg-success/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            )}
          >
            Bundle downloaded.
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={closeDialog}
          disabled={isPending}
          data-testid="bundle-export-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void submit()}
          disabled={isPending || sessionId === null}
          data-testid="bundle-export-confirm"
        >
          {isPending ? 'Exporting…' : 'Export'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
