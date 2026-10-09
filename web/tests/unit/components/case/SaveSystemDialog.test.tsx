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
 * - sidecar auto-write fires PUT /workspace/layout with the diagram as
 *   it is drawn.
 * - the modal closes itself a beat after a save, and that beat never
 *   closes a modal opened since.
 * - it opens on a name made from the open case's, Enter in the name saves,
 *   and a save says which file is still being edited, with a button that
 *   opens the copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { SaveSystemDialog } from '@/components/case/SaveSystemDialog';
import { buildNonBusCoordinates, buildSidecarLayout } from '@/components/sld/sidecar';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { BLANK_CASE_KEY, useDraftsStore } from '@/store/drafts';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails, TopologySummary } from '@/api/types';
import { stillEditing, suggestedCopyName } from '@/lib/savedCopy';
import { toast } from '@/lib/toast';
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
    diagramLayout: null,
    pendingDependents: [],
    cloneInitialized: false,
    savedCopy: null,
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

describe('<SaveSystemDialog /> — the name, Enter, and which file is edited after', () => {
  const WSCC9 = { primaryPath: parseWorkspacePath('cases/wscc9.xlsx'), addfiles: [] };
  const successSpy = () => vi.spyOn(toast, 'success').mockReturnValue('id');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on a name made from the open case, selected, so typing replaces it', async () => {
    // It opened on "my-system" whatever was open.
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    const name = screen.getByTestId('save-filename') as HTMLInputElement;
    expect(name).toHaveValue('wscc9-copy');
    expect(screen.getByText(/wscc9-copy\.xlsx/)).toBeInTheDocument();
    // The focus is on the name, with all of it selected.
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'wscc9-copy'.length]);
    await user.keyboard('walk');
    expect(name).toHaveValue('walk');
  });

  it('starts each opening on the name of the case open then', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.clear(screen.getByTestId('save-filename'));
    await user.type(screen.getByTestId('save-filename'), 'something-else');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() =>
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      }),
    );
    await user.click(screen.getByTestId('save-system-button'));
    expect(screen.getByTestId('save-filename')).toHaveValue('kundur_full-copy');
  });

  it('names a system that has no file "my-system"', () => {
    expect(suggestedCopyName(null)).toBe('my-system');
    expect(suggestedCopyName({ primaryPath: null, addfiles: [], blank: true })).toBe('my-system');
    expect(suggestedCopyName(WSCC9)).toBe('wscc9-copy');
  });

  it('saves on Enter in the name', async () => {
    // Enter did nothing: the dialog had no form.
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    nextPost = () => Promise.resolve({ filename: 'wscc9-ux-walk.xlsx', bytes_written: 1024 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.keyboard('wscc9-ux-walk{Enter}');
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]).toEqual([
      '/sessions/test-session-id/save',
      { filename: 'wscc9-ux-walk.xlsx', format: 'xlsx', overwrite: false },
    ]);
    await screen.findByText(/Wrote 1024 bytes/);
    // And says so beside the name, since nothing else on a form does.
    expect(screen.getByText(/Enter saves\./)).toBeInTheDocument();
  });

  it('says after a save which file is still being edited, and opens the copy when asked', async () => {
    // The app goes on with the case it had open, and said nothing of it: a
    // user who took Save as for a move to the new file could not tell.
    const success = successSpy();
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    nextPost = () => Promise.resolve({ filename: 'wscc9-ux-walk.xlsx', bytes_written: 1024 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    const [title, said] = success.mock.calls[0] as [
      string,
      { description: string; duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe('Saved as wscc9-ux-walk.xlsx');
    expect(said.description).toBe(
      'You are still editing wscc9.xlsx: what you change next goes there, not into the copy.',
    );
    // Long enough to read and to reach the button.
    expect(said.duration).toBeGreaterThanOrEqual(10_000);
    expect(said.action.label).toBe('Open the copy');
    // The Project tab goes on saying it once the notice is gone.
    expect(useCaseStore.getState().savedCopy).toBe('wscc9-ux-walk.xlsx');

    postSpy.mockClear();
    nextPost = () => Promise.resolve({});
    act(() => said.action.onClick());
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]).toEqual([
      '/sessions/test-session-id/case',
      { primary_path: 'wscc9-ux-walk.xlsx', addfiles: null },
    ]);
    await waitFor(() =>
      expect(useCaseStore.getState().selection?.primaryPath).toBe('wscc9-ux-walk.xlsx'),
    );
    expect(useCaseStore.getState().savedCopy).toBeNull();
  });

  it('takes the notice down when another case is opened, where it no longer holds', async () => {
    successSpy();
    const dismiss = vi.spyOn(toast, 'dismiss');
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => expect(useCaseStore.getState().savedCopy).toBe('my-system.xlsx'));
    dismiss.mockClear();

    act(() =>
      useCaseStore
        .getState()
        .setCase({ primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] }),
    );
    expect(dismiss).toHaveBeenCalledWith('saved-copy');
  });

  it('tells a system built here that it has no file of its own', () => {
    expect(stillEditing(null)).toBe(
      'The system you built is still the one open here, with no file of its own: what you change next is not in the copy unless you save again.',
    );
  });

  it('says nothing of a copy when the save was over the open file itself', async () => {
    const success = successSpy();
    const user = userEvent.setup();
    useCaseStore.setState({ selection: WSCC9 });
    nextPost = () => Promise.resolve({ filename: 'cases/wscc9.xlsx', bytes_written: 2048 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await screen.findByText(/Wrote 2048 bytes/);
    expect(success).not.toHaveBeenCalled();
    expect(useCaseStore.getState().savedCopy).toBeNull();
  });

  it('says the case file is not changed and that its layout saves by itself', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The case file you opened is not changed, and it stays the one you are editing',
    );
    expect(dialog).toHaveTextContent(
      'the layout of the case you have open saves by itself as you move things',
    );
  });
});

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

  it('says that a raw file holds the power-flow data and no dynamic models', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    expect(
      screen.getByRole('radio', { name: /raw.*power-flow data only \(no dynamic models\)/i }),
    ).toBeInTheDocument();
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

  it('auto-writes the diagram as drawn via PUT /workspace/layout, beside the new file', async () => {
    const user = userEvent.setup();
    // Nothing was dragged in this visit: the diagram shows the layout the case
    // opened with. The new file must get it all the same, or it reopens in a
    // different layout from the one it was saved in.
    useCaseStore.setState({
      dragOverrides: {},
      diagramLayout: buildSidecarLayout({ '1': { x: 10, y: 20 }, '2': { x: 210, y: 20 } }),
    });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [path, body, query] = putSpy.mock.calls[0] ?? [];
    expect(path).toBe('/workspace/layout');
    expect(query).toEqual({ case_path: 'my-system.xlsx' });
    // The sidecar payload includes every bus coord.
    expect(body).toMatchObject({
      schema_version: '2',
      coordinates: { '1': { x: 10, y: 20 }, '2': { x: 210, y: 20 } },
    });
  });

  it('keeps the drafts on the diagram with the file that was written as well', async () => {
    const user = userEvent.setup();
    // A system built from scratch, with a draft on its diagram.
    useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
    useDraftsStore.setState({
      byCase: {
        [BLANK_CASE_KEY]: [
          { id: 'draft-1', kind: 'PQ', position: { x: 10, y: 20 }, values: { bus: '1' } },
        ],
      },
    });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(useDraftsStore.getState().byCase['my-system.xlsx']).toEqual([
        { id: 'draft-1', kind: 'PQ', position: { x: 10, y: 20 }, values: { bus: '1' } },
      ]);
    });
    // The system that is open keeps its own.
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toHaveLength(1);
    useDraftsStore.setState({ byCase: {} });
  });

  it('skips the sidecar write entirely when no diagram has been drawn', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ dragOverrides: {}, diagramLayout: null });
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

  it('sends the device positions and the routes of the diagram along with the buses', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      diagramLayout: buildSidecarLayout(
        {},
        {
          nonBusCoords: buildNonBusCoordinates([
            { uiCategory: 'generator', idx: '1', modelClass: 'PV', coord: { x: 50, y: 60 } },
          ]),
          sections: { figure: { monochrome: true } },
        },
      ),
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
      figure: { monochrome: true },
    });
  });
});

describe('<SaveSystemDialog /> saving as .raw', () => {
  it('writes beside the .raw only the placement that survives its devices being renumbered', async () => {
    // A .raw file keeps no idx: reading it back numbers the devices and the
    // branches afresh. A position that says which bus it belongs to can be
    // found again; the rest would land on whatever has its idx by then.
    const user = userEvent.setup();
    const anchored = { x: 50, y: 60, bus: '3' };
    useCaseStore.setState({
      diagramLayout: buildSidecarLayout(
        { '3': { x: 10, y: 20 } },
        {
          nonBusCoords: {
            PQ: { PQ_0: anchored, PQ_9: { x: 9, y: 9 } },
            load: { PQ_0: anchored, PQ_9: { x: 9, y: 9 } },
          },
          sections: {
            controller_coordinates: { EXST1: { E1: { x: 1, y: 1 } } },
            units: { G1: { expanded: true } },
            figure: { monochrome: true },
          },
        },
      ),
    });
    nextPost = () => Promise.resolve({ filename: 'my-system.raw', bytes_written: 512 });
    render(withQueryClient(<Owner />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByRole('radio', { name: /raw/i }));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [, body, query] = putSpy.mock.calls[0] ?? [];
    expect(query).toEqual({ case_path: 'my-system.raw' });
    expect(body).toMatchObject({
      coordinates: { '3': { x: 10, y: 20 } },
      non_bus_coordinates: { PQ: { PQ_0: anchored }, load: { PQ_0: anchored } },
      controller_coordinates: {},
      units: {},
      figure: { monochrome: true },
    });
    expect((body as { non_bus_coordinates: { load: object } }).non_bus_coordinates.load).toEqual({
      PQ_0: anchored,
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
    useCaseStore.setState({ diagramLayout: buildSidecarLayout({ '1': { x: 10, y: 20 } }) });
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
