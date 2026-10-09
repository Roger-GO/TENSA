/**
 * What is done to a draft from more than one place: the diagram, the list of
 * drafts above it, the Inspector and the palette. Each reads and writes the
 * stores directly, so it can be called from a handler anywhere.
 *
 * A draft holds what was typed into it, so deleting one can be taken back in
 * two ways: by the Undo of the notice, which stays long enough to be read,
 * and by Undo in the Edit menu (Ctrl/Cmd+Z), which is where a user looks once
 * the notice is gone. The second is the layout history's (`LayoutStep.drafts`):
 * a delete is recorded there as one step, and the canvas takes it back.
 */
import { toast } from '@/lib/toast';
import { UNDO } from '@/lib/undoWording';
import { useCaseStore } from '@/store/case';
import { DRAFT_NODE_SIZE, draftCaseKey, useDraftsStore, type DraftElement } from '@/store/drafts';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { useSldStore } from '@/store/sld';

/** How long the notice of a deleted draft stays, with its Undo: long enough to read and reach. */
export const DRAFT_DELETED_NOTICE_MS = 12_000;

/** The Undo that is there after the notice has gone, said in the notice. */
const UNDO_LATER = `${UNDO} brings it back as well.`;

/**
 * Record that `deleted` were deleted from the case `caseKey`, as one step of
 * the history Undo goes back through. Answers the id of the step.
 */
function recordDeleted(caseKey: string, label: string, deleted: DraftElement[]): number {
  // The arrangement is not changed by the delete, and is not put back with it.
  return useLayoutHistoryStore
    .getState()
    .record(label, { positions: {}, routes: {} }, null, { caseKey, deleted });
}

/** Put `deleted` back by the Undo of their notice, and take the step for it out of the history. */
function putBack(caseKey: string, deleted: DraftElement[], step: number): void {
  // Undo in the Edit menu took the delete back already: its step waits for a
  // Redo, the drafts are there, and putting them back again would make a
  // second copy of each.
  if (useLayoutHistoryStore.getState().future.some((entry) => entry.id === step)) return;
  const back = useDraftsStore.getState().restore(caseKey, deleted);
  useLayoutHistoryStore.getState().forget(step);
  if (back.length === 1) selectDraft(back[0]!.id);
}

/**
 * Pick the draft `id`: the Inspector shows its form, and the diagram marks
 * it. `from: 'diagram'` says the pick was made on the diagram itself, which
 * then keeps its zoom (`store/sld.ts`). The element that was inspected is let
 * go of, so that the Inspector does not go back to it when the draft goes.
 */
export function selectDraft(id: string, from?: 'diagram'): void {
  useCaseStore.getState().setSelectedElement(null);
  useSldStore.getState().setSelectedNodeId(id, from);
}

/** Let go of the draft `id` if it is the one that is picked. */
export function deselectDraft(id: string): void {
  if (useSldStore.getState().selectedNodeId === id) useSldStore.getState().clearSelectedNodeId();
}

/**
 * Place a draft of `kind` on the open case where there is no diagram to drop
 * it on yet (a system with nothing in it, or one that was just started for
 * it): at the middle of the diagram that is drawn for it, and picked, so the
 * Inspector opens on its form. `null` with no case open.
 */
export function placeDraftOffCanvas(kind: string): DraftElement | null {
  const caseKey = draftCaseKey(useCaseStore.getState().selection);
  if (caseKey === null) return null;
  const draft = useDraftsStore
    .getState()
    .add(caseKey, kind, { x: -DRAFT_NODE_SIZE.width / 2, y: -DRAFT_NODE_SIZE.height / 2 });
  if (draft === null) {
    toast.error('This diagram holds as many drafts as it can.', {
      description: 'Add some of them to the system, or delete the ones you do not need.',
    });
    return null;
  }
  selectDraft(draft.id);
  return draft;
}

/**
 * Delete the draft `id` of the case `caseKey`. A draft holds what was typed
 * into it, so the notice offers to put it back.
 */
export function deleteDraft(caseKey: string, id: string, name: string): void {
  const store = useDraftsStore.getState();
  const draft = (store.byCase[caseKey] ?? []).find((d) => d.id === id);
  if (draft === undefined) return;
  store.remove(caseKey, id);
  deselectDraft(id);
  const step = recordDeleted(caseKey, `delete draft ${name}`, [draft]);
  toast.info(`Draft deleted: ${name}`, {
    description: `It was never added to the system, so nothing else changed. ${UNDO_LATER}`,
    duration: DRAFT_DELETED_NOTICE_MS,
    action: { label: 'Undo', onClick: () => putBack(caseKey, [draft], step) },
  });
}

/** Delete every draft of the case `caseKey`; the notice offers to put them back. */
export function deleteAllDrafts(caseKey: string): void {
  const store = useDraftsStore.getState();
  const drafts = store.byCase[caseKey] ?? [];
  if (drafts.length === 0) return;
  store.removeAll(caseKey);
  for (const draft of drafts) deselectDraft(draft.id);
  const step = recordDeleted(caseKey, `delete ${drafts.length} drafts`, [...drafts]);
  toast.info(`${drafts.length} drafts deleted`, {
    description: `None of them was added to the system, so nothing else changed. ${UNDO_LATER}`,
    duration: DRAFT_DELETED_NOTICE_MS,
    action: { label: 'Undo', onClick: () => putBack(caseKey, [...drafts], step) },
  });
}
