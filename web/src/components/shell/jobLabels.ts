/**
 * Job-kind label helpers (v3.1 Phase 3, Unit 11).
 *
 * Shared between ``ActivityPanel`` (long, descriptive labels) and
 * ``InFlightChip`` (short, TopBar-compact labels). Lives in its own module
 * so neither component file violates ``react-refresh/only-export-components``
 * by exporting a non-component helper.
 */
import type { JobKind } from '@/store/jobs';

/**
 * Human-readable label per ``JobKind``. Falls back to a title-cased version
 * of the raw kind so a forward-compat kind from the wire still renders
 * sensibly (the union is open at the store layer).
 */
const KIND_LABELS: Partial<Record<JobKind, string>> = {
  pflow: 'Power flow',
  'tds-batch': 'TDS (batch)',
  'tds-stream': 'TDS',
  eig: 'Eigenvalue analysis',
  cpf: 'CPF',
  'cpf-qv': 'CPF (QV)',
  se: 'State estimation',
  'se-measurements': 'SE measurements',
  sweep: 'Parameter sweep',
  'snapshot-save': 'Save snapshot',
  'snapshot-restore': 'Restore snapshot',
  'snapshot-delete': 'Delete snapshot',
  'bundle-export': 'Export bundle',
  'bundle-import': 'Import bundle',
  'case-load': 'Load case',
  'case-reload': 'Reload case',
  'case-save': 'Save case',
  'element-add': 'Add element',
  'element-edit': 'Edit element',
  'element-delete': 'Delete element',
  'element-undo': 'Undo edit',
  'disturbance-commit': 'Commit disturbances',
  'pmu-add': 'Add PMU',
  'pmu-delete': 'Delete PMU',
  'profile-upload': 'Upload profile',
  'profile-add': 'Add profile',
  'profile-delete': 'Delete profile',
};

export function kindLabel(kind: JobKind): string {
  return (
    KIND_LABELS[kind] ??
    kind
      .split('-')
      .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' ')
  );
}

/**
 * Short kind label for the in-flight chip's single-job case ("Running PF…").
 * Distinct from the long Activity-panel label so the chip stays compact in
 * the TopBar.
 */
const SHORT_KIND_LABELS: Partial<Record<JobKind, string>> = {
  pflow: 'PF',
  'tds-batch': 'TDS',
  'tds-stream': 'TDS',
  eig: 'EIG',
  cpf: 'CPF',
  'cpf-qv': 'CPF',
  se: 'SE',
  sweep: 'sweep',
};

export function shortKindLabel(kind: JobKind): string {
  return SHORT_KIND_LABELS[kind] ?? kindLabel(kind);
}
