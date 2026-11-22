/**
 * The compare view's open flag and the state of its two sides, tolerances and
 * series selection. A store flag, as the other overlays' are
 * (``reportDialog.ts``, ``bundle.ts``), so the command and the plot's export
 * menu open the view without importing it.
 *
 * Not persisted: only finished runs and kept power flows go to IndexedDB.
 * The sides and tolerances survive a close (as the pflow compare pickers
 * survive through their store); the series selection does not.
 */
import { create } from 'zustand';

export type CompareSource = { kind: 'run'; runId: string } | { kind: 'file'; file: File };

export type CompareSideName = 'reference' | 'comparison';

export interface CompareViewState {
  open: boolean;
  referenceSource: CompareSource | null;
  comparisonSource: CompareSource | null;
  /** Per-quantity tolerance text; an absent row is at its default. */
  quantityTolerances: Record<string, string>;
  frequencyHz: string;
  dampingRatio: string;
  maxModeDistance: string;
  /** The ``${quantity}|${key}`` of the series row whose overlay is drawn. */
  selectedSeriesKey: string | null;
  openCompareView: () => void;
  closeCompareView: () => void;
  setSide: (side: CompareSideName, source: CompareSource | null) => void;
  setQuantityTolerance: (quantity: string, text: string) => void;
  setToleranceField: (
    field: 'frequencyHz' | 'dampingRatio' | 'maxModeDistance',
    text: string,
  ) => void;
  selectSeries: (key: string | null) => void;
}

export const useCompareViewStore = create<CompareViewState>((set) => ({
  open: false,
  referenceSource: null,
  comparisonSource: null,
  quantityTolerances: {},
  frequencyHz: '0.02',
  dampingRatio: '0.02',
  maxModeDistance: '0.05',
  selectedSeriesKey: null,
  openCompareView: () => set({ open: true }),
  closeCompareView: () => set({ open: false, selectedSeriesKey: null }),
  setSide: (side, source) =>
    set(side === 'reference' ? { referenceSource: source } : { comparisonSource: source }),
  setQuantityTolerance: (quantity, text) =>
    set((s) => ({ quantityTolerances: { ...s.quantityTolerances, [quantity]: text } })),
  setToleranceField: (field, text) => set({ [field]: text }),
  selectSeries: (key) => set({ selectedSeriesKey: key }),
}));
