/**
 * Tests for `<SaveSnapshotDialog />` (Unit 7 of the v2.0 plan).
 *
 * Covers:
 * - Validation: empty / invalid name disables the confirm button.
 * - Confirm fires the substrate mutation and flips status to success.
 * - 409 collision surfaces an inline overwrite confirm; second click
 *   re-issues with ``force=true``.
 * - Generic error response surfaces inline.
 * - Cancel closes without firing the mutation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SaveSnapshotDialog } from '@/components/snapshot/SaveSnapshotDialog';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { parseSessionId } from '@/api/types';
import { useHotkeys as useHotkeysWrapper } from '@/lib/useHotkeys';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProblemResponse(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Error',
      status,
      detail,
      instance: null,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useSnapshotStore.getState().reset();
  // Open the dialog so the inner body mounts.
  useSnapshotStore.getState().openSaveDialog();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('<SaveSnapshotDialog /> — name validation', () => {
  it('renders the dialog with an empty input by default', async () => {
    render(withQueryClient(<SaveSnapshotDialog />));
    expect(await screen.findByTestId('save-snapshot-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('save-snapshot-name-input')).toHaveValue('');
    // Confirm is disabled with empty input.
    expect(screen.getByTestId('save-snapshot-confirm')).toBeDisabled();
  });

  it('shows a validation message for invalid characters', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), '../bad');
    expect(await screen.findByTestId('save-snapshot-validation-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-snapshot-confirm')).toBeDisabled();
  });

  it('enables confirm for a valid name', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), 'scenario-A');
    expect(screen.getByTestId('save-snapshot-confirm')).toBeEnabled();
  });
});

describe('<SaveSnapshotDialog /> — confirm flow', () => {
  it('confirm fires the substrate mutation and flips status to success', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        name: 'scenario-A',
        metadata: {
          andes_version: '2.0.0',
          andes_app_version: '0.1.0',
          case_filename: 'ieee14.raw',
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: false,
          has_tds: false,
        },
        dill_bytes: 1024,
        metadata_bytes: 256,
      }),
    );
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), 'scenario-A');
    await user.click(screen.getByTestId('save-snapshot-confirm'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/sessions/test-session-id/snapshot');
    expect((init as RequestInit).method).toBe('POST');
    await waitFor(() => expect(useSnapshotStore.getState().saveStatus).toBe('success'));
  });

  it('409 collision surfaces an inline overwrite confirm', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(makeProblemResponse(409, 'snapshot already exists'));
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), 'scenario-A');
    await user.click(screen.getByTestId('save-snapshot-confirm'));

    expect(await screen.findByTestId('save-snapshot-collision')).toBeInTheDocument();
    // Now an Overwrite button is visible; the original Save confirm is gone.
    expect(screen.queryByTestId('save-snapshot-confirm')).toBeNull();
    expect(screen.getByTestId('save-snapshot-confirm-overwrite')).toBeEnabled();

    // Second click → re-issue with force=true.
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        name: 'scenario-A',
        metadata: {
          andes_version: '2.0.0',
          andes_app_version: '0.1.0',
          case_filename: null,
          case_sha256: null,
          disturbance_log: [],
          saved_at: 'now',
          has_pflow: false,
          has_tds: false,
        },
        dill_bytes: 1024,
        metadata_bytes: 256,
      }),
    );
    await user.click(screen.getByTestId('save-snapshot-confirm-overwrite'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const secondCallBody = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    expect(secondCallBody.force).toBe(true);
  });

  it('422 error surfaces an inline error', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makeProblemResponse(422, 'invalid name'));
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.type(screen.getByTestId('save-snapshot-name-input'), 'scenario-A');
    await user.click(screen.getByTestId('save-snapshot-confirm'));
    await waitFor(() => expect(useSnapshotStore.getState().saveStatus).toBe('error'));
    expect(await screen.findByTestId('save-snapshot-error')).toHaveTextContent(/invalid name/i);
  });

  it('cancel closes the dialog without firing the mutation', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSnapshotDialog />));
    await user.click(screen.getByTestId('save-snapshot-cancel'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(false);
  });
});

// --- Unit 6: keyboard-interaction scenarios -----------------------------------
//
// The bug Unit 6 of the v2.0 polish plan documents: typing into the
// snapshot-name input incidentally triggered other field handlers
// (e.g., the bus filter), because hand-rolled `addEventListener`
// keyboard handlers didn't check `document.activeElement`. The fix is
// to (a) funnel all hotkey registration through `@/lib/useHotkeys`
// (which auto-skips when the active element is editable) and (b) rely
// on Radix Dialog's built-in `@radix-ui/react-focus-scope` to trap
// focus while the dialog is open.
//
// These tests lock in the contract: a global hotkey registered with
// the wrapper does NOT fire while the snapshot-name input has focus.
// This is the structural guarantee that prevents the bus-filter
// contamination class of bug from regressing.

// --- Unit 5: IME composition + React-friendly setter contract --------------
//
// The name field switched to `<Input>` in Unit 5. These tests pin the
// IME-deferral and the Playwright-fill escape-hatch behaviour.

describe('<SaveSnapshotDialog /> — Input contract (Unit 5)', () => {
  it('IME composition does not fire onChange mid-composition', async () => {
    render(withQueryClient(<SaveSnapshotDialog />));
    const input = (await screen.findByTestId('save-snapshot-name-input')) as HTMLInputElement;

    fireEvent.compositionStart(input);
    input.value = 'sce';
    fireEvent.input(input, { isComposing: true });
    // Mid-composition: snapshot store should not have advanced.
    expect(useSnapshotStore.getState().pendingName).toBe('');

    fireEvent.compositionEnd(input);
    // Commit lands in the store on compositionend.
    expect(useSnapshotStore.getState().pendingName).toBe('sce');
  });

  it('React-friendly programmatic setter fills the field and enables confirm', async () => {
    render(withQueryClient(<SaveSnapshotDialog />));
    const input = (await screen.findByTestId('save-snapshot-name-input')) as HTMLInputElement;

    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    desc!.set!.call(input, 'scenario-A');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await waitFor(() => expect(useSnapshotStore.getState().pendingName).toBe('scenario-A'));
    expect(screen.getByTestId('save-snapshot-confirm')).toBeEnabled();
  });
});

describe('<SaveSnapshotDialog /> — keyboard scoping (Unit 6)', () => {
  it('typing into the name input does not trigger a global hotkey', async () => {
    const user = userEvent.setup();
    const globalHotkeyCallback = vi.fn();

    function TestHarness() {
      // A representative global hotkey — the same registration shape
      // a future "?" cheatsheet or "/" focus-search shortcut would
      // use. The wrapper's default `enableOnFormTags: false` should
      // swallow keystrokes while the input has focus.
      useHotkeysWrapper('a', globalHotkeyCallback);
      return <SaveSnapshotDialog />;
    }

    render(withQueryClient(<TestHarness />));
    const input = await screen.findByTestId('save-snapshot-name-input');
    // userEvent.type both focuses and types into the input.
    await user.type(input, 'a-snapshot-name');
    expect(input).toHaveValue('a-snapshot-name');
    expect(globalHotkeyCallback).not.toHaveBeenCalled();
  });

  it('a global hotkey opted in via enableOnFormTags DOES fire from inside the input', async () => {
    const user = userEvent.setup();
    const palette = vi.fn();

    function TestHarness() {
      // The escape-hatch case: a "command palette" style shortcut
      // explicitly opts in to firing from inside form inputs. We use
      // a plain key (not a modifier combo) because jsdom's
      // KeyboardEvent doesn't carry modifier state through `userEvent`
      // reliably for the test purpose here — the lib's matcher is the
      // surface under test, not the OS's modifier handling.
      useHotkeysWrapper('a', palette, { enableOnFormTags: ['INPUT'] });
      return <SaveSnapshotDialog />;
    }

    render(withQueryClient(<TestHarness />));
    const input = await screen.findByTestId('save-snapshot-name-input');
    await user.type(input, 'a');
    // The opted-in callback fires; the input value also updates.
    expect(palette).toHaveBeenCalled();
    expect(input).toHaveValue('a');
  });

  it('Escape closes the dialog (Radix default) without firing global hotkeys', async () => {
    const user = userEvent.setup();
    const globalEscape = vi.fn();

    function TestHarness() {
      // Even if the user binds Escape globally (e.g., a future
      // "press Esc to close drawers" shortcut), the dialog's focus
      // scope owns the keystroke. Radix Dialog's onEscapeKeyDown
      // captures the event and closes the dialog; the global handler
      // doesn't see it because the editable input has focus and the
      // wrapper's default skips form tags.
      useHotkeysWrapper('escape', globalEscape);
      return <SaveSnapshotDialog />;
    }

    render(withQueryClient(<TestHarness />));
    const input = await screen.findByTestId('save-snapshot-name-input');
    // autoFocus targets the input on dialog open; reassert just in case.
    input.focus();
    await user.keyboard('{Escape}');
    // Radix should have closed the dialog…
    await waitFor(() => expect(useSnapshotStore.getState().saveDialogOpen).toBe(false));
    // …without our global handler ever firing (the input was the
    // active element when Esc was pressed; the wrapper's default
    // `enableOnFormTags: false` swallows it).
    expect(globalEscape).not.toHaveBeenCalled();
  });
});
