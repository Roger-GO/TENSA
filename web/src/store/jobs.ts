/**
 * Jobs slice (v3.1 Phase 3, Unit 6).
 *
 * Aggregates + indexes every routine / streaming / sweep / state-op / edit
 * invocation under a single ``JobRecord`` map keyed by ``job_id``, mirroring
 * the substrate ``_JobRegistry`` (``server/src/andes_app/core/jobs.py``). This
 * slice is the canonical client-side view that powers the Activity panel
 * (Unit 11) and lets ``SessionBusy`` be tracked as a job *state* rather than
 * surfacing as unhandled boot-409 console noise.
 *
 * Two write paths converge here and reconcile by ``job_id``:
 *
 * 1. **Mutation hooks** (``api/queries.ts``) register a placeholder
 *    ``JobRecord`` on ``onMutate`` for instant optimistic feedback (the
 *    server ``job_id`` may not be known yet, so a temp id is minted), then
 *    upgrade to the substrate ``job_id`` once the response lands.
 * 2. **``JobStream``** events (``streaming/JobStream.ts``) carry the
 *    canonical substrate state and overwrite/merge by ``job_id``.
 *
 * Whichever path arrives first, the other merges onto it (``upsertJob`` /
 * ``reconcileJob``). This slice does NOT replace ``useRunsStore`` (TDS
 * frame storage) or ``useSweepStore`` (per-iteration sweep state) — it
 * aggregates and indexes them by job id.
 *
 * **SECURITY (F2 / KTD-16):** the full ``JobRecord`` map carries
 * ``request_summary`` payloads, ``problem`` error details, and
 * ``result_ref`` results. These are IN-MEMORY ONLY and MUST NOT be
 * persisted to localStorage. The ``partialize`` whitelist below is
 * strictly limited to display-state metadata (``dismissedJobIds``) — the
 * record map is never serialized.
 *
 * Retention mirrors the substrate's KTD-19 cap (oldest *terminal* first;
 * in-flight records are NEVER evicted) at ``MAX_TERMINAL`` entries.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Routine / op discriminator. Mirrors ``andes_app.core.jobs.JobKind`` 1:1
 * so a substrate event's ``kind`` round-trips without translation. Kept as
 * a string-literal union (forward-compat: an unknown future kind from the
 * wire still stores; the union narrows known kinds for exhaustive UI
 * switches).
 */
export type JobKind =
  // routines
  | 'pflow'
  | 'tds-batch'
  | 'tds-stream'
  | 'eig'
  | 'cpf'
  | 'cpf-qv'
  | 'se'
  | 'se-measurements'
  | 'sweep'
  // state ops
  | 'snapshot-save'
  | 'snapshot-restore'
  | 'snapshot-delete'
  | 'bundle-export'
  | 'bundle-import'
  | 'case-load'
  | 'case-reload'
  | 'case-save'
  // edits + addfile
  | 'element-add'
  | 'element-edit'
  | 'element-delete'
  | 'element-undo'
  | 'disturbance-commit'
  | 'pmu-add'
  | 'pmu-delete'
  | 'profile-upload'
  | 'profile-add'
  | 'profile-delete'
  // clone-on-write (Phase 6)
  | 'clone-init'
  | 'clone-edit'
  | 'clone-undo'
  | 'clone-redo'
  | 'clone-save-as'
  | 'clone-reset';

/** Lifecycle state. Mirrors ``andes_app.core.jobs.JobStatus``. */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The set of terminal statuses. A record in any of these states is a
 * candidate for retention eviction; in-flight (``pending`` / ``running``)
 * records are NEVER evicted.
 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'done',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Minimal ProblemDetails shape carried on a failed job. Mirrors the
 * substrate's ``ProblemDetails`` envelope loosely — the Activity panel's
 * ``<ProblemDetailsErrorSurface>`` (Unit 7) reads ``title`` / ``detail`` /
 * ``recovery`` off this. Kept structurally open (``[extra: string]``) so a
 * forward-compat field doesn't drop on the wire.
 */
export interface JobProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string | null;
  instance?: string | null;
  category?: string;
  recovery?: unknown;
  [extra: string]: unknown;
}

/**
 * Client-side ``JobRecord`` mirroring the substrate's
 * ``JobRecordSchema`` wire shape. Field names match the wire snake_case so
 * a substrate event/list payload maps on without per-field translation.
 *
 * ``request_summary`` / ``problem`` / ``result_ref`` are in-memory ONLY
 * (security F2): they MUST NOT appear in the persist whitelist.
 */
export interface JobRecord {
  /** Canonical substrate ``job_id``, OR a client temp id (``local:<uuid>``)
   *  until the server id arrives via the mutation response. */
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Monotonic-ish seconds. For client placeholders we stamp ``Date.now()/1000``
   *  so chronological ordering against substrate timestamps stays sane
   *  enough for display; the wire ``started_at`` overwrites on reconcile. */
  started_at: number;
  updated_at: number;
  ended_at?: number;
  can_cancel: boolean;
  progress?: number;
  request_summary: Record<string, unknown>;
  result_ref?: string;
  problem?: JobProblem | null;
  repeated_count: number;
  /**
   * True while this record is a client-minted placeholder whose canonical
   * ``job_id`` has not yet arrived. Cleared on ``reconcileJob`` when the
   * substrate id replaces the temp id. Display-only — never persisted.
   */
  isPlaceholder?: boolean;
}

/**
 * Cap on retained TERMINAL records. Mirrors the substrate's ``MAX_TOTAL``
 * ring-buffer cap (``andes_app.core.jobs.MAX_TOTAL``). In-flight records are
 * never counted against this cap and never evicted.
 */
export const MAX_TERMINAL = 100;

/** Prefix for client-minted placeholder ids (pre-server-job_id). */
export const LOCAL_ID_PREFIX = 'local:';

/** Mint a fresh client-side placeholder job id. */
export function mintLocalJobId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${LOCAL_ID_PREFIX}${rand}`;
}

/** Fields a mutation hook supplies when registering an optimistic placeholder. */
export interface AddJobInput {
  /** Caller-supplied id. Defaults to a freshly-minted ``local:`` placeholder. */
  id?: string;
  kind: JobKind;
  /** Defaults to ``pending``. */
  status?: JobStatus;
  can_cancel?: boolean;
  request_summary?: Record<string, unknown>;
  isPlaceholder?: boolean;
  progress?: number;
}

/**
 * A status-event envelope from ``JobStream`` (or a full list-record). The
 * snake_case ``job_id`` mirrors the substrate's ``_job_event_envelope``.
 * Partial-update semantics: ``progress`` / ``problem`` absence means
 * "unchanged" (the substrate only includes them when populated).
 */
export interface JobEventEnvelope {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  progress?: number;
  problem?: JobProblem | null;
  /** Present on full list payloads (``GET /jobs``), absent on lean events. */
  started_at?: number;
  updated_at?: number;
  ended_at?: number | null;
  can_cancel?: boolean;
  request_summary?: Record<string, unknown>;
  result_ref?: string | null;
  repeated_count?: number;
}

export interface JobsState {
  /** Map ``job_id`` → record. Insertion order = chronological registration. */
  jobs: Record<string, JobRecord>;
  /**
   * Display-state: ids the user has dismissed from the Activity panel's
   * error history. The ONLY field persisted to localStorage (security F2).
   */
  dismissedJobIds: readonly string[];

  /**
   * Register an optimistic placeholder (mutation ``onMutate`` path). Returns
   * the id used (the caller passes it to ``reconcileJob`` once the server
   * id lands). Applies retention after insert.
   */
  addJob: (input: AddJobInput) => string;

  /**
   * Patch an existing record by id. No-op when the id is unknown. Bumps
   * ``updated_at``. Applies retention when the patch moves the record into a
   * terminal state.
   */
  updateJob: (id: string, patch: Partial<JobRecord>) => void;

  /**
   * Upsert a record from a ``JobStream`` event (canonical state). Merges
   * onto an existing record (by ``job_id``) or inserts a fresh one. Applies
   * retention after the write.
   */
  upsertJob: (envelope: JobEventEnvelope) => void;

  /**
   * Reconcile a client placeholder (``tempId``) onto the canonical
   * substrate ``serverId``. If a record under ``serverId`` already exists
   * (the WS event raced ahead), the placeholder's optimistic fields merge
   * onto it and the temp entry is dropped. Otherwise the temp record is
   * re-keyed to ``serverId``. ``patch`` carries any response-derived fields
   * (e.g. ``result_ref``, terminal ``status``).
   */
  reconcileJob: (tempId: string, serverId: string, patch?: Partial<JobRecord>) => void;

  /** Remove a record by id. Idempotent. */
  removeJob: (id: string) => void;

  /** Replace a full snapshot of records (``JobStream`` reconnect re-sync). */
  syncJobs: (envelopes: readonly JobEventEnvelope[]) => void;

  /** Mark a job dismissed (display-state; persisted). Idempotent. */
  dismissJob: (id: string) => void;
  /** Clear a dismissal. Idempotent. */
  undismissJob: (id: string) => void;

  /** Clear every record (auth-clear / session-change cascade). Does NOT clear
   *  ``dismissedJobIds`` — dismissals are display preferences that survive a
   *  session swap; they're cheap and self-healing (a dismissed id that never
   *  recurs is harmless). */
  clearJobs: () => void;
}

// ---- internal helpers -----------------------------------------------------

/**
 * Apply the terminal-retention cap. Returns the next jobs map; mutates
 * nothing on the input. Evicts oldest TERMINAL records first (insertion
 * order = chronological); NEVER evicts in-flight (``pending`` / ``running``)
 * records — mirrors the substrate's ``_evict_if_over_cap`` invariant.
 */
function applyRetention(jobs: Record<string, JobRecord>): Record<string, JobRecord> {
  const terminalIds: string[] = [];
  for (const id of Object.keys(jobs)) {
    if (isTerminalStatus(jobs[id]!.status)) terminalIds.push(id);
  }
  if (terminalIds.length <= MAX_TERMINAL) return jobs;
  const overflow = terminalIds.length - MAX_TERMINAL;
  const next = { ...jobs };
  // Insertion order is chronological for string keys in JS objects, so the
  // leading ``overflow`` terminal ids are the oldest.
  for (let i = 0; i < overflow; i += 1) {
    delete next[terminalIds[i]!];
  }
  return next;
}

/**
 * Build a full ``JobRecord`` from a (possibly-lean) event envelope, merging
 * onto an optional existing record. Absent ``progress`` / ``problem`` /
 * other optional fields are treated as "unchanged" so a lean transition
 * event doesn't wipe data carried by a prior full record.
 */
function mergeEnvelope(envelope: JobEventEnvelope, existing?: JobRecord): JobRecord {
  const now = Date.now() / 1000;
  const base: JobRecord = existing ?? {
    id: envelope.job_id,
    kind: envelope.kind,
    status: envelope.status,
    started_at: envelope.started_at ?? now,
    updated_at: envelope.updated_at ?? now,
    can_cancel: envelope.can_cancel ?? false,
    request_summary: envelope.request_summary ?? {},
    repeated_count: envelope.repeated_count ?? 0,
  };
  const next: JobRecord = {
    ...base,
    id: envelope.job_id,
    kind: envelope.kind,
    status: envelope.status,
    updated_at: envelope.updated_at ?? now,
  };
  // The canonical event is authoritative — a real transition always clears
  // the placeholder flag.
  delete next.isPlaceholder;
  if (envelope.started_at !== undefined) next.started_at = envelope.started_at;
  if (envelope.progress !== undefined) next.progress = envelope.progress;
  if (envelope.can_cancel !== undefined) next.can_cancel = envelope.can_cancel;
  if (envelope.request_summary !== undefined) next.request_summary = envelope.request_summary;
  if (envelope.repeated_count !== undefined) next.repeated_count = envelope.repeated_count;
  if (envelope.result_ref !== undefined && envelope.result_ref !== null) {
    next.result_ref = envelope.result_ref;
  }
  if (envelope.ended_at !== undefined && envelope.ended_at !== null) {
    next.ended_at = envelope.ended_at;
  }
  if (envelope.problem !== undefined) {
    next.problem = envelope.problem;
  }
  // Stamp ended_at on a terminal transition when the wire didn't carry one
  // (lean events omit it) so the Activity panel can compute elapsed time.
  if (isTerminalStatus(next.status) && next.ended_at === undefined) {
    next.ended_at = next.updated_at;
  }
  return next;
}

export const JOBS_STORAGE_KEY = 'andes-app:activity-v1';

export const useJobsStore = create<JobsState>()(
  persist(
    (set, get) => ({
      jobs: {},
      dismissedJobIds: [],

      addJob: (input) => {
        const id = input.id ?? mintLocalJobId();
        const now = Date.now() / 1000;
        const record: JobRecord = {
          id,
          kind: input.kind,
          status: input.status ?? 'pending',
          started_at: now,
          updated_at: now,
          can_cancel: input.can_cancel ?? false,
          request_summary: input.request_summary ?? {},
          repeated_count: 0,
          isPlaceholder: input.isPlaceholder ?? id.startsWith(LOCAL_ID_PREFIX),
        };
        if (input.progress !== undefined) record.progress = input.progress;
        const inserted = { ...get().jobs, [id]: record };
        set({ jobs: applyRetention(inserted) });
        return id;
      },

      updateJob: (id, patch) => {
        const cur = get().jobs[id];
        if (!cur) return;
        const next: JobRecord = {
          ...cur,
          ...patch,
          id: cur.id,
          updated_at: patch.updated_at ?? Date.now() / 1000,
        };
        if (
          patch.status !== undefined &&
          isTerminalStatus(patch.status) &&
          next.ended_at === undefined
        ) {
          next.ended_at = next.updated_at;
        }
        set({ jobs: applyRetention({ ...get().jobs, [id]: next }) });
      },

      upsertJob: (envelope) => {
        const existing = get().jobs[envelope.job_id];
        const merged = mergeEnvelope(envelope, existing);
        set({ jobs: applyRetention({ ...get().jobs, [envelope.job_id]: merged }) });
      },

      reconcileJob: (tempId, serverId, patch) => {
        const jobs = get().jobs;
        const placeholder = jobs[tempId];
        const serverRecord = jobs[serverId];
        const next = { ...jobs };

        if (serverRecord) {
          // The WS event raced ahead of the mutation response. Keep the
          // canonical server record; fold in any placeholder request_summary
          // we didn't already have, plus the response patch. Drop the temp.
          const merged: JobRecord = {
            ...serverRecord,
            ...(placeholder && Object.keys(serverRecord.request_summary).length === 0
              ? { request_summary: placeholder.request_summary }
              : {}),
            ...patch,
            id: serverId,
            updated_at: patch?.updated_at ?? Date.now() / 1000,
          };
          delete merged.isPlaceholder;
          next[serverId] = merged;
          if (tempId !== serverId) delete next[tempId];
        } else if (placeholder) {
          // Normal path: re-key the placeholder to the canonical id.
          const merged: JobRecord = {
            ...placeholder,
            ...patch,
            id: serverId,
            updated_at: patch?.updated_at ?? Date.now() / 1000,
          };
          delete merged.isPlaceholder;
          if (tempId !== serverId) delete next[tempId];
          next[serverId] = merged;
        } else {
          // Neither exists (defensive): synthesize a minimal record from the
          // patch so the response isn't dropped.
          const now = Date.now() / 1000;
          next[serverId] = {
            kind: (patch?.kind as JobKind) ?? 'pflow',
            status: patch?.status ?? 'done',
            started_at: patch?.started_at ?? now,
            updated_at: now,
            can_cancel: patch?.can_cancel ?? false,
            request_summary: patch?.request_summary ?? {},
            repeated_count: patch?.repeated_count ?? 0,
            ...patch,
            id: serverId,
          };
        }
        set({ jobs: applyRetention(next) });
      },

      removeJob: (id) => {
        if (!get().jobs[id]) return;
        const next = { ...get().jobs };
        delete next[id];
        set({ jobs: next });
      },

      syncJobs: (envelopes) => {
        // Full re-sync (reconnect / snapshot): the substrate payload is
        // authoritative for the jobs it lists. Preserve any still-IN-FLIGHT
        // record NOT present in the incoming set — that covers both raw
        // ``local:`` placeholders (server id not yet landed) AND optimistic
        // records the mutation path already reconciled onto a canonical id
        // but whose snapshot the server captured before registering. Dropping
        // them here would lose the optimistic request_summary an in-flight
        // row needs. Terminal records absent from the snapshot are genuinely
        // gone (evicted server-side) and are not preserved.
        const prev = get().jobs;
        const incoming = new Set(envelopes.map((e) => e.job_id));
        const next: Record<string, JobRecord> = {};
        for (const [id, rec] of Object.entries(prev)) {
          if (!incoming.has(id) && !isTerminalStatus(rec.status)) {
            next[id] = rec;
          }
        }
        for (const env of envelopes) {
          next[env.job_id] = mergeEnvelope(env, prev[env.job_id]);
        }
        set({ jobs: applyRetention(next) });
      },

      dismissJob: (id) => {
        if (get().dismissedJobIds.includes(id)) return;
        set({ dismissedJobIds: [...get().dismissedJobIds, id] });
      },

      undismissJob: (id) => {
        if (!get().dismissedJobIds.includes(id)) return;
        set({ dismissedJobIds: get().dismissedJobIds.filter((x) => x !== id) });
      },

      clearJobs: () => set({ jobs: {} }),
    }),
    {
      name: JOBS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // SECURITY (F2 / KTD-16): persist ONLY display-state metadata. The
      // full ``jobs`` map (request_summary payloads, problem error details,
      // result refs) is in-memory only and MUST NOT be serialized. This
      // whitelist is the single enforcement point — never widen it to
      // include ``jobs``.
      partialize: (state) => ({ dismissedJobIds: state.dismissedJobIds }),
    },
  ),
);

// Test-only: re-export internal helpers for retention / merge assertions
// without widening the public store API.
export const __internal = {
  applyRetention,
  mergeEnvelope,
  MAX_TERMINAL,
};
