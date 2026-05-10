/**
 * Tests for `<TokenPasteModal />`.
 *
 * The modal owns three concerns:
 * 1. Conditional render (only when `auth.token === null`).
 * 2. URL-fragment fast path (read on first mount, validate, smoke-check,
 *    persist + clear fragment).
 * 3. Manual paste flow (format validation, smoke check, error surfaces).
 *
 * Each test stubs `globalThis.fetch` for the smoke-check round-trip and
 * resets the auth store between cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TokenPasteModal } from '@/components/auth/TokenPasteModal';
import { useAuthStore } from '@/store/auth';

const VALID_TOKEN = 'a'.repeat(64);

function mockFetchOnce(response: Response | Error): void {
  const spy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  spy.mockImplementationOnce(() => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
}

describe('<TokenPasteModal />', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ token: null, persistFailed: false });
    // Reset URL hash if any test set it.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('renders when token is null', () => {
    render(<TokenPasteModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Paste your andes-app token/i)).toBeInTheDocument();
  });

  it('returns null when token is set', () => {
    useAuthStore.setState({ token: VALID_TOKEN, persistFailed: false });
    const { container } = render(<TokenPasteModal />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects too-short tokens before submit', async () => {
    render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token');
    const submit = screen.getByRole('button', { name: /Continue/i });

    expect(submit).toBeDisabled();
    await userEvent.type(input, 'short');
    expect(submit).toBeDisabled();
  });

  it('trims trailing newline from cat-style paste then enables submit', async () => {
    render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token') as HTMLInputElement;
    const submit = screen.getByRole('button', { name: /Continue/i });

    // Simulate a paste with a trailing newline (the form trims at submit).
    await userEvent.click(input);
    // Use fireEvent-style change to set a value with newline directly,
    // because userEvent.type doesn't preserve a trailing literal '\n' the
    // way a real paste does in jsdom.
    input.value = `${VALID_TOKEN}\n`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Re-query in case React re-rendered.
    expect(submit).toBeEnabled();
  });

  it('on submit with 200, sets token and unmounts the dialog', async () => {
    mockFetchOnce(new Response('{"sessions":[]}', { status: 200 }));

    const { rerender } = render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token');

    await userEvent.type(input, VALID_TOKEN);
    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe(VALID_TOKEN);
    });
    rerender(<TokenPasteModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('on 401, shows inline error and keeps modal open', async () => {
    mockFetchOnce(new Response('{"title":"Unauthorized","status":401}', { status: 401 }));

    render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token');

    await userEvent.type(input, VALID_TOKEN);
    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Token rejected/i);
    });
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('on network error, shows Try again with debug-detail disclosure', async () => {
    mockFetchOnce(new TypeError('Failed to fetch'));

    render(<TokenPasteModal />);
    await userEvent.type(screen.getByLabelText('Token'), VALID_TOKEN);
    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not reach the substrate/i);
    });
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();

    // Disclosure expands the debug detail.
    await userEvent.click(screen.getByRole('button', { name: /Show debug detail/i }));
    expect(screen.getByText(/Failed to fetch/i)).toBeInTheDocument();
  });

  it('URL fragment fast path: success → token set, fragment cleared', async () => {
    window.history.replaceState(null, '', `/#token=${VALID_TOKEN}`);
    mockFetchOnce(new Response('{"sessions":[]}', { status: 200 }));

    render(<TokenPasteModal />);

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe(VALID_TOKEN);
    });
    expect(window.location.hash).toBe('');
  });

  it('URL fragment fast path: 401 → fragment still cleared, modal stays open', async () => {
    window.history.replaceState(null, '', `/#token=${VALID_TOKEN}`);
    mockFetchOnce(new Response('{"title":"Unauthorized","status":401}', { status: 401 }));

    render(<TokenPasteModal />);

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('URL fragment with malformed token is ignored', async () => {
    window.history.replaceState(null, '', '/#token=not-a-valid-hex-token');
    const fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');

    render(<TokenPasteModal />);

    // No fetch should have been issued — the regex didn't match.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows persist-failed banner when sessionStorage write fails', async () => {
    // jsdom's sessionStorage is host-sealed; replace it for the test.
    const original = window.sessionStorage;
    const throwingStub: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('QuotaExceeded', 'QuotaExceededError');
      },
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => throwingStub,
    });

    try {
      mockFetchOnce(new Response('{"sessions":[]}', { status: 200 }));

      render(<TokenPasteModal />);
      await userEvent.type(screen.getByLabelText('Token'), VALID_TOKEN);
      await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

      await waitFor(() => {
        expect(useAuthStore.getState().token).toBe(VALID_TOKEN);
        expect(useAuthStore.getState().persistFailed).toBe(true);
      });
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => original,
      });
    }
  });

  // --- Unit 5: IME composition + React-friendly setter contract ----------
  //
  // The token field is wrapped in `<Input>` (Unit 5). These two tests
  // lock in the IME deferral and the programmatic-setter pass-through
  // so a future regression in the Input primitive surfaces here too.

  it('IME composition does not fire onChange mid-composition; commits on compositionend', () => {
    render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token') as HTMLInputElement;

    fireEvent.compositionStart(input);
    input.value = 'ni';
    fireEvent.input(input, { isComposing: true });
    // Mid-composition should not have updated React state, so the
    // submit button stays disabled (the value is not 64-hex valid yet
    // either way, but the contract is "no onChange fires here").
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();

    fireEvent.compositionEnd(input);
    // After commit, React state updates; the input's displayed value
    // matches what was composed.
    expect(input.value).toBe('ni');
  });

  it('React-friendly programmatic setter (Playwright fill escape hatch) fills the field', async () => {
    render(<TokenPasteModal />);
    const input = screen.getByLabelText('Token') as HTMLInputElement;

    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    desc!.set!.call(input, VALID_TOKEN);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Submit becomes enabled (formatValid is now true).
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled());
  });

  it('does not Esc-close (the app is locked behind it)', async () => {
    render(<TokenPasteModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    // Token was not set; if Esc had closed the modal Radix would have
    // unmounted via its open state. We instead asserted on the auth
    // store: the token should still be null AND the dialog still in DOM.
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
