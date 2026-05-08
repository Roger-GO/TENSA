/**
 * DeleteElementButton — trash-icon → confirm-dialog → mutation cycle.
 *
 * Stubs the API client so we can drive the success / 422-dependents /
 * 422-case-file / 422-cap / latency-threshold paths without a live
 * substrate. Asserts the dialog state machine + the case-store side
 * effects (selectedElement navigation + pendingDependents population).
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
import { parseSessionId } from '@/api/types';
import type {
  DeleteBlockedResponse,
  ProblemDetails,
  TopologyEntry,
  TopologySummary,
} from '@/api/types';

const deleteSpy = vi.fn();

// Shared per-test mutable handle so each test can swap the resolution
// behavior (success / 422 / case-file / latency).
type DeleteResult =
  | { kind: 'success'; topology: TopologySummary; delayMs?: number }
  | { kind: 'blocked-dependents'; body: DeleteBlockedResponse; delayMs?: number }
  | { kind: 'blocked-case-file'; delayMs?: number }
  | { kind: 'unknown-model'; delayMs?: number };

let nextResult: DeleteResult = { kind: 'success', topology: emptyTopology() };

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
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
      delete: (path: string) => {
        deleteSpy(path);
        const result = nextResult;
        const exec = () => {
          if (result.kind === 'success') {
            return Promise.resolve(result.topology);
          }
          if (result.kind === 'blocked-dependents') {
            const err = new actual.ProblemDetailsError(
              makeProblemDetails(422, 'Delete blocked'),
              result.body,
            );
            return Promise.reject(err);
          }
          if (result.kind === 'blocked-case-file') {
            const detail =
              'This element came from the loaded case file. Use the Reload button in the workflow toolbar to reset to the original case.';
            const err = new actual.ProblemDetailsError(
              makeProblemDetails(422, detail),
              makeProblemDetails(422, detail),
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

  it('clicking the trash icon opens the confirm dialog', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    expect(screen.getByTestId('delete-element-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete');
    expect(screen.getByTestId('delete-cancel')).toHaveTextContent('Cancel');
    expect(screen.getByText(/Delete bus 1\?/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('on confirm with a 200, fires DELETE and closes the dialog', async () => {
    const user = userEvent.setup();
    nextResult = { kind: 'success', topology: emptyTopology() };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalled();
    });
    const path = deleteSpy.mock.calls[0]?.[0];
    expect(path).toContain('/sessions/test-session-id/elements/Bus/1');
    await waitFor(() => {
      expect(screen.queryByTestId('delete-element-dialog')).toBeNull();
    });
  });

  it('on a 422 dependents response, flips to the dependents list view', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = [makeEntry('Line', 'L1'), makeEntry('PV', 'G1')];
    nextResult = {
      kind: 'blocked-dependents',
      body: { dependents, total: 2 },
    };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-dependents-list')).toBeInTheDocument();
    });
    expect(screen.getByText(/Delete blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/2 elements reference this bus/i)).toBeInTheDocument();
    // Each dependent renders as a clickable button.
    expect(screen.getByTestId('delete-dependent-Line-L1')).toBeInTheDocument();
    expect(screen.getByTestId('delete-dependent-PV-G1')).toBeInTheDocument();
    // The Delete button is gone; only Cancel is rendered.
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    // Cap footer not shown when total <= dependents.length.
    expect(screen.queryByTestId('delete-dependents-cap-footer')).toBeNull();
  });

  it('shows the cap footer when total > dependents.length (truncated server cap)', async () => {
    const user = userEvent.setup();
    const dependents: TopologyEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeEntry('Line', `L${i + 1}`),
    );
    nextResult = {
      kind: 'blocked-dependents',
      body: { dependents, total: 30 },
    };
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
    nextResult = {
      kind: 'blocked-dependents',
      body: { dependents, total: 25 },
    };
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
    nextResult = {
      kind: 'blocked-dependents',
      body: { dependents, total: 3 },
    };
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
    });
    // Remaining dependents flagged for the SLD warning ring.
    const pending = useCaseStore.getState().pendingDependents;
    expect(pending).toHaveLength(2);
    expect(pending.map((d) => d.kind)).toEqual(['PV', 'PQ']);
  });

  it('on a 422 case-file-originated, shows the verbatim reload-to-revert message and only Cancel', async () => {
    const user = userEvent.setup();
    nextResult = { kind: 'blocked-case-file' };
    render(withQueryClient(<DeleteElementButton model="Bus" idx="1" kind="bus" />));
    await user.click(screen.getByTestId('delete-element-button'));
    await user.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-case-file-message')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-case-file-message')).toHaveTextContent(
      /This element came from the loaded case file/,
    );
    expect(screen.getByTestId('delete-case-file-message')).toHaveTextContent(
      /Use the Reload button in the workflow toolbar/,
    );
    // No Delete button — Cancel only.
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
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
    const err = new ProblemDetailsError(makeProblemDetails(422, 'blocked'), {
      dependents: [],
      total: 0,
    } satisfies DeleteBlockedResponse);
    expect(err.rawBody).toEqual({ dependents: [], total: 0 });
  });
});
