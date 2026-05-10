/**
 * AddElementPanel — slide-over for adding new topology elements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';
import type { TopologySchema, TopologySummary } from '@/api/types';

// Schema fixture covering Bus + Line; mirrored from the server's
// _PARAMS_BY_MODEL table.
const SCHEMA: TopologySchema = {
  models: {
    Bus: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'Vn', kind: 'number', required: true, unit: 'kV' },
      { name: 'vmax', kind: 'number', required: false, unit: 'pu' },
    ],
    Line: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus1', kind: 'bus_idx', required: true },
      { name: 'bus2', kind: 'bus_idx', required: true },
      { name: 'r', kind: 'number', required: true, unit: 'pu' },
      { name: 'x', kind: 'number', required: true, unit: 'pu' },
    ],
  },
};

const postSpy = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: () => Promise.resolve(SCHEMA),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return Promise.resolve({
          element: { idx: '1', name: 'BUS1', kind: 'Bus', params: { Vn: 110 } },
        });
      },
      put: vi.fn(),
    },
  };
});

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTopologySchema: () => ({ data: SCHEMA, isLoading: false, isError: false }),
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

let MOCK_TOPOLOGY: TopologySummary | null = null;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelDropCoord: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
});

describe('<AddElementPanel />', () => {
  it('renders nothing when closed', () => {
    render(withQueryClient(<AddElementPanel />));
    expect(screen.queryByTestId('add-element-panel')).toBeNull();
  });

  it('opens when addPanelOpen=true and shows the kind picker', () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: null });
    render(withQueryClient(<AddElementPanel />));
    expect(screen.getByTestId('add-element-panel')).toBeInTheDocument();
    expect(screen.getByTestId('add-element-kind')).toBeInTheDocument();
  });

  it('renders the Bus form with required fields when kind=Bus', async () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => {
      expect(screen.getByTestId('element-form-Bus')).toBeInTheDocument();
    });
    expect(screen.getByTestId('field-Vn')).toBeInTheDocument();
    expect(screen.getByTestId('field-idx')).toBeInTheDocument();
    expect(screen.getByTestId('field-name')).toBeInTheDocument();
    // Optional field is collapsed under "Show advanced".
    expect(screen.getByTestId('form-advanced-disclosure')).toBeInTheDocument();
  });

  it('submits the Bus form happy path', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    // idx is prefilled to "1" since the topology has no buses; clear
    // before typing so we don't end up with "11".
    const idxInput = screen.getByTestId('field-idx').querySelector('input')!;
    await user.clear(idxInput);
    await user.type(idxInput, '1');
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'BUS1');
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '110');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [path, body] = postSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/elements');
    expect(body).toEqual({
      model: 'Bus',
      params: { idx: '1', name: 'BUS1', Vn: 110 },
    });
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });

  it('rejects submit when a required field is empty', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(postSpy).not.toHaveBeenCalled();
    // The form's per-field error rendered.
    const errors = await screen.findAllByText(/required/i);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('shows "Add a Bus first" empty state on bus_idx field with no buses', async () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Line' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Line'));
    expect(screen.getAllByText(/add a bus first/i).length).toBeGreaterThan(0);
  });

  it('cancel on a clean form closes silently (no confirm dialog)', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(screen.queryByTestId('add-element-cancel-confirm')).toBeNull();
  });

  // ---- v3 Unit 5 — dropCoord seed ---------------------------------------

  it('renders the drop-position hint when kind=Bus AND addPanelDropCoord is set', async () => {
    useCaseStore.setState({
      addPanelOpen: true,
      addPanelKind: 'Bus',
      addPanelDropCoord: { x: 123, y: 456 },
    });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    const hint = screen.getByTestId('add-element-drop-coord');
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toMatch(/x=123/);
    expect(hint.textContent).toMatch(/y=456/);
  });

  it('omits the drop-position hint when kind=Bus but no dropCoord (non-DnD open)', async () => {
    useCaseStore.setState({
      addPanelOpen: true,
      addPanelKind: 'Bus',
      addPanelDropCoord: null,
    });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    expect(screen.queryByTestId('add-element-drop-coord')).toBeNull();
  });

  it('omits the drop-position hint for non-Bus kinds even with a dropCoord set', async () => {
    // Generator drop should NOT render the Bus-only position hint —
    // non-Bus elements anchor to a parent bus, so a free coordinate
    // doesn't apply. The panel must not crash and must not surface
    // the hint.
    useCaseStore.setState({
      addPanelOpen: true,
      addPanelKind: 'PV',
      addPanelDropCoord: { x: 7, y: 8 },
    });
    render(withQueryClient(<AddElementPanel />));
    expect(screen.getByTestId('add-element-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('add-element-drop-coord')).toBeNull();
  });

  it('cancel on a dirty form opens the confirm dialog; Discard closes', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '99');
    expect(useCaseStore.getState().addPanelDirty).toBe(true);
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByTestId('add-element-cancel-confirm')).toBeInTheDocument();
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
    await user.click(screen.getByTestId('confirm-discard'));
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });
});
