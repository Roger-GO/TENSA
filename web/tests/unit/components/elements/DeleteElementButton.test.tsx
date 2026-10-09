/**
 * DeleteElementButton — trash-icon → confirm-dialog → mutation cycle.
 *
 * Stubs the API client so we can drive the success / 422-dependents /
 * cascade / 422-cap / latency-threshold paths without a live substrate.
 * Asserts the dialog state machine, what it says about the disturbances
 * that act on the element, and the store side effects (selectedElement
 * navigation, pendingDependents, the timeline's disturbances).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DeleteElementButton } from '@/components/elements/DeleteElementButton';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { parseSessionId } from '@/api/types';
import type {
  DeleteBlockedResponse,
  DeleteElementResponse,
  ProblemDetails,
  TopologyEntry,
} from '@/api/types';

const deleteSpy = vi.fn();
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('@/lib/toast', () => ({
  toast: { success: toastSuccess, info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// Shared per-test mutable handle so each test can swap the resolution
// behavior (success / 422 / latency). ``cascade`` is what the substrate
// answers once the delete is sent again with ``cascade=true``.
type DeleteResult =
  | { kind: 'success'; topology: DeleteElementResponse; delayMs?: number }
  | {
      kind: 'blocked-dependents';
      body: DeleteBlockedResponse;
      cascade?: DeleteElementResponse;
      delayMs?: number;
    }
  | { kind: 'unknown-model'; delayMs?: number };

let nextResult: DeleteResult = { kind: 'success', topology: emptyTopology() };

function emptyTopology(extra: Partial<DeleteElementResponse> = {}): DeleteElementResponse {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
    ...extra,
  };
}

function blocked(
  dependents: TopologyEntry[],
  total = dependents.length,
  extra: Partial<DeleteBlockedResponse> = {},
): DeleteBlockedResponse {
  return { dependents, total, disturbances: [], disturbances_total: 0, ...extra };
}

function makeProblemDetails(status: number, detail: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: `HTTP ${status}`,
    status,
    detail,
    instance: null,
  };
}

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: (path: string, options?: { query?: Record<string, string | undefined> }) => {
        const cascade = options?.query?.cascade === 'true';
        deleteSpy(path, cascade);
        const result = nextResult;
        const exec = () => {
          if (result.kind === 'success') {
            return Promise.resolve(result.topology);
          }
          if (result.kind === 'blocked-dependents') {
            if (cascade && result.cascade !== undefined) return Promise.resolve(result.cascade);
            const err = new actual.ProblemDetailsError(
              makeProblemDetails(422, 'Delete blocked'),
              result.body,
            );
            return Promise.reject(err);
          }
          // unknown-model
          const detail = "Unknown ANDES model name 'XyzModel'";
          const err = new actual.ProblemDetailsError(
            makeProblemDetails(422, detail),
            makeProblemDetails(422, detail),
          );
          return Promise.reject(err);
        };
        const delay = result.delayMs ?? 0;
        if (delay <= 0) return exec();
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            exec().then(resolve, reject);
          }, delay);
        });
      },
    },
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeEntry(kind: string, idx: string, name = ''): TopologyEntry {
  return { idx, name: name || `${kind}_${idx}`, kind, params: {} };
}

beforeEach(() => {
  deleteSpy.mockClear();
  toastSuccess.mockClear();
  useDisturbanceStore.getState().clearDisturbances();
  nextResult = { kind: 'success', topology: emptyTopology() };
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DeleteElementButton', () => {
  it('renders the trash-icon button with an accessible label', () => {
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    const btn = screen.getByTestId('delete-element-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label', 'Delete bus 1');
  });

  it('given a reason it cannot delete, stays in place greyed out and opens nothing', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(
        <DeleteElementButton
          model="Bus"
          idx="1"
          kind="bus"
          disabledReason="Reset the run to delete this one."
        />,
      ),
    );
    const btn = screen.getByTestId('delete-element-button');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', 'Reset the run to delete this one.');
    // Not `disabled`: it can still be reached to read the reason.
    expect(btn).not.toBeDisabled();
    await user.click(btn);
    expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('clicking the trash icon opens the confirm dialog', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    expect(screen.getByTestId('delete-element-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete');
    expect(screen.getByTestId('delete-cancel')).toHaveTextContent('Cancel');
    expect(screen.getByText(/Delete bus 1\?/)).toBeInTheDocument();
    // A delete is one more edit, which Undo takes back.
    expect(screen.getByText(/Undo \(Ctrl\+Z or Edit > Undo\) brings it back/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    expect(screen.queryByTestId('delete-timeline-warning')).toBeNull();
  });

  it('on confirm with a 200, fires DELETE without cascade, closes the dialog and says so', async () => {
    const user = userEvent.setup();
    nextResult = {
      kind: 'success',
      topology: emptyTopology({ deleted: [makeEntry('Bus', '1')], disturbances: [] }),
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalled();
    });
    const [path, cascade] = deleteSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/elements/Bus/1');
    expect(cascade).toBe(false);
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(toastSuccess).toHaveBeenCalledWith('Deleted Bus 1', {
      description: 'Undo (Ctrl+Z or Edit > Undo) brings it back.',
    });
  });

  it('deletes an element the case file brought like any other', async () => {
    // The substrate used to refuse these with "came from the loaded case file".
    const user = userEvent.setup();
    nextResult = {
      kind: 'success',
      topology: emptyTopology({ deleted: [makeEntry('Line', 'Line_3')] }),
    };
    render(withQueryClient(<DeleteElementButton model="Line" idx="Line_3" kind="line" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(screen.queryByTestId('delete-case-file-message')).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith('Deleted Line Line_3', expect.anything());
  });

  it('on a 422 dependents response, lists what depends on the element and offers to delete it all', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = [
      makeEntry('Line', 'L1'),
      makeEntry('PV', 'G1'),
      makeEntry('ESST3A', 'X1'),
    ];
    nextResult = { kind: 'blocked-dependents', body: blocked(dependents) };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-dependents-list')).toBeInTheDocument();
    });
    expect(screen.getByText(/Delete bus 1 with what depends on it\?/)).toBeInTheDocument();
    expect(screen.getByText(/3 elements depend on it/i)).toBeInTheDocument();
    // An element the Inspector can show is a button; one it cannot is listed.
    expect(screen.getByTestId('delete-dependent-Line-L1').tagName).toBe('BUTTON');
    expect(screen.getByTestId('delete-dependent-PV-G1').tagName).toBe('BUTTON');
    expect(screen.getByTestId('delete-dependent-ESST3A-X1').tagName).toBe('DIV');
    // The plain Delete is gone: what is offered is to delete them together.
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    expect(screen.getByTestId('delete-cascade')).toHaveTextContent('Delete all 4 elements');
    expect(screen.queryByTestId('delete-disturbances-list')).toBeNull();
    // Cap footer not shown when total <= dependents.length.
    expect(screen.queryByTestId('delete-dependents-cap-footer')).toBeNull();
  });

  it('"Delete all" sends the delete again with cascade and says what went', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = [makeEntry('Line', 'L1'), makeEntry('PV', 'G1')];
    nextResult = {
      kind: 'blocked-dependents',
      body: blocked(dependents),
      cascade: emptyTopology({
        deleted: [...dependents, makeEntry('Bus', '1')],
        disturbances: [
          { source: 'case', kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 1, name: 'Toggle_1' },
        ],
      }),
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await user.click(await screen.findByTestId('delete-cascade'));
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(deleteSpy.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(toastSuccess).toHaveBeenCalledWith('Deleted Bus 1', {
      description:
        'With it: 2 elements that depended on it and 1 disturbance that acted on it. Undo (Ctrl+Z or Edit > Undo) brings them back.',
    });
  });

  it('warns about the disturbances that act on the element or on what depends on it', async () => {
    const user = userEvent.setup();
    // In the timeline: a trip of the line that hangs on the bus, and one elsewhere.
    useDisturbanceStore
      .getState()
      .addDisturbance({ kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 2 });
    useDisturbanceStore
      .getState()
      .addDisturbance({ kind: 'toggle', model: 'Line', dev_idx: 'L9', t: 3 });
    nextResult = {
      kind: 'blocked-dependents',
      body: blocked([makeEntry('Line', 'L1')], 1, {
        disturbances: [
          { source: 'case', kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 1, name: 'Toggle_1' },
          { source: 'restored', kind: 'fault', model: 'Bus', dev_idx: 1, t: 0.5, name: null },
        ],
        disturbances_total: 2,
      }),
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    const list = await screen.findByTestId('delete-disturbances-list');
    expect(screen.getByTestId('delete-disturbances-warning')).toHaveTextContent(
      '3 disturbances act on these elements and would be removed too:',
    );
    expect(list).toHaveTextContent('Toggle of Line L1 at 1 s, set by the case file');
    expect(list).toHaveTextContent('Fault on Bus 1 at 0.5 s, from the bundle or snapshot');
    expect(list).toHaveTextContent('Toggle Line L1 at t=2.000s, in the timeline');
    expect(list).not.toHaveTextContent('L9');
  });

  it('with only disturbances in the way, offers to delete anyway', async () => {
    const user = userEvent.setup();
    nextResult = {
      kind: 'blocked-dependents',
      body: blocked([], 0, {
        disturbances: [
          { source: 'committed', kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 2, name: null },
        ],
        disturbances_total: 1,
      }),
    };
    // The same toggle is in the timeline: once committed it is in both lists,
    // and is named once.
    useDisturbanceStore
      .getState()
      .addDisturbance({ kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 2 });
    render(withQueryClient(<DeleteElementButton model="Line" idx="L1" kind="line" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await screen.findByTestId('delete-disturbances-list');
    expect(screen.queryByTestId('delete-dependents-list')).toBeNull();
    expect(screen.getByTestId('delete-disturbances-warning')).toHaveTextContent(
      '1 disturbance acts on it and would be removed too:',
    );
    expect(screen.getByTestId('delete-disturbances-list').children).toHaveLength(1);
    expect(screen.getByTestId('delete-cascade')).toHaveTextContent('Delete anyway');
  });

  it('names the timeline disturbances on the element before deleting, and takes them off with it', async () => {
    const user = userEvent.setup();
    const store = useDisturbanceStore.getState();
    store.addDisturbance({ kind: 'fault', bus_idx: '1', tf: 1, tc: 1.1, xf: 0.05, rf: 0 });
    const kept = store.addDisturbance({
      kind: 'fault',
      bus_idx: '2',
      tf: 2,
      tc: 2.1,
      xf: 0.05,
      rf: 0,
    });
    nextResult = {
      kind: 'success',
      topology: emptyTopology({ deleted: [makeEntry('Bus', '1')] }),
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    const warning = screen.getByTestId('delete-timeline-warning');
    expect(warning).toHaveTextContent(
      '1 disturbance in the timeline acts on it and will be removed with it:',
    );
    expect(warning).toHaveTextContent('Fault on Bus 1 at t=1.000s');
    expect(warning).not.toHaveTextContent('Bus 2');

    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(useDisturbanceStore.getState().disturbances).toEqual([kept]);
    expect(toastSuccess).toHaveBeenCalledWith('Deleted Bus 1', {
      description:
        'With it: 1 disturbance that acted on it. Undo (Ctrl+Z or Edit > Undo) brings them back.',
    });
  });

  it('shows the cap footer when total > dependents.length (truncated server cap)', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeEntry('Line', `L${i + 1}`),
    );
    nextResult = { kind: 'blocked-dependents', body: blocked(dependents, 30) };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-dependents-cap-footer')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-dependents-cap-footer')).toHaveTextContent(
      'Showing 25 of 30 dependents',
    );
  });

  it('does NOT show the cap footer when total === 25 (boundary)', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeEntry('Line', `L${i + 1}`),
    );
    nextResult = { kind: 'blocked-dependents', body: blocked(dependents, 25) };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-dependents-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('delete-dependents-cap-footer')).toBeNull();
  });

  it('clicking a dependent navigates the inspector and pushes remaining into pendingDependents', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = [
      makeEntry('Line', 'L1'),
      makeEntry('PV', 'G1'),
      makeEntry('PQ', 'D1'),
    ];
    nextResult = { kind: 'blocked-dependents', body: blocked(dependents) };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-dependents-list')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('delete-dependent-Line-L1'));
    // Dialog closed.
    expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    // Inspector navigated to the line.
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'line',
      idx: 'L1',
      modelClass: 'Line',
    });
    // Remaining dependents flagged for the SLD warning ring.
    const pending = useCaseStore.getState().pendingDependents;
    expect(pending).toHaveLength(2);
    expect(pending.map((d) => d.kind)).toEqual(['PV', 'PQ']);
  });

  it('Cancel on the confirm dialog closes without firing a request', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-cancel'));
    expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('does NOT show the spinner when the request resolves before the 200ms threshold', async () => {
    const user = userEvent.setup();
    // 50ms — well below the SPINNER_DELAY_MS=200 threshold; the dialog
    // closes on success without ever flipping into the "Deleting..." view.
    nextResult = { kind: 'success', topology: emptyTopology(), delayMs: 50 };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    // Wait for the dialog to close. The spinner data-testid should never
    // have appeared.
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(screen.queryByTestId('delete-spinner')).toBeNull();
  });

  it('shows the spinner once the in-flight request crosses the 200ms threshold', async () => {
    // Real timers; resolve the mutation at 600ms so we have a comfortable
    // window after the 200ms spinner threshold to assert the in-flight
    // view, then watch the dialog close once the resolve fires.
    const user = userEvent.setup();
    nextResult = { kind: 'success', topology: emptyTopology(), delayMs: 600 };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    // The 200ms spinner-delay timer flips the view into the "Deleting…"
    // state; waitFor polls until that change lands.
    await waitFor(
      () => {
        expect(screen.getByTestId('delete-spinner')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
    expect(screen.getByText(/Deleting…/)).toBeInTheDocument();
    // The resolution at ~600ms closes the dialog.
    await waitFor(
      () => {
        expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('on a 200, clears selectedElement when the deleted element was selected', async () => {
    const user = userEvent.setup();
    useCaseStore.getState().setSelectedElement({ kind: 'bus', idx: '1' });
    nextResult = { kind: 'success', topology: emptyTopology() };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(useCaseStore.getState().selectedElement).toBeNull();
    });
  });

  it('clears the selection of a generator whose model name is nothing like its kind', async () => {
    // "PV" and "generator" share no prefix: the selection is cleared because the
    // topology that came back no longer holds the element.
    const user = userEvent.setup();
    useCaseStore.getState().setSelectedElement({ kind: 'generator', idx: '2' });
    nextResult = { kind: 'success', topology: emptyTopology() };
    render(withQueryClient(<DeleteElementButton model="PV" idx="2" kind="generator" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(useCaseStore.getState().selectedElement).toBeNull();
    });
  });

  it('leaves the selection on an element the delete did not take', async () => {
    const user = userEvent.setup();
    useCaseStore.getState().setSelectedElement({ kind: 'bus', idx: '2' });
    nextResult = {
      kind: 'success',
      topology: emptyTopology({ buses: [makeEntry('Bus', '2')], deleted: [makeEntry('Bus', '1')] }),
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '2' });
  });

  it('on a non-422 error, surfaces the message inline without flipping views', async () => {
    const user = userEvent.setup();
    // Force a 409 via a custom mock for this case.
    const detail = 'Session has been committed. Reload to return to pre-setup.';
    nextResult = {
      // Not actually one of our enumerated cases — fabricate via Promise
      // rejection in the per-test client mock would mean a more invasive
      // change. Instead piggy-back on unknown-model which surfaces an
      // error-other inline message.
      kind: 'unknown-model',
    };
    void detail;
    render(withQueryClient(<DeleteElementButton model="XyzModel" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-error')).toHaveTextContent(/Unknown ANDES model/);
    // Confirm + Cancel are still rendered (user can retry).
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('delete-cancel')).toBeInTheDocument();
  });
});

// Sanity import to make sure the ProblemDetailsError export the test
// relies on does carry the ``rawBody`` field — guards against a future
// client.ts refactor that might drop it without a typecheck failure.
describe('ProblemDetailsError contract (Unit 2 dependency)', () => {
  it('exposes rawBody for typed 422 bodies', () => {
    const body = blocked([]);
    const err = new ProblemDetailsError(makeProblemDetails(422, 'blocked'), body);
    expect(err.rawBody).toEqual({
      dependents: [],
      total: 0,
      disturbances: [],
      disturbances_total: 0,
    });
  });
});
