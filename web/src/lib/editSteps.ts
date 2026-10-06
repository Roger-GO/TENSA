/**
 * What one edit to the system did, in words, for the Undo and Redo commands and
 * the notes they leave. An edit is what the topology's `undo` and `redo` name: an
 * element added, changed or deleted before a run (`EditStep`).
 */
import type { EditStep } from '@/api/types';

/** "Bus 15", or the model alone for an element the server gave no idx for. */
function elementName(step: EditStep): string {
  return step.idx == null ? step.model : `${step.model} ${String(step.idx)}`;
}

/**
 * The edit as a short phrase that reads after "Undo:" or "Redone:":
 * "add Bus 15", "change Vn of Bus 1", "delete Bus 3 and 4 more". Short, since a
 * menu item holds it.
 */
export function describeStep(step: EditStep): string {
  const name = elementName(step);
  if (step.op === 'add') return `add ${name}`;
  if (step.op === 'edit') {
    const params = step.params ?? [];
    // A paste can change a dozen values of one device; name three and count the rest.
    const named = params.slice(0, 3).join(', ');
    const more = params.length > 3 ? ` and ${params.length - 3} more` : '';
    return params.length === 0 ? `change ${name}` : `change ${named}${more} of ${name}`;
  }
  return step.also > 0 ? `delete ${name} and ${step.also} more` : `delete ${name}`;
}
