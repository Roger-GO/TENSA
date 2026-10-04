/**
 * The keys of `<GlobalShortcuts />` that interact with the browser or with other
 * layers of the page:
 *
 *  - Ctrl/Cmd+S (Save Page) and Ctrl/Cmd+O (Open File) belong to the browser, so
 *    they are swallowed even when there is nothing to save or open, from inside a
 *    text field and from any focused control, whatever its ARIA role; they run
 *    their command except from inside a dialog. The command palette is a dialog
 *    for Ctrl/Cmd+S, and not for Ctrl/Cmd+O, which switches it to Open case.
 *  - Esc aborts the streaming run, but only an Esc that nothing else used: the
 *    Esc that closes a dialog, menu or popover must not also stop a run. The
 *    dialog case runs against a real Radix dialog, because it is Radix's
 *    `preventDefault` on the keydown that the guard relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { UnitsToggle } from '@/components/shell/UnitsToggle';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { subscribePaletteDialog } from '@/lib/commands';
import type { PaletteDialogKey } from '@/lib/commands';
import { GlobalShortcuts } from '@/lib/useGlobalShortcuts';
import { toast } from '@/lib/toast';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

const postSpy = vi.fn();
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      post: (path: string, opts?: { body?: unknown }) => {
        postSpy(path, opts?.body);
        return Promise.resolve({ aborted: true });
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

function topology(): TopologySummary {
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

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** Dispatch a keydown the way the lib listens for it (it reads `code`, not `key`). */
function press(
  init: KeyboardEventInit & { key: string; code: string },
  target: EventTarget = document,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Let a request the key started (a mutation fires on a later tick) reach the spy. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Roles react-hotkeys-hook counts as form fields, though they are not form tags:
 * a Radix toggle item is a radio, the scrub strip a slider, a menu entry a menuitem.
 */
const FORM_ROLES = ['radio', 'slider', 'menuitem', 'option', 'textbox', 'spinbutton'];

/** A focused element that carries `role`, in the page until `remove()`. */
function focusedWithRole(role: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('role', role);
  el.tabIndex = 0;
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** The command palette's dialog with a text field in it, focused. */
function openPaletteDialog(): { palette: HTMLElement; input: HTMLInputElement } {
  const palette = document.createElement('div');
  palette.setAttribute('role', 'dialog');
  palette.setAttribute('data-testid', 'command-palette');
  const input = document.createElement('input');
  palette.appendChild(input);
  document.body.appendChild(palette);
  input.focus();
  return { palette, input };
}

const CTRL_S = { key: 's', code: 'KeyS', ctrlKey: true };
const META_S = { key: 's', code: 'KeyS', metaKey: true };
const CTRL_O = { key: 'o', code: 'KeyO', ctrlKey: true };
const ESCAPE = { key: 'Escape', code: 'Escape' };

/** The palette-dialog keys the commands post while the test runs. */
let posted: PaletteDialogKey[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  MOCK_TOPOLOGY = topology();
  postSpy.mockClear();
  posted = [];
  unsubscribe = subscribePaletteDialog((key) => posted.push(key));
  useSessionStore.setState({
    sessionId: parseSessionId('test-session'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
    topology: null,
    selectedElement: null,
    dragOverrides: {},
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useCommandPaletteStore.setState({ open: false, page: 'commands' });
  useRunsStore.getState().clearRuns();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});

afterEach(() => {
  unsubscribe?.();
  cleanup();
  vi.restoreAllMocks();
  useRunsStore.getState().clearRuns();
});

describe('Ctrl/Cmd+S', () => {
  it('opens Save system and keeps the browser from saving the page', () => {
    render(withProviders(<GlobalShortcuts />));
    for (const keys of [CTRL_S, META_S]) {
      posted = [];
      const event = press(keys);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual(['save-system']);
    }
  });

  it('still swallows the key with no case loaded, and says there is nothing to save', () => {
    MOCK_TOPOLOGY = null;
    const info = vi.spyOn(toast, 'info').mockReturnValue('id');
    render(withProviders(<GlobalShortcuts />));
    const event = press(CTRL_S);
    expect(event.defaultPrevented).toBe(true);
    expect(posted).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/nothing to save/i));
  });

  it('still swallows the key inside a text field, and saves', () => {
    render(withProviders(<GlobalShortcuts />));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      const event = press(CTRL_S, input);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual(['save-system']);
    } finally {
      input.remove();
    }
  });

  it.each(FORM_ROLES)('still swallows the key from a focused %s, and saves', (role) => {
    render(withProviders(<GlobalShortcuts />));
    const el = focusedWithRole(role);
    try {
      const event = press(CTRL_S, el);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual(['save-system']);
    } finally {
      el.remove();
    }
  });

  it('still swallows the key after a click on the units toggle, a Radix radio', async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <>
          <GlobalShortcuts />
          <UnitsToggle />
        </>,
      ),
    );
    await user.click(screen.getByRole('radio', { name: 'Actual units' }));
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Actual units' }));
    const event = press(CTRL_S, document.activeElement as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(posted).toEqual(['save-system']);
  });

  it('inside a dialog only swallows the key, so one dialog never opens on another', () => {
    render(withProviders(<GlobalShortcuts />));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();
    try {
      const event = press(CTRL_S, input);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual([]);
    } finally {
      dialog.remove();
    }
  });

  it('inside the command palette only swallows the key, so Save system does not open on it', () => {
    render(withProviders(<GlobalShortcuts />));
    const { palette, input } = openPaletteDialog();
    try {
      for (const keys of [CTRL_S, META_S]) {
        const event = press(keys, input);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(posted).toEqual([]);
    } finally {
      palette.remove();
    }
  });
});

describe('Ctrl/Cmd+S on a case that can be written back', () => {
  /** An xlsx case, with an edit that no save has written. */
  function openEditedXlsx(): void {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('cases/ieee14.xlsx'), addfiles: [] },
      cloneInitialized: false,
    });
    useEditJournalStore.getState().reset();
    useEditJournalStore
      .getState()
      .record({ op: 'add', model: 'Bus', params: { idx: 99, Vn: 110 } });
  }

  afterEach(() => {
    useCaseStore.setState({ cloneInitialized: false });
    useEditJournalStore.getState().reset();
  });

  it('writes the file itself, without a dialog, and keeps the browser from saving the page', async () => {
    openEditedXlsx();
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    render(withProviders(<GlobalShortcuts />));
    const event = press(CTRL_S);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy).toHaveBeenCalledWith('/sessions/test-session/save', {
      filename: 'cases/ieee14.xlsx',
      format: 'xlsx',
      overwrite: true,
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith('Saved cases/ieee14.xlsx'));
    expect(posted).toEqual([]);
  });

  it('says there is nothing to save when the file has no changes, and writes nothing', async () => {
    openEditedXlsx();
    useEditJournalStore.getState().markSavedInPlace();
    const info = vi.spyOn(toast, 'info').mockReturnValue('id');
    render(withProviders(<GlobalShortcuts />));
    press(META_S);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/nothing to save/i));
    expect(posted).toEqual([]);
  });

  it('opens Save system as instead while the parameter edits live in a copy of the case', async () => {
    openEditedXlsx();
    useCaseStore.setState({ cloneInitialized: true });
    render(withProviders(<GlobalShortcuts />));
    press(CTRL_S);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
    expect(posted).toEqual(['save-system']);
  });
});

describe('Ctrl/Cmd+O', () => {
  it('opens the palette on its Open case page and keeps the browser from opening a file', () => {
    render(withProviders(<GlobalShortcuts />));
    const event = press(CTRL_O);
    expect(event.defaultPrevented).toBe(true);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });
  });

  it('switches an open palette to Open case', () => {
    useCommandPaletteStore.setState({ open: true, page: 'commands' });
    render(withProviders(<GlobalShortcuts />));
    const { palette, input } = openPaletteDialog();
    try {
      press(CTRL_O, input);
      expect(useCommandPaletteStore.getState().page).toBe('open-case');
    } finally {
      palette.remove();
    }
  });

  it.each(FORM_ROLES)('still swallows the key from a focused %s, and opens Open case', (role) => {
    render(withProviders(<GlobalShortcuts />));
    const el = focusedWithRole(role);
    try {
      const event = press(CTRL_O, el);
      expect(event.defaultPrevented).toBe(true);
      expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });
    } finally {
      el.remove();
    }
  });

  it('still swallows the key while there is no session', () => {
    useSessionStore.setState({ sessionId: null });
    vi.spyOn(toast, 'info').mockReturnValue('id');
    render(withProviders(<GlobalShortcuts />));
    const event = press(CTRL_O);
    expect(event.defaultPrevented).toBe(true);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});

describe('Esc aborts the run', () => {
  function streamRun(): string {
    useRunsStore.getState().startRun({ runId: 'run-1', tf: 10, columnNames: ['Bus_1_v'] });
    return 'run-1';
  }

  it('does nothing when no run is streaming, and leaves the key alone', async () => {
    render(withProviders(<GlobalShortcuts />));
    const event = press(ESCAPE);
    expect(event.defaultPrevented).toBe(false);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('sends the abort request for the streaming run', async () => {
    streamRun();
    render(withProviders(<GlobalShortcuts />));
    const event = press(ESCAPE);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]?.[0]).toBe('/sessions/test-session/abort');
    // The request marks the run, which is what the Abort button reads to say
    // "Aborting…", and which stops a second Esc from sending another request.
    await waitFor(() => expect(useRunsStore.getState().runs['run-1']?.abortedLocally).toBe(true));
  });

  it('does not ask twice for a run that is already being aborted', async () => {
    const runId = streamRun();
    useRunsStore.getState().setAbortedLocally(runId, true);
    render(withProviders(<GlobalShortcuts />));
    press(ESCAPE);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not abort a run that has finished', async () => {
    const runId = streamRun();
    useRunsStore.getState().markRunDone(runId, 10, true);
    render(withProviders(<GlobalShortcuts />));
    press(ESCAPE);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores an Esc that something else already used', async () => {
    streamRun();
    render(withProviders(<GlobalShortcuts />));
    const consume = (e: Event) => e.preventDefault();
    // A capture listener on the document runs before the lib's, like Radix's.
    document.addEventListener('keydown', consume, { capture: true });
    try {
      press(ESCAPE);
    } finally {
      document.removeEventListener('keydown', consume, { capture: true });
    }
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores Esc pressed inside a text field', async () => {
    streamRun();
    render(withProviders(<GlobalShortcuts />));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      press(ESCAPE, input);
    } finally {
      input.remove();
    }
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('closing a dialog with Esc does not abort; the next Esc does', async () => {
    streamRun();
    const user = userEvent.setup();
    function Harness() {
      return (
        <>
          <GlobalShortcuts />
          <Dialog defaultOpen>
            <DialogContent data-testid="harness-dialog">
              <DialogTitle>Some dialog</DialogTitle>
              <DialogDescription>Open while a run streams.</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(withProviders(<Harness />));
    expect(screen.getByTestId('harness-dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('harness-dialog')).not.toBeInTheDocument());
    expect(postSpy).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
  });
});
