/**
 * What is done to a draft from more than one place: the diagram, the list of
 * drafts above it, the Inspector and the palette. Each reads and writes the
 * stores directly, so it can be called from a handler anywhere.
 */
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { DRAFT_NODE_SIZE, draftCaseKey, useDraftsStore, type DraftElement } from '@/store/drafts';
import { useSldStore } from '@/store/sld';

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
  toast.info(`Draft deleted: ${name}`, {
    description: 'It was never added to the system, so nothing else changed.',
    action: {
      label: 'Undo',
      onClick: () => {
        const back = useDraftsStore
          .getState()
          .add(caseKey, draft.kind, draft.position, draft.values);
        if (back !== null) selectDraft(back.id);
      },
    },
  });
}

/** Delete every draft of the case `caseKey`; the notice offers to put them back. */
export function deleteAllDrafts(caseKey: string): void {
  const store = useDraftsStore.getState();
  const drafts = store.byCase[caseKey] ?? [];
  if (drafts.length === 0) return;
  store.removeAll(caseKey);
  for (const draft of drafts) deselectDraft(draft.id);
  toast.info(`${drafts.length} drafts deleted`, {
    description: 'None of them was added to the system, so nothing else changed.',
    action: {
      label: 'Undo',
      onClick: () => {
        const add = useDraftsStore.getState().add;
        for (const draft of drafts) add(caseKey, draft.kind, draft.position, draft.values);
      },
    },
  });
}
