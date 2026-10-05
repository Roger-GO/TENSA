/**
 * What ANDES said while a command ran, read as the Messages tab shows it.
 *
 * Pure helpers over the messages `GET /sessions/{id}/messages` returns: the
 * level order, the label of the command a message came from, the clock time, the
 * filter, the count per level and the text the Copy button puts on the clipboard.
 */
import type { MessageLevel, SessionMessage } from '@/api/types';

/** Lowest first, the order the server ranks them in. */
export const MESSAGE_LEVELS: readonly MessageLevel[] = ['info', 'warning', 'error'];

export const LEVEL_LABEL: Record<MessageLevel, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

/** The command names the worker puts in a message's `source`, in plain words. */
const SOURCE_LABELS: Record<string, string> = {
  load_case: 'Load case',
  reload_case: 'Reload case',
  run_pflow: 'Power flow',
  run_tds: 'Time domain',
  run_eig: 'Eigenvalues',
  run_cpf: 'CPF',
  run_cpf_qv: 'CPF (QV)',
  run_se: 'State estimation',
  generate_measurements_from_pflow: 'SE measurements',
  restore_snapshot: 'Restore snapshot',
  save_snapshot: 'Save snapshot',
  import_bundle: 'Import bundle',
  export_bundle: 'Export bundle',
  save_case: 'Save case',
  create_blank: 'New case',
  add_element: 'Add element',
  edit_element: 'Edit element',
  delete_element: 'Delete element',
  add_disturbance: 'Add disturbance',
  init_clone: 'Start parameter edits',
  apply_clone_edit: 'Edit parameter',
  reset_clone: 'Discard parameter edits',
  save_clone_as: 'Save parameter edits',
  compute_connectivity: 'Connectivity',
};

/** `Power flow` for `run_pflow`; a command this build does not know reads as its name, spaced. */
export function sourceLabel(source: string): string {
  if (source === '') return '';
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The time of day a message was logged, as `HH:MM:SS` in the viewer's time zone. */
export function formatMessageTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export interface LevelCounts {
  info: number;
  warning: number;
  error: number;
}

export function countByLevel(messages: readonly SessionMessage[]): LevelCounts {
  const counts: LevelCounts = { info: 0, warning: 0, error: 0 };
  for (const m of messages) counts[m.level] += 1;
  return counts;
}

/** The words of a filter box: lower-cased, split on whitespace, empty ones dropped. */
export function filterWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
}

/**
 * Whether a message passes the filter: every word is found in its text, in the
 * label of its command or in the name of the ANDES logger that said it.
 */
export function matchesWords(message: SessionMessage, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack =
    `${message.text}\n${sourceLabel(message.source)}\n${message.source}\n${message.logger}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** Messages at the levels shown whose words match, oldest first as they came. */
export function visibleMessages(
  messages: readonly SessionMessage[],
  shown: Readonly<Record<MessageLevel, boolean>>,
  query: string,
): SessionMessage[] {
  const words = filterWords(query);
  return messages.filter((m) => shown[m.level] && matchesWords(m, words));
}

/**
 * The messages as plain text for the clipboard: one block per message, its
 * first line led by the time, the level and the command, a table's later lines
 * as they came.
 */
export function messagesToText(messages: readonly SessionMessage[]): string {
  return messages
    .map((m) => {
      const source = sourceLabel(m.source);
      const lead = [formatMessageTime(m.time), LEVEL_LABEL[m.level].toUpperCase()];
      if (source !== '') lead.push(source);
      const repeat = m.repeat > 1 ? ` (x${m.repeat})` : '';
      return `${lead.join('  ')}  ${m.text}${repeat}`;
    })
    .join('\n');
}
