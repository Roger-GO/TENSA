/** Reproducibility bundles: ``POST /sessions/{id}/bundle/export`` and ``.../bundle/import``. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { NetworkError, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type { SessionId, SidecarLayout } from '@/api/types';
import { useDisturbanceStore } from '@/store/disturbance';
import { useEditJournalStore } from '@/store/editJournal';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { queryKeys } from './keys';
import { failJob, reconcileJobSuccess, registerJob } from './jobGlue';

export interface ExportBundleVars {
  sessionId: SessionId;
  /**
   * Request body forwarded to ``POST /api/sessions/{id}/bundle/export``.
   * The substrate accepts an empty body (``{}``) and produces a minimal
   * bundle (case + manifest only); callers typically populate
   * ``disturbances`` / ``sim_params`` / ``results_csv`` from their local
   * state so the bundle is reproducibility-grade.
   */
  body: {
    disturbances?: readonly { kind: string }[];
    sim_params?: Record<string, unknown> | null;
    results_csv?: string | null;
    run_id?: string | null;
    /**
     * The diagram's layout as it is drawn, written to the bundle as
     * ``layout.json``. Without it the substrate bundles the layout saved
     * beside the case file, if there is one.
     */
    layout?: SidecarLayout | null;
  };
}

/**
 * ``POST /api/sessions/{id}/bundle/export``.
 *
 * Returns a ``Blob`` of the assembled ``.zip`` body — the caller is
 * responsible for triggering the browser download (typically via the
 * ``downloadBlob`` helper from ``components/export/downloadBlob.ts``).
 *
 * The default ``andesClient.post`` parses the response as JSON; the
 * bundle endpoint returns ``application/zip``, so we bypass the
 * client and call ``fetch`` directly. We still honor the project's
 * ``ProblemDetailsError`` taxonomy so the global recovery cascade and
 * the in-dialog error inline path work the same way as every other
 * mutation.
 */
export function useExportBundle(): UseMutationResult<Blob, Error, ExportBundleVars> {
  return useMutation({
    mutationFn: async ({ sessionId, body }: ExportBundleVars) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/bundle/export`;
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      // 60s timeout matches `caseLoad` — bundle assembly does at most one
      // canonical xlsx export, which is the same order of magnitude as a
      // case load.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.caseLoad);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on POST ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        // Error body is JSON ProblemDetails — read it through the same
        // path the regular client uses so the global 404 cascade
        // recognises the shape.
        let parsed: unknown = undefined;
        try {
          parsed = await response.json();
        } catch {
          // ignore
        }
        const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail: typeof obj.detail === 'string' ? obj.detail : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return await response.blob();
    },
    onMutate: () => ({ jobId: registerJob('bundle-export') }),
    onSuccess: (data, _vars, ctx) => {
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}

/**
 * Side-by-side metadata for a sha-mismatch conflict; one half points at
 * the bundle's bytes, the other at the workspace's. Both halves carry
 * the same shape so the conflict resolver can render them in a uniform
 * diff layout.
 */
export interface BundleCaseMetadataDiff {
  filename: string;
  sha256: string;
  size_bytes: number;
}

/**
 * One conflict surfaced by ``POST /sessions/{id}/bundle/import``.
 *
 * Conflicts are typed via ``kind`` so the UI can pick a specific
 * presentation (warnings inline, blockers blocking the commit). The
 * shape mirrors the substrate's ``BundleConflict`` 1:1.
 */
export interface BundleConflict {
  kind: 'andes-version' | 'addfile-missing' | 'sha-mismatch';
  severity: 'warning' | 'blocker';
  message: string;
  filename: string | null;
  bundle_meta: BundleCaseMetadataDiff | null;
  workspace_meta: BundleCaseMetadataDiff | null;
  bundle_andes_version: string | null;
  current_andes_version: string | null;
}

/** Bundle manifest body echoed in the import-plan response. */
export interface BundleManifest {
  andes_version: string;
  tensa_version: string;
  case_filename: string | null;
  case_sha256: string | null;
  case_canonical_export?: boolean;
  disturbance_count: number;
  run_id?: string | null;
  exported_at: string;
  files: readonly string[];
  // Forward-compat: substrate is allowed to add fields we don't know
  // about yet. The UI ignores unknown keys.
  [extra: string]: unknown;
}

/** Substrate-side import plan (response of bundle/import). */
export interface BundleImportPlan {
  manifest: BundleManifest;
  case_files: readonly string[];
  conflicts: readonly BundleConflict[];
  blocked: boolean;
  has_conflicts: boolean;
}

/** Top-level response shape of ``POST /sessions/{id}/bundle/import``. */
export interface BundleImportResponse {
  status: 'plan' | 'committed';
  plan: BundleImportPlan;
  warnings: readonly string[];
  case_filename: string | null;
  addfile_filenames: readonly string[];
  disturbances_replayed: number;
  /** True when the bundle held a diagram layout that is now saved beside the case. */
  layout_restored?: boolean;
}

export interface ImportBundleVars {
  sessionId: SessionId;
  /** The bundle file the user picked (e.g., ``andes-bundle-abc.zip``). */
  file: File;
  /** True when re-issuing after the user resolved conflicts. */
  forceResolve?: boolean;
  /**
   * sha-mismatch resolution. True (default) overwrites the workspace
   * with the bundle's case file; False preserves the workspace and
   * writes the bundle's bytes to a sibling ``.from-bundle`` path.
   */
  useBundleCase?: boolean;
  /**
   * When True (default), the substrate proceeds even when the bundle's
   * ANDES major.minor differs from the installed version (the warning
   * is informational once acknowledged).
   */
  acceptVersionMismatch?: boolean;
}

/**
 * ``POST /api/sessions/{id}/bundle/import``.
 *
 * Multipart upload — the bundle file is the body. The response is
 * either a 200 ``status="committed"`` (clean import) or a 409
 * ``status="plan"`` carrying the conflict list for the
 * ``BundleConflictResolver`` to render. The mutation hook surfaces
 * BOTH branches via the same return type — callers branch on
 * ``response.status`` rather than catching the 409 as an error.
 *
 * Implementation note: ``ProblemDetailsError`` carries the full
 * response body via its ``raw`` field. For the 409 case we re-shape
 * the raw body into a ``BundleImportResponse`` and resolve normally;
 * for genuine errors (4xx other than 409, 5xx) we re-raise.
 */
export function useImportBundle(): UseMutationResult<
  BundleImportResponse,
  Error,
  ImportBundleVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      file,
      forceResolve,
      useBundleCase,
      acceptVersionMismatch,
    }: ImportBundleVars) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/bundle/import`;
      const formData = new FormData();
      formData.set('file', file, file.name);
      if (forceResolve !== undefined) {
        formData.set('force_resolve', forceResolve ? 'true' : 'false');
      }
      if (useBundleCase !== undefined) {
        formData.set('use_bundle_case', useBundleCase ? 'true' : 'false');
      }
      if (acceptVersionMismatch !== undefined) {
        formData.set('accept_version_mismatch', acceptVersionMismatch ? 'true' : 'false');
      }

      const headers = new Headers();
      // NOTE: don't set Content-Type — the browser writes the
      // multipart boundary into it automatically when the body is a
      // FormData.

      // 120s timeout matches the substrate's worker-side cap. Bundle
      // import does at most one ``andes.load(setup=False)`` plus the
      // disturbance replay loop; both are sub-second on small cases.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on POST ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        parsed = null;
      }

      // 409 carries the BundleImportResponse plan in the
      // ProblemDetails ``detail`` field (the substrate uses
      // ``HTTPException(detail=response.model_dump())``); re-shape so
      // the caller sees the same return type as a clean commit.
      if (response.status === 409) {
        const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        const detail = obj.detail;
        if (detail && typeof detail === 'object') {
          return detail as unknown as BundleImportResponse;
        }
        // Fallback: 409 without the expected shape — treat as error.
      }

      if (!response.ok) {
        const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail:
            typeof obj.detail === 'string'
              ? obj.detail
              : obj.detail !== undefined
                ? JSON.stringify(obj.detail)
                : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return parsed as BundleImportResponse;
    },
    onMutate: ({ file }) => ({ jobId: registerJob('bundle-import', { filename: file.name }) }),
    onSuccess: (data, { sessionId }, ctx) => {
      if (ctx) reconcileJobSuccess(ctx.jobId, data);
      // Only invalidate caches when the substrate actually committed —
      // a plan response means the user is mid-conflict-resolution and
      // the session state is unchanged.
      if (data.status !== 'committed') return;
      // The bundle's case replaced the system, which the journal cannot rebuild.
      useEditJournalStore.getState().markReplaced();
      void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
      // The bundle's layout replaced the one beside the case file. A copy of the
      // old one may be cached (the case was open here before), and the diagram
      // would be drawn from it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.sidecars });
      // Reset session-scoped slices that the import made stale: pflow
      // (no run yet on the new System), the active run (the dynamic state it
      // left belongs to the old System; its results stay in the history, as
      // after Reset run), disturbance committed-flag.
      usePflowStore.getState().clearPflow();
      useRunsStore.getState().clearActiveRun();
      useDisturbanceStore.setState({ committed: false, dirty: true });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) failJob(ctx.jobId, err);
    },
  });
}
