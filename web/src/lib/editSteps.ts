/**
 * What one edit to the system did, in words, for the Undo and Redo commands and
 * the notes they leave. An edit is what the topology's `undo` and `redo` name: an
 * element added, changed or deleted before a run (`EditStep`).
 */
import type { EditStep } from '@/api/types';

/** "Bus 15", or the model alone for an element the server gave no idx for. */
function elementName(step: Pick<EditStep, 'model' | 'idx'>): string {
  return step.idx == null ? step.model : `${step.model} ${String(step.idx)}`;
}

/**
 * What a change of values was made to: "Vn of Bus 1", "r, x, b and 2 more of
 * Line Line_3", or the element alone when no param is named.
 */
export function describeChanged(step: Pick<EditStep, 'model' | 'idx' | 'params'>): string {
  const name = elementName(step);
  const params = step.params ?? [];
  // A paste can change a dozen values of one device; name three and count the rest.
  const named = params.slice(0, 3).join(', ');
  const more = params.length > 3 ? ` and ${params.length - 3} more` : '';
  return params.length === 0 ? name : `${named}${more} of ${name}`;
}

/**
 * The edit as a short phrase that reads after "Undo:" or "Redone:":
 * "add Bus 15", "change Vn of Bus 1", "delete Bus 3 and 4 more". Short, since a
 * menu item holds it.
 */
export function describeStep(step: EditStep): string {
  const name = elementName(step);
  if (step.op === 'add') return `add ${name}`;
  if (step.op === 'edit') return `change ${describeChanged(step)}`;
  return step.also > 0 ? `delete ${name} and ${step.also} more` : `delete ${name}`;
}
