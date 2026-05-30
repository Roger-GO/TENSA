/**
 * Tests for dynamic-controller inspection (v3.1 Unit 18).
 *
 * Unit 18 widens ``SelectedElement`` to a discriminated union that includes
 * a ``'controller'`` variant (with a ``subKind``), resolves the
 * ``topology.controllers`` bucket in ``bucketFor``, and surfaces the
 * sub-kind in the ``RightInspector`` header. This file pins:
 *
 *   - selecting a controller idx renders its params in the Properties body
 *     (the same param-by-type rendering used for static elements, because
 *     ``paramMetas`` keys on the matched entry's real ``kind``);
 *   - the header eyebrow reads the controller's sub-kind ("Exciter",
 *     "Governor", …) rather than the generic "Controller";
 *   - an unknown controller class still renders (empty-params branch);
 *   - the pure ``subKindForControllerClass`` / ``controllerSubKindLabel``
 *     classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import {
  controllerSubKindLabel,
  subKindForControllerClass,
} from '@/lib/controllers';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({ data: undefined }),
    useReloadCase: () => ({ mutate: () => {}, isPending: false }),
  };
});

import { PropertiesAccordion } from '@/components/inspector/PropertiesAccordion';
import { RightInspector } from '@/components/inspector/RightInspector';

// kundur_full's dynamic stack: an IEEE Type-1 exciter + governor on each
// machine, plus an unknown class to exercise the fallback branch.
const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [{ idx: 1, name: 'Bus1', kind: 'Bus', params: { Vn: 230 } }],
  lines: [],
  transformers: [],
  generators: [{ idx: 'GENROU_1', name: 'Gen1', kind: 'GENROU', params: { bus: 1 } }],
  loads: [],
  controllers: [
    {
      idx: 'EXST1_1',
      name: 'EXST1 1',
      kind: 'EXST1',
      params: { syn: 'GENROU_1', Ka: 200, Ta: 0.02, Vrmax: 5, Vrmin: -5 },
    },
    {
      idx: 'IEEEG1_1',
      name: 'IEEEG1 1',
      kind: 'IEEEG1',
      params: { syn: 'GENROU_1', T1: 0.1, T2: 0, PMAX: 1.0 },
    },
    {
      idx: 'MYSTERY_1',
      name: 'Mystery 1',
      kind: 'ZZUNKNOWN',
      params: {},
    },
  ],
};

function seedLoadedCase() {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    layoutSidecar: null,
    selectedElement: null,
  });
  mockTopology = TOPOLOGY;
}

function resetStores() {
  mockTopology = null;
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useDisturbanceStore.setState({ disturbances: [] });
}

describe('controller classification', () => {
  it('maps exciter / governor / pss / renewable / measurement / profile classes', () => {
    expect(subKindForControllerClass('EXST1')).toBe('exciter');
    expect(subKindForControllerClass('IEEEX1')).toBe('exciter');
    expect(subKindForControllerClass('IEEEG1')).toBe('governor');
    expect(subKindForControllerClass('GAST')).toBe('governor');
    expect(subKindForControllerClass('IEEEST')).toBe('pss');
    expect(subKindForControllerClass('ST2CUT')).toBe('pss');
    expect(subKindForControllerClass('REGCP1')).toBe('renewable');
    expect(subKindForControllerClass('REECA1')).toBe('renewable');
    expect(subKindForControllerClass('WTDTA1')).toBe('renewable');
    expect(subKindForControllerClass('PMU')).toBe('measurement');
    expect(subKindForControllerClass('TimeSeries')).toBe('profile');
  });

  it('falls back to "other" for an unknown class', () => {
    expect(subKindForControllerClass('ZZUNKNOWN')).toBe('other');
    expect(controllerSubKindLabel('other')).toBe('Controller');
    expect(controllerSubKindLabel('exciter')).toBe('Exciter');
  });
});

describe('controller inspection — Properties body', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('renders an exciter’s params when its idx is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({
      selectedElement: { kind: 'controller', subKind: 'exciter', idx: 'EXST1_1' },
    });
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByTestId('inspector-properties')).toBeInTheDocument();
    // The matched entry's real class is shown + its model params render.
    expect(screen.getByText('EXST1')).toBeInTheDocument();
    expect(screen.getByText('Ka')).toBeInTheDocument();
    expect(screen.getByText('Ta')).toBeInTheDocument();
    expect(screen.getByText('Vrmax')).toBeInTheDocument();
  });

  it('renders a governor’s params when its idx is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({
      selectedElement: { kind: 'controller', subKind: 'governor', idx: 'IEEEG1_1' },
    });
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByText('IEEEG1')).toBeInTheDocument();
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('PMAX')).toBeInTheDocument();
  });

  it('renders the empty-params branch for an unknown controller class', () => {
    seedLoadedCase();
    useCaseStore.setState({
      selectedElement: { kind: 'controller', subKind: 'other', idx: 'MYSTERY_1' },
    });
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByText('ZZUNKNOWN')).toBeInTheDocument();
    expect(screen.getByText(/no additional parameters reported by andes/i)).toBeInTheDocument();
  });
});

describe('controller inspection — RightInspector header', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStores();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetStores();
  });

  it('shows the sub-kind eyebrow + entry name for a selected exciter', () => {
    seedLoadedCase();
    useCaseStore.setState({
      selectedElement: { kind: 'controller', subKind: 'exciter', idx: 'EXST1_1' },
    });
    render(withQueryClient(<RightInspector />));
    const header = screen.getByTestId('right-inspector-header');
    // Eyebrow reads the controller's role, not the generic "Controller".
    expect(screen.getByTestId('right-inspector-header-kind')).toHaveTextContent('Exciter');
    // The header name resolves through the controllers bucket. (The same
    // name also appears in the Properties body, so scope to the header.)
    expect(header).toHaveTextContent('EXST1 1');
  });
});
