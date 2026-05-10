/**
 * Tests for ``<PropertiesAccordion />`` (v3 Unit 8).
 *
 * The accordion section wraps ``ElementFormFields``; the bulk of the
 * form-by-type rendering lives there (and is exercised by
 * ElementInspector tests). This file pins the accordion shell to the
 * promised contract: switching the selected element kind swaps the form
 * shape; no selection → placeholder copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

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

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    {
      idx: 1,
      name: 'Bus1',
      kind: 'Bus',
      params: { Vn: 138.0, vmax: 1.05, vmin: 0.95 },
    },
  ],
  lines: [],
  transformers: [],
  generators: [
    {
      idx: 'G1',
      name: 'Gen1',
      kind: 'PV',
      params: { bus: 1, p0: 232 },
    },
  ],
  loads: [],
};

function seedLoadedCase() {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    layoutSidecar: null,
    selectedElement: null,
  });
  mockTopology = TOPOLOGY;
}

describe('<PropertiesAccordion />', () => {
  beforeEach(() => {
    mockTopology = null;
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    cleanup();
    mockTopology = null;
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it('shows placeholder text when no element is selected', () => {
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByTestId('properties-accordion')).toBeInTheDocument();
    expect(screen.getByText(/select an element on the canvas/i)).toBeInTheDocument();
  });

  it('renders bus form fields when a bus is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByTestId('inspector-properties')).toBeInTheDocument();
    expect(screen.getByText('Vn')).toBeInTheDocument();
    expect(screen.getByText('vmax')).toBeInTheDocument();
  });

  it('renders generator form fields when a generator is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(withQueryClient(<PropertiesAccordion />));
    expect(screen.getByTestId('inspector-properties')).toBeInTheDocument();
    expect(screen.getByText('bus')).toBeInTheDocument();
    expect(screen.getByText('p0')).toBeInTheDocument();
  });
});
