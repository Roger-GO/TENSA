/**
 * PmuPlacementDialog — bus picker, place flow, delete flow, error
 * handling. Mocks the substrate client so we can assert what gets
 * POSTed without spinning a real session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { PmuPlacementDialog } from '@/components/pmu/PmuPlacementDialog';
import { useSessionStore } from '@/store/session';
import { usePmuStore } from '@/store/pmu';
import { parseSessionId } from '@/api/types';
import type { ListPmusResponse, TopologyEntry, TopologySummary } from '@/api/types';

const postSpy = vi.fn();
const deleteSpy = vi.fn();
const getSpy = vi.fn();

let MOCK_TOPOLOGY: TopologySummary | null = null;
let MOCK_LIST_RESPONSE: ListPmusResponse = { pmus: [] };
let postReturn: TopologyEntry | (() => Promise<TopologyEntry>) = {
  idx: 'PMU_1',
  name: 'PMU_1',
  kind: 'PMU',
  params: { bus: '1', Ta: 0.05, Tv: 0.05 },
};
let postShouldFail: { status: number; detail: string } | null = null;

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  const ProblemDetailsError = actual.ProblemDetailsError;
  return {
    ...actual,
    andesClient: {
      get: (path: string) => {
        getSpy(path);
        if (path.endsWith('/pmu')) {
          return Promise.resolve(MOCK_LIST_RESPONSE);
        }
        return Promise.resolve(null);
      },
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        if (postShouldFail) {
          return Promise.reject(
            new ProblemDetailsError(
              {
                type: 'about:blank',
                title: 'Error',
                status: postShouldFail.status,
                detail: postShouldFail.detail,
                instance: null,
              },
              null,
              path,
            ),
          );
        }
        if (typeof postReturn === 'function') {
          return postReturn();
        }
        return Promise.resolve(postReturn);
      },
      delete: (path: string) => {
        deleteSpy(path);
        return Promise.resolve(undefined);
      },
      put: vi.fn(),
    },
  };
});

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  deleteSpy.mockClear();
  getSpy.mockClear();
  postShouldFail = null;
  postReturn = {
    idx: 'PMU_1',
    name: 'PMU_1',
    kind: 'PMU',
    params: { bus: '1', Ta: 0.05, Tv: 0.05 },
  };
  MOCK_LIST_RESPONSE = { pmus: [] };
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [
      { idx: '1', name: 'BUS1', kind: 'Bus', params: {} },
      { idx: '5', name: 'BUS5', kind: 'Bus', params: {} },
      { idx: '9', name: 'BUS9', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  usePmuStore.setState({ pmus: [] });
});

afterEach(() => {
  usePmuStore.setState({ pmus: [] });
});

describe('<PmuPlacementDialog />', () => {
  it('renders nothing when open=false', () => {
    render(withQueryClient(<PmuPlacementDialog open={false} onOpenChange={() => {}} />));
    expect(screen.queryByTestId('pmu-placement-dialog')).toBeNull();
  });

  it('renders title, bus picker with available buses, and disabled submit when none picked', () => {
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    expect(screen.getByTestId('pmu-placement-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Place PMU/)).toBeInTheDocument();
    // All three buses should be in the picker.
    expect(screen.getByTestId('pmu-bus-checkbox-1')).toBeInTheDocument();
    expect(screen.getByTestId('pmu-bus-checkbox-5')).toBeInTheDocument();
    expect(screen.getByTestId('pmu-bus-checkbox-9')).toBeInTheDocument();
    // Empty placed list message.
    expect(screen.getByText(/No PMUs placed/)).toBeInTheDocument();
    // Submit disabled when no bus checked.
    expect(screen.getByTestId('pmu-place-submit')).toBeDisabled();
  });

  it('shows currently-placed PMUs from the store with a delete affordance', async () => {
    const placed: TopologyEntry = {
      idx: 'PMU_1',
      name: 'PMU_1',
      kind: 'PMU',
      params: { bus: '5', Ta: 0.05, Tv: 0.05 },
    };
    MOCK_LIST_RESPONSE = { pmus: [placed] };
    usePmuStore.setState({ pmus: [placed] });
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('pmu-placed-item-PMU_1')).toBeInTheDocument());
    expect(screen.getByTestId('pmu-delete-PMU_1')).toBeInTheDocument();
    // The bus already has a PMU — the picker should show that hint.
    expect(screen.getByText(/already has PMU/)).toBeInTheDocument();
  });

  it('checking buses enables submit and labels the count', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await user.click(screen.getByTestId('pmu-bus-checkbox-1'));
    expect(screen.getByTestId('pmu-place-submit')).toHaveTextContent('Place 1 PMU');
    await user.click(screen.getByTestId('pmu-bus-checkbox-5'));
    expect(screen.getByTestId('pmu-place-submit')).toHaveTextContent('Place 2 PMUs');
  });

  it('clicking submit POSTs one /pmu per checked bus, in order', async () => {
    const user = userEvent.setup();
    let callCount = 0;
    postReturn = () =>
      Promise.resolve({
        idx: `PMU_${++callCount}`,
        name: `PMU_${callCount}`,
        kind: 'PMU',
        params: { bus: '1', Ta: 0.05, Tv: 0.05 },
      });
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await user.click(screen.getByTestId('pmu-bus-checkbox-1'));
    await user.click(screen.getByTestId('pmu-bus-checkbox-5'));
    await user.click(screen.getByTestId('pmu-place-submit'));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
    // Each call is to /sessions/{id}/pmu with the right body.
    const calls = postSpy.mock.calls;
    const paths = calls.map((c) => c[0]);
    paths.forEach((p) => expect(p).toContain('/pmu'));
    const bodies = calls.map((c) => c[1]);
    expect(bodies[0]).toEqual({ bus_idx: '1', Ta: 0.05, Tv: 0.05 });
    expect(bodies[1]).toEqual({ bus_idx: '5', Ta: 0.05, Tv: 0.05 });
  });

  it('forwards custom Ta / Tv values when the user edits them', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await user.clear(screen.getByTestId('pmu-ta-input'));
    await user.type(screen.getByTestId('pmu-ta-input'), '0.1');
    await user.clear(screen.getByTestId('pmu-tv-input'));
    await user.type(screen.getByTestId('pmu-tv-input'), '0.2');
    await user.click(screen.getByTestId('pmu-bus-checkbox-1'));
    await user.click(screen.getByTestId('pmu-place-submit'));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]![1]).toEqual({ bus_idx: '1', Ta: 0.1, Tv: 0.2 });
  });

  it('disables submit on an invalid Ta', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await user.click(screen.getByTestId('pmu-bus-checkbox-1'));
    expect(screen.getByTestId('pmu-place-submit')).not.toBeDisabled();
    await user.clear(screen.getByTestId('pmu-ta-input'));
    await user.type(screen.getByTestId('pmu-ta-input'), '-1');
    expect(screen.getByTestId('pmu-place-submit')).toBeDisabled();
  });

  it('surfaces ProblemDetailsError detail inline on a 422', async () => {
    const user = userEvent.setup();
    postShouldFail = { status: 422, detail: 'no Bus with idx=999' };
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await user.click(screen.getByTestId('pmu-bus-checkbox-1'));
    await user.click(screen.getByTestId('pmu-place-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('pmu-server-error')).toHaveTextContent(/no Bus with idx=999/),
    );
  });

  it('clicking the × on a placed PMU issues DELETE /pmu/{idx}', async () => {
    const user = userEvent.setup();
    const placed: TopologyEntry = {
      idx: 'PMU_1',
      name: 'PMU_1',
      kind: 'PMU',
      params: { bus: '5', Ta: 0.05, Tv: 0.05 },
    };
    // Both the store and the substrate-side response need to carry the
    // PMU so the dialog's open-time refetch doesn't wipe it from the
    // store before the user can click delete.
    MOCK_LIST_RESPONSE = { pmus: [placed] };
    usePmuStore.setState({ pmus: [placed] });
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('pmu-delete-PMU_1')).toBeInTheDocument());
    await user.click(screen.getByTestId('pmu-delete-PMU_1'));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    const path = deleteSpy.mock.calls[0]![0];
    expect(path).toContain('/pmu/PMU_1');
  });

  it('cancel button calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={onOpenChange} />));
    await user.click(screen.getByTestId('pmu-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows "Load a case first" when topology is null', () => {
    MOCK_TOPOLOGY = null;
    render(withQueryClient(<PmuPlacementDialog open onOpenChange={() => {}} />));
    expect(screen.getByText(/Load a case first/)).toBeInTheDocument();
  });
});
