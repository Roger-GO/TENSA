/**
 * SaveSystemDialog: modal-driven case save with format radio,
 * extension auto-derivation, sidecar auto-write, and 409 overwrite-flip.
 *
 * Tests stub `andesClient.post`/`put` so the lifecycle is exercised
 * without a substrate. We watch:
 * - format-radio toggling rewrites the inline filename preview.
 * - submit fires POST /sessions/{id}/save with the right body.
 * - on 409 with overwrite=false, the inline error suggests ticking
 *   overwrite; toggling and re-submitting passes overwrite=true.
 * - sidecar auto-write fires PUT /workspace/layout when there are
 *   drag overrides.
 * - the modal closes itself a beat after a save, and that beat never
 *   closes a modal opened since.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { SaveSystemDialog } from '@/components/case/SaveSystemDialog';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails, TopologySummary } from '@/api/types';
import { startBeatClock } from '../../helpers/beatClock';

const postSpy = vi.fn();
const putSpy = vi.fn();
type Resolver = () => Promise<unknown>;
let nextPost: Resolver = () => Promise.resolve({ filename: 'my-system.xlsx', bytes_written: 1024 });
let nextPut: Resolver = () => Promise.resolve(undefined);

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
      delete: vi.fn(),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return nextPost();
      },
      put: (path: string, opts: { body?: unknown; query?: Record<string, string> }) => {
        putSpy(path, opts.body, opts.query);
        return nextPut();
      },
    },
  };
});

let MOCK_TOPOLOGY: TopologySummary | null = null;

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
  putSpy.mockClear();
  nextPost = () => Promise.resolve({ filename: 'my-system.xlsx', bytes_written: 1024 });
  nextPut = () => Promise.resolve(undefined);
  MOCK_TOPOLOGY = emptyTopology();
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: emptyTopology(),
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
    cloneInitialized: false,
  });
});

/**
 * A stand-in for whatever opens the dialog (a menu item, Ctrl/Cmd+S): a button
 * outside it, with the dialog's open state in the owner.
 */
function Owner() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="save-system-button" onClick={() => setOpen(true)}>
        open
      </button>
      <SaveSystemDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('<SaveSystemDialog />', () => {
  it('clicking the trigger opens the modal with the xlsx default + filename preview', async () => {
    render(withQueryClient(<Owner />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Save system as/i);
    // Preview reflects the default filename + xlsx default.
    expect(screen.getByText(/my-system\.xlsx/)).toBeInTheDocument();
  });

  it('switching the format radio updates the auto-derived extension preview', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByRole('radio', { name: /json/i }));
    expect(screen.getByText(/my-system\.json/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /raw/i }));
    expect(screen.getByText(/my-system\.raw/)).toBeInTheDocument();
  });

  it('happy path: submitting posts to /sessions/{id}/save with the right body', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const [path, body] = postSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/save');
    expect(body).toEqual({
      filename: 'my-system.xlsx',
      format: 'xlsx',
      overwrite: false,
    });
  });

  it('on a 409 with overwrite=false, surfaces the inline overwrite-suggestion error', async () => {
    const user = userEvent.setup();
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () =>
      Promise.reject(new ProblemDetailsError(makeProblemDetails(409, 'File exists')));
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('save-error')).toHaveTextContent(/Overwrite/i);
  });

  it('toggling Overwrite + re-submitting passes overwrite=true to the server', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    const overwriteCheckbox = screen.getByRole('checkbox', { name: /Overwrite if exists/i });
    await user.click(overwriteCheckbox);
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const [, body] = postSpy.mock.calls[0] ?? [];
    expect(body).toMatchObject({ overwrite: true });
  });

  it('auto-writes a sidecar via PUT /workspace/layout when drag overrides exist', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      dragOverrides: {
        // bus drag (no kind prefix) → goes under coordinates
        '1': { x: 10, y: 20 },
      },
    });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [path, body] = putSpy.mock.calls[0] ?? [];
    expect(path).toBe('/workspace/layout');
    // The sidecar payload includes the bus coords.
    expect(body).toMatchObject({
      coordinates: { '1': { x: 10, y: 20 } },
    });
  });

  it('skips the sidecar write entirely when there are no drag overrides', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ dragOverrides: {} });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty filename with an inline error before firing the request', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    const filename = screen.getByTestId('save-filename') as HTMLInputElement;
    await user.clear(filename);
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toBeInTheDocument();
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('partitions non-bus drag overrides into the non_bus_coordinates side of the sidecar', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...emptyTopology(),
      generators: [{ idx: '1', name: 'G1', kind: 'PV', params: {} }],
    };
    useCaseStore.setState({
      dragOverrides: {
        // non-bus drag uses the `${uiCategory}-${idx}` shape
        'generator-1': { x: 50, y: 60 },
      },
    });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [, body] = putSpy.mock.calls[0] ?? [];
    // The non-bus coord lands under `non_bus_coordinates` keyed by both
    // model class (PV) and UI category (generator).
    expect(body).toMatchObject({
      coordinates: {},
      non_bus_coordinates: {
        PV: { '1': { x: 50, y: 60 } },
        generator: { '1': { x: 50, y: 60 } },
      },
    });
  });
});

describe('<Owner /> — auto-close beat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Click Save and wait for the confirmation line. */
  async function saveAndConfirm(user: ReturnType<typeof startBeatClock>) {
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await screen.findByText(/Wrote 1024 bytes/);
  }

  it('closes by itself after a successful save', async () => {
    const user = startBeatClock();
    render(withQueryClient(<Owner />));
    await saveAndConfirm(user);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not close a re-opened modal when the previous one auto-closes', async () => {
    const user = startBeatClock();
    render(withQueryClient(<Owner />));
    await saveAndConfirm(user);

    // Close by hand inside the beat, then open the modal again.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByTestId('save-system-button'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // The first modal's timer would fire inside this window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts no beat when the modal was dismissed before the save answered', async () => {
    const user = startBeatClock();
    // A layout to write: the sidecar belongs to the file, not to the modal.
    useCaseStore.setState({ dragOverrides: { '1': { x: 10, y: 20 } } });
    let answer: (value: unknown) => void = () => {};
    nextPost = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

    // Escape is not blocked while the save is in flight. Open it again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByTestId('save-system-button'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // The save answers now; the modal it belonged to is gone.
    await act(async () => {
      answer({ filename: 'my-system.xlsx', bytes_written: 1024 });
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/Wrote 1024 bytes/)).toBeNull();
  });

  it('keeps an answer to the open modal: a failed save stays on screen', async () => {
    const user = startBeatClock();
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () => Promise.reject(new ProblemDetailsError(makeProblemDetails(500, 'disk full')));
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    expect(await screen.findByTestId('save-error')).toHaveTextContent('disk full');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('<SaveSystemDialog /> opened by its owner', () => {
  it('shows the dialog when the owner opens it, and tells the owner when it closes', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('save-system-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Save system/i);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("opens clean: the last opening's error is gone", async () => {
    const user = userEvent.setup();
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () =>
      Promise.reject(new ProblemDetailsError(makeProblemDetails(409, 'File exists')));
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    expect(await screen.findByTestId('save-error')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTestId('save-system-button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('save-error')).not.toBeInTheDocument();
  });

  it('a save that answers after the dialog was left does not close the one open now', async () => {
    const user = userEvent.setup();
    let answer: ((v: unknown) => void) | null = null;
    nextPost = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    // Leave while the save is in flight, and open again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByTestId('save-system-button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      answer?.({ filename: 'my-system.xlsx', bytes_written: 10 });
      await Promise.resolve();
    });
    // The answer belongs to the opening that was left: no "saved" line here.
    expect(screen.queryByText(/Wrote 10 bytes/)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('<SaveSystemDialog /> why Save asked for a name', () => {
  it('says why an opened raw case is not written back, as Save is not the one to do it', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    render(withQueryClient(<Owner />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.getByTestId('save-system-why-new-file')).toHaveTextContent(
      /ieee14\.raw is a \.raw case.*Save replaces only xlsx and json cases/,
    );
  });

  it('says the parameter edits live in a copy when a clone exists', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      cloneInitialized: true,
    });
    render(withQueryClient(<Owner />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.getByTestId('save-system-why-new-file')).toHaveTextContent(
      /Save parameter edits as case/,
    );
  });

  it('says nothing for a case Save can write back, which the user chose to save as anew', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      cloneInitialized: false,
    });
    render(withQueryClient(<Owner />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.queryByTestId('save-system-why-new-file')).toBeNull();
  });

  it('says nothing for a system built here, which has no file for Save to write', async () => {
    useCaseStore.setState({
      selection: { primaryPath: null, addfiles: [], blank: true },
      cloneInitialized: false,
    });
    render(withQueryClient(<Owner />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.queryByTestId('save-system-why-new-file')).toBeNull();
  });
});
