import { useCallback, useMemo, useState } from 'react';
import { ProblemDetailsError } from '@/api/client';
import { useAddElement, useCurrentTopology, useTopologySchema } from '@/api/queries';
import type { ParamValue } from '@/api/types';
import { ElementForm } from '@/components/elements/ElementForm';
import { ElementKindGlyph } from '@/components/elements/ElementKindGlyph';
import { deleteDraft, deselectDraft } from '@/components/sld/draftActions';
import {
  DRAFT_NODE_SIZE,
  addedElement,
  addedNodeId,
  draftDefaults,
  draftKind,
  draftName,
  draftReservedIdxs,
  draftStatus,
  draftSummary,
} from '@/components/sld/drafts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { useResetRunAction } from '@/lib/useResetRunAction';
import { useCaseStore } from '@/store/case';
import { useDrafts, useDraftsStore, type DraftElement } from '@/store/drafts';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';

/**
 * DraftInspector: the Inspector of a draft, an element that was placed on
 * the diagram and is not in the system yet (`store/drafts.ts`).
 *
 * It is the form the Add element panel shows for the kind (`ElementForm`),
 * held otherwise: in the Inspector beside the diagram, which stays in use
 * while it is filled in, and checked as it is typed. An empty required field
 * says so from the start, the line above the buttons names what is still
 * missing, and Add to system is off until nothing is. Every field that is
 * set is kept with the draft at once, so the draft can be left and come back
 * to: another element can be inspected, the page reloaded.
 *
 * Add to system sends the draft to the server, which is the first the server
 * hears of it. When it is taken, the draft goes, the element stands where
 * the draft stood (`placements`, for a kind that is a node of the diagram)
 * and is selected in its place. What the server refuses shows above the
 * buttons and the draft stays as it is.
 *
 * While the system takes no new element (a run has set it up), the form
 * says why, and offers the reset that undoes that.
 */

const LOCKED_BY_RUN =
  'A run has set the system up, which locks its elements. Reset the run to add this draft; it is kept meanwhile.';

export interface DraftInspectorProps {
  draft: DraftElement;
  /** The key the drafts of the open case are kept under (`draftCaseKey`). */
  caseKey: string;
  className?: string;
}

export function DraftInspector({ draft, caseKey, className }: DraftInspectorProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const topology = useCurrentTopology();
  const schema = useTopologySchema();
  const pfRunning = usePflowStore((s) => s.isRunning);
  const addMutation = useAddElement();
  const resetRun = useResetRunAction({ errorTitle: 'Reset run', confirm: true });
  const [serverError, setServerError] = useState<string | null>(null);
  const clearServerError = useCallback(() => setServerError(null), []);

  const kind = draftKind(draft);
  // The idx its form opens with is the next free one past the other drafts'.
  const drafts = useDrafts();
  const reservedIdxs = useMemo(
    () => draftReservedIdxs(drafts, topology).get(draft.id),
    [drafts, topology, draft.id],
  );
  const status = draftStatus(draft, schema.data, topology, reservedIdxs);
  const name = draftName(draft, status);
  const lockedByRun = topology?.state === 'committed';
  const blockedReason =
    sessionId === null
      ? 'The server session is not ready yet.'
      : lockedByRun
        ? LOCKED_BY_RUN
        : pfRunning
          ? 'Wait for the power flow to finish.'
          : null;

  const draftId = draft.id;
  const onFieldsChange = useCallback(
    (patch: Record<string, ParamValue | null>) => {
      useDraftsStore.getState().setValues(caseKey, draftId, patch);
    },
    [caseKey, draftId],
  );
  const remove = () => deleteDraft(caseKey, draft.id, name);

  const header = (
    <header
      data-testid="draft-inspector-header"
      className="border-border bg-background flex items-center gap-2 border-b px-3 py-2.5"
    >
      <span className="text-primary flex shrink-0">
        <ElementKindGlyph kind={draft.kind} className="h-4 w-4" />
      </span>
      <span
        className={cn(
          'rounded-[var(--radius-sm)] border border-dashed px-1.5 py-px',
          'border-primary/50 bg-primary/10 text-primary',
          'text-[9px] font-semibold tracking-[0.1em] uppercase',
        )}
      >
        Draft
      </span>
      <p className="text-foreground min-w-0 truncate text-sm font-semibold">{name}</p>
      <span
        data-testid="draft-inspector-status"
        className={cn(
          'ml-auto shrink-0 rounded-[var(--radius-sm)] px-1.5 py-px',
          'text-[9px] leading-tight font-semibold tracking-[0.06em] uppercase',
          status?.ready === true
            ? 'bg-success text-success-foreground'
            : 'bg-warning text-warning-foreground',
        )}
      >
        {status?.ready === true ? 'Ready' : 'Incomplete'}
      </span>
    </header>
  );

  if (kind === null) {
    // A draft of a kind the app no longer offers: it can only be deleted.
    return (
      <div data-testid="draft-inspector" className={cn('flex h-full min-h-0 flex-col', className)}>
        {header}
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-foreground text-xs leading-snug">
            This draft is of a kind ({draft.kind}) that can no longer be added.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={remove}>
            Delete draft
          </Button>
        </div>
      </div>
    );
  }

  const model = kind.submitModel;
  // What the form opens with besides the next free idx, as the Add element
  // panel has it: sent with the add where the form left the field empty.
  const defaults = draftDefaults(kind, topology?.base_mva ?? null);
  const handleSubmit = (params: Record<string, ParamValue>) => {
    if (sessionId === null || blockedReason !== null) return;
    setServerError(null);
    const finalParams = defaults ? { ...defaults, ...params } : params;
    const middle = {
      x: draft.position.x + DRAFT_NODE_SIZE.width / 2,
      y: draft.position.y + DRAFT_NODE_SIZE.height / 2,
    };
    addMutation.mutate(
      { sessionId, body: { model, params: finalParams } },
      {
        onSuccess: () => {
          const idx = String(finalParams.idx ?? '');
          const nodeId = addedNodeId(model, idx);
          const drafts = useDraftsStore.getState();
          // The element takes the place its draft stood in, and the draft goes.
          if (nodeId !== null) drafts.place(nodeId, middle);
          drafts.remove(caseKey, draft.id);
          deselectDraft(draft.id);
          const element = addedElement(model, finalParams);
          if (element !== null) {
            useCaseStore.getState().setSelectedElement(element);
            if (nodeId !== null) useSldStore.getState().setSelectedNodeId(nodeId, 'diagram');
          }
          toast.success(`Added to the system: ${name}`, {
            description:
              'It is an element of the system now, selected in the Inspector. Undo in the Edit menu takes the add back.',
          });
        },
        onError: (err) => {
          if (err instanceof ProblemDetailsError) {
            setServerError(
              err.status === 409 ? LOCKED_BY_RUN : (err.detail ?? err.title ?? 'Add rejected'),
            );
          } else {
            setServerError(err.message ?? 'Add failed');
          }
        },
      },
    );
  };

  return (
    <div data-testid="draft-inspector" className={cn('flex h-full min-h-0 flex-col', className)}>
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p
          data-testid="draft-inspector-note"
          className={cn(
            'border-border bg-muted/40 text-foreground',
            'rounded-[var(--radius-sm)] border border-dashed px-2 py-1.5 text-[11px] leading-snug',
          )}
        >
          A draft is on the diagram but not in the system: no run sees it. What you enter here is
          kept in this browser as you type.{' '}
          <span data-testid="draft-inspector-summary" className="font-semibold">
            {status?.ready === true ? 'Ready: press Add to system.' : `${draftSummary(status)}.`}
          </span>
        </p>
        {lockedByRun ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetRun.reset}
            disabled={resetRun.isPending}
            data-testid="draft-inspector-reset-run"
            className="self-start"
          >
            {resetRun.isPending ? 'Resetting…' : 'Reset run'}
          </Button>
        ) : null}
        <ElementForm
          // The form of another draft is another form.
          key={draft.id}
          model={model}
          kindHint={kind.value}
          defaultParams={defaults}
          live
          heldValues={draft.values}
          reservedIdxs={reservedIdxs}
          onFieldsChange={onFieldsChange}
          submitLabel="Add to system"
          cancelLabel="Delete draft"
          blockedReason={blockedReason}
          saving={addMutation.isPending}
          serverError={serverError}
          onSubmit={handleSubmit}
          onCancel={remove}
          onEdit={clearServerError}
        />
      </div>
    </div>
  );
}
