/**
 * Tests for `<ElementFormFields />`: how the Inspector tells a first-time
 * user that a bus's voltage limits can be edited (or why they cannot yet),
 * what it says about a solved bus, and that an edit it mirrors on screen
 * never outlives the topology entry it was made on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
import type { PflowResult, TopologySummary } from '@/api/types';

const putSpy = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: (path: string, opts: { body?: { params?: Record<string, unknown> } }) => {
        putSpy(path, opts.body);
        return Promise.resolve({
          idx: 1,
          name: 'BUS1',
          kind: 'Bus',
          params: { Vn: 138, vmax: 1.1, vmin: 0.9, ...opts.body?.params },
        });
      },
    },
  };
});

let mockTopology: TopologySummary | null = null;
const reloadMutate = vi.fn();
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({
      data: {
        models: {
          Bus: [
            { name: 'Vn', kind: 'number', required: true, unit: 'kV' },
            { name: 'vmax', kind: 'number', required: false, unit: 'pu' },
            { name: 'vmin', kind: 'number', required: false, unit: 'pu' },
          ],
          Line: [{ name: 'r', kind: 'number', required: true }],
        },
      },
    }),
    useReloadCase: () => ({ mutate: reloadMutate, isPending: false }),
  };
});

import { ElementFormFields } from '@/components/inspector/ElementFormFields';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function topology(state: 'pre-setup' | 'committed' = 'pre-setup'): TopologySummary {
  return {
    state,
    buses: [
      { idx: 1, name: 'BUS1', kind: 'Bus', params: { Vn: 138, vmax: 1.1, vmin: 0.9 } },
      { idx: 2, name: 'BUS2', kind: 'Bus', params: { Vn: 138, vmax: 1.08, vmin: 0.92 } },
    ],
    lines: [{ idx: 'L1', name: 'Line1', kind: 'Line', params: { bus1: 1, bus2: 2, r: 0.02 } }],
    transformers: [],
    generators: [],
    loads: [],
  };
}

function solved(voltages: Record<string, number>): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: voltages,
    bus_angles: {},
    line_flows: {},
  };
}

function select(kind: 'bus' | 'line', idx: string) {
  useCaseStore.setState({ selectedElement: { kind, idx } });
}

describe('<ElementFormFields />', () => {
  beforeEach(() => {
    putSpy.mockClear();
    reloadMutate.mockClear();
    mockTopology = topology();
    useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      layoutSidecar: null,
      selectedElement: null,
      editMode: 'run',
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    cleanup();
    mockTopology = null;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, selectedElement: null, editMode: 'run' });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  describe('saying how to edit', () => {
    it('tells a bus how its limits are edited while the case has not been run', () => {
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.getByTestId('inspector-edit-hint')).toHaveTextContent(
        'vmin and vmax are the limits this bus is judged on. Click the pencil beside one to change it.',
      );
      expect(screen.getByTestId('edit-vmin')).toBeInTheDocument();
      expect(screen.getByTestId('edit-vmax')).toBeInTheDocument();
    });

    it('gives another element the plain hint', () => {
      select('line', 'L1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.getByTestId('inspector-edit-hint')).toHaveTextContent(
        'Click the pencil beside a value to change it.',
      );
    });

    it('does not offer a hint once a run has locked the case', () => {
      mockTopology = topology('committed');
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.queryByTestId('inspector-edit-hint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('edit-vmin')).not.toBeInTheDocument();
    });

    it('explains the lock and what resetting costs, and the button resets the run', async () => {
      const user = userEvent.setup();
      mockTopology = topology('committed');
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      const banner = screen.getByTestId('inspector-reset-banner');
      expect(banner).toHaveTextContent('A run has locked this case.');
      expect(banner).toHaveTextContent('Reset the run to edit values again');
      expect(banner).toHaveTextContent('the edits you made so far are discarded');
      await user.click(within(banner).getByRole('button', { name: 'Reset run' }));
      expect(reloadMutate).toHaveBeenCalledWith('test-session-id');
    });
  });

  it('points a locked controller at Edit mode as well as at Reset run', () => {
    mockTopology = {
      ...topology('committed'),
      controllers: [{ idx: 'EXST1_1', name: 'EXST1 1', kind: 'EXST1', params: { Ka: 200 } }],
    };
    useCaseStore.setState({
      selectedElement: {
        kind: 'controller',
        idx: 'EXST1_1',
        subKind: 'exciter',
        modelClass: 'EXST1',
      },
    });
    render(withQueryClient(<ElementFormFields />));
    const banner = screen.getByTestId('inspector-reset-banner');
    expect(banner).toHaveTextContent('Turn on Edit mode to change controller parameters');
    expect(banner).toHaveTextContent('reset the run to edit other values');
  });

  describe('a solved bus', () => {
    it('shows the voltage and where it stands against the bus limits', () => {
      mockTopology = topology('committed');
      usePflowStore.setState({ lastRun: solved({ '1': 0.85, '2': 1.0 }) });
      select('bus', '1');
      const { unmount } = render(withQueryClient(<ElementFormFields />));
      expect(screen.getByTestId('inspector-bus-voltage')).toHaveTextContent('0.8500 pu');
      expect(screen.getByTestId('inspector-bus-limit-check')).toHaveTextContent('Below vmin');
      unmount();

      select('bus', '2');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.getByTestId('inspector-bus-voltage')).toHaveTextContent('1.0000 pu');
      expect(screen.getByTestId('inspector-bus-limit-check')).toHaveTextContent('Within limits');
    });

    it('judges the bus on its own limits, not the 0.95 / 1.05 default', () => {
      mockTopology = topology('committed');
      // 0.93 is below the default band but inside BUS1's own 0.9 to 1.1.
      usePflowStore.setState({ lastRun: solved({ '1': 0.93 }) });
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.getByTestId('inspector-bus-limit-check')).not.toHaveTextContent('Below vmin');
    });

    it('says nothing before a power flow has converged', () => {
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.queryByTestId('inspector-bus-voltage')).not.toBeInTheDocument();

      cleanup();
      usePflowStore.setState({ lastRun: { ...solved({ '1': 1.0 }), converged: false } });
      render(withQueryClient(<ElementFormFields />));
      expect(screen.queryByTestId('inspector-bus-voltage')).not.toBeInTheDocument();
    });

    it('does not read a voltage into a line', () => {
      mockTopology = topology('committed');
      usePflowStore.setState({ lastRun: solved({ '1': 1.0 }) });
      select('line', 'L1');
      render(withQueryClient(<ElementFormFields />));
      expect(screen.queryByTestId('inspector-bus-voltage')).not.toBeInTheDocument();
    });
  });

  describe('an edit mirrored on screen', () => {
    async function editVmin(user: ReturnType<typeof userEvent.setup>, value: string) {
      await user.click(screen.getByTestId('edit-vmin'));
      const input = screen.getByTestId('edit-input-vmin').querySelector('input');
      await user.clear(input!);
      await user.type(input!, value);
      await user.click(screen.getByLabelText('Save vmin'));
      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    }

    it('shows the edited value at once', async () => {
      const user = userEvent.setup();
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      await editVmin(user, '1.05');
      await waitFor(() => expect(screen.getByText('1.05')).toBeInTheDocument());
      expect(putSpy.mock.calls[0]?.[1]).toEqual({ params: { vmin: 1.05 } });
    });

    it('gives way to the case once a reload replaces the topology', async () => {
      const user = userEvent.setup();
      select('bus', '1');
      const view = render(withQueryClient(<ElementFormFields />));
      await editVmin(user, '1.05');
      await waitFor(() => expect(screen.getByText('1.05')).toBeInTheDocument());

      // A reload re-reads the file: the entry is a new object holding the
      // file's value, and the Inspector must show that, not the edit.
      mockTopology = topology();
      view.rerender(withQueryClient(<ElementFormFields />));
      await waitFor(() => expect(screen.queryByText('1.05')).not.toBeInTheDocument());
      expect(screen.getByText('0.9')).toBeInTheDocument();
    });

    it('does not carry an edit to the next bus selected', async () => {
      const user = userEvent.setup();
      select('bus', '1');
      render(withQueryClient(<ElementFormFields />));
      await editVmin(user, '1.05');
      await waitFor(() => expect(screen.getByText('1.05')).toBeInTheDocument());

      act(() => {
        select('bus', '2');
      });
      await waitFor(() => expect(screen.queryByText('1.05')).not.toBeInTheDocument());
      expect(screen.getByText('0.92')).toBeInTheDocument();
    });
  });
});
