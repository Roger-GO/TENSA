/**
 * useGridEditing: lets a ``DataGrid`` change the values of the devices its rows
 * stand for, through the routes the Inspector already uses.
 *
 * Which route, and whether at all, follows the Inspector's own rule:
 *
 * - **Not started.** The values are written to the System in memory with
 *   ``PUT /elements/{model}/{idx}`` (``useEditElement``). The cells of one
 *   device are sent in one request, so a set that has to be in order (the
 *   reactances of a machine) is judged as a set.
 * - **Controllers in Edit mode.** An exciter or a governor is written to a copy
 *   of the case file with ``PUT /case/clone/params/...`` (``useCloneEdit``), which
 *   reads the case again from the copy, so it works after a run too. The clone
 *   writers cover the controller models only; a bus, line, generator or load is
 *   never written this way.
 * - **After a run, or while one is going.** Locked, with the reason and, after a
 *   run, a Reset run button: a run commits the System, and resetting discards the
 *   edits made so far.
 *
 * Writes go one after another, since the server holds one request per session,
 * and each ends once the topology has been read again, so a cell shows the value
 * that was written and not the one before it.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import {
  queryKeys,
  useCloneEdit,
  useCurrentTopology,
  useEditElement,
  useResetRun,
  useTopologySchema,
} from '@/api/queries';
import type { ParamValue } from '@/api/types';
import { Button } from '@/components/ui/button';
import { EditModeToggle } from '@/components/inspector/EditModeToggle';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import type { CellEdit, CommitResult, GridEditing } from './DataGrid';
import { cellKey } from './gridCells';

export interface GridEditTarget<Row> {
  /** The ANDES model class of the device a row stands for (`Bus`, `GENROU`, `PQ`). */
  model: (row: Row) => string;
  /** Its idx. */
  idx: (row: Row) => string;
  /**
   * The rows are controllers (exciters, governors): in Edit mode they are written
   * to a copy of the case file, which is open to a run's case, and the bar carries
   * the Edit mode switch.
   */
  controllers?: boolean;
}

const EDIT_HINT = 'Double-click a value to change it, or paste values copied from a spreadsheet.';

const CONTROLLER_EDIT_HINT = `${EDIT_HINT} Edit mode keeps controller changes through a run.`;

const CLONE_HINT =
  'Edit mode: double-click a value to change it. Each change goes to a copy of the case file and the case is read again from it, which drops changes made before Edit mode was on.';

const STREAMING_REASON = 'A run is streaming. Values can be changed when it ends.';

const PFLOW_REASON = 'A power flow is running. Values can be changed when it ends.';

const LOCKED_REASON =
  'A run has locked this case. Reset the run to change values again; the changes made so far are discarded.';

const CONTROLLER_LOCKED_REASON =
  'A run has locked this case. Turn on Edit mode to change controller values, or reset the run to change them as before; resetting discards the changes made so far.';

/** What the server or the client said about a refused write, as a sentence. */
function reasonOf(err: unknown): string {
  const text =
    err instanceof ProblemDetailsError
      ? (err.detail ?? err.title)
      : err instanceof Error
        ? err.message
        : 'The write failed';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

interface ElementGroup {
  model: string;
  idx: string;
  params: Record<string, ParamValue>;
  count: number;
}

export function useGridEditing<Row>(target: GridEditTarget<Row>): GridEditing<Row> {
  const { model: modelOf, idx: idxOf, controllers = false } = target;
  const queryClient = useQueryClient();
  const topology = useCurrentTopology();
  const schema = useTopologySchema();
  const sessionId = useSessionStore((s) => s.sessionId);
  const editMode = useCaseStore((s) => s.editMode);
  const pflowRunning = usePflowStore((s) => s.isRunning);
  const streaming = useRunsStore((s) =>
    Object.values(s.runs).some((r) => r.state === 'starting' || r.state === 'streaming'),
  );
  const editElement = useEditElement();
  const cloneEdit = useCloneEdit();
  const resetRun = useResetRun();

  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // Writes queue behind each other: the server answers a second request on a
  // session that is busy with a 409. The chain never rejects (a write resolves
  // with its result), so a failed one does not stop the next.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const state = topology?.state;
  let route: 'element' | 'clone' | null = null;
  let lockedReason: string | null = null;
  let lockedByRun = false;
  if (topology !== null && sessionId !== null) {
    if (streaming) {
      lockedReason = STREAMING_REASON;
    } else if (pflowRunning) {
      lockedReason = PFLOW_REASON;
    } else if (controllers && editMode === 'edit') {
      route = 'clone';
    } else if (state === 'pre-setup') {
      route = 'element';
    } else {
      lockedReason = controllers ? CONTROLLER_LOCKED_REASON : LOCKED_REASON;
      lockedByRun = true;
    }
  }

  // The numeric parameters each model takes, from the schema the add and edit
  // forms use, so a column the model has no such parameter for stays read-only.
  const numericParams = useMemo(() => {
    const byModel = new Map<string, ReadonlySet<string>>();
    for (const [model, metas] of Object.entries(schema.data?.models ?? {})) {
      byModel.set(model, new Set(metas.filter((m) => m.kind === 'number').map((m) => m.name)));
    }
    return byModel;
  }, [schema.data]);

  const canEdit = useCallback<GridEditing<Row>['canEdit']>(
    (row, column) =>
      route !== null &&
      column.edit !== undefined &&
      numericParams.get(modelOf(row))?.has(column.edit.param) === true,
    [route, numericParams, modelOf],
  );

  const commit = useCallback(
    (edits: ReadonlyArray<CellEdit<Row>>): Promise<CommitResult> => {
      const keys = edits.map((e) => cellKey(e.rowId, e.column.key));
      setPending((prev) => new Set([...prev, ...keys]));
      setError(null);

      const run = async (): Promise<CommitResult> => {
        let applied = 0;
        let writing = '';
        try {
          if (sessionId === null || route === null) {
            throw new Error('The values cannot be changed now.');
          }
          if (route === 'element') {
            const groups = new Map<string, ElementGroup>();
            for (const e of edits) {
              const model = modelOf(e.row);
              const idx = idxOf(e.row);
              const key = `${model}\u0000${idx}`;
              const group = groups.get(key) ?? { model, idx, params: {}, count: 0 };
              group.params[e.column.edit?.param ?? e.column.key] = e.value;
              group.count += 1;
              groups.set(key, group);
            }
            for (const group of groups.values()) {
              writing = `${Object.keys(group.params).join(', ')} of ${group.model} ${group.idx}`;
              await editElement.mutateAsync({
                sessionId,
                model: group.model,
                idx: group.idx,
                params: group.params,
              });
              applied += group.count;
            }
          } else {
            for (const e of edits) {
              const model = modelOf(e.row);
              const idx = idxOf(e.row);
              const param = e.column.edit?.param ?? e.column.key;
              writing = `${param} of ${model} ${idx}`;
              await cloneEdit.mutateAsync({ sessionId, model, idx, param, value: e.value });
              applied += 1;
            }
          }
          return { applied, failed: false };
        } catch (err) {
          const partial =
            edits.length > 1 ? ` ${applied} of ${edits.length} values were written before it.` : '';
          setError(`Could not set ${writing || 'the value'}. ${reasonOf(err)}${partial}`);
          return { applied, failed: true };
        } finally {
          // Wait for the read of the topology that follows a write, so the cell
          // shows what was written when it stops being marked as pending. The
          // write's own hook has asked for that read already: join it, rather
          // than cancel it for another.
          if (sessionId !== null) {
            await queryClient.invalidateQueries(
              { queryKey: queryKeys.topology(sessionId) },
              { cancelRefetch: false },
            );
          }
          setPending((prev) => {
            const next = new Set(prev);
            for (const key of keys) next.delete(key);
            return next;
          });
        }
      };

      const result = chain.current.then(run);
      chain.current = result;
      return result;
    },
    [sessionId, route, modelOf, idxOf, editElement, cloneEdit, queryClient],
  );

  const dismissError = useCallback(() => setError(null), []);

  let hint: string | undefined;
  if (route === 'clone') hint = CLONE_HINT;
  else if (route === 'element') hint = controllers ? CONTROLLER_EDIT_HINT : EDIT_HINT;
  else hint = lockedReason ?? undefined;

  const barExtra =
    controllers || lockedByRun ? (
      <>
        {controllers ? <EditModeToggle /> : null}
        {lockedByRun ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={resetRun.isPending || sessionId === null}
            onClick={() => {
              if (sessionId !== null) resetRun.mutate(sessionId);
            }}
            title="Reload the case from its file so the values can be changed. The run's results stay in History; the changes made so far are discarded."
            data-testid="grid-reset-run"
            className="h-6 px-2"
          >
            {resetRun.isPending ? 'Resetting…' : 'Reset run'}
          </Button>
        ) : null}
      </>
    ) : undefined;

  return { canEdit, commit, pending, error, dismissError, lockedReason, hint, barExtra };
}
