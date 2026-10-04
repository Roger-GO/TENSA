/**
 * The rows of the power-flow system summary, and the words around them. Pure and
 * import-clean so the panel and its CSV export read one set of rows.
 */
import type { PflowSummary } from '@/api/types';

export interface SummaryRow {
  /** Stable id, for keys and test ids. */
  id: 'generation' | 'load' | 'shunt' | 'loss' | 'slack';
  label: string;
  /** What the row stands for, for its tooltip. */
  title: string;
  /** Active power, MW. `null` where there is nothing to show (no slack). */
  p: number | null;
  /** Reactive power, MVAr. */
  q: number | null;
}

/** The rows in the order they add up: generation = load + shunts + losses. */
export function summaryRows(summary: PflowSummary): SummaryRow[] {
  return [
    {
      id: 'generation',
      label: 'Generation',
      title: 'What the in-service generators produce.',
      p: summary.generation_p,
      q: summary.generation_q,
    },
    {
      id: 'load',
      label: 'Load',
      title: 'What the loads draw at the solved voltages.',
      p: summary.load_p,
      q: summary.load_q,
    },
    {
      id: 'shunt',
      label: 'Bus shunts',
      title:
        'What the shunts absorb. A capacitor supplies reactive power, so its Q reads negative.',
      p: summary.shunt_p,
      q: summary.shunt_q,
    },
    {
      id: 'loss',
      label: 'Line losses',
      title:
        'What the lines and transformers absorb: active power as heat, reactive power net of their charging (negative when charging dominates).',
      p: summary.loss_p,
      q: summary.loss_q,
    },
    {
      id: 'slack',
      label: 'of which slack',
      title:
        'The part of the generation the slack generator makes up: whatever the other generators and the loads leave it, losses included.',
      p: summary.slack_p ?? null,
      q: summary.slack_q ?? null,
    },
  ];
}

/** Active losses as a share of the active generation, or `null` without generation. */
export function lossShare(summary: PflowSummary): number | null {
  if (!(summary.generation_p > 0)) return null;
  return (summary.loss_p / summary.generation_p) * 100;
}
