/**
 * Tests for `<CaseNav />`.
 *
 * Covers the picker ↔ summary toggle, the Change-case destructive
 * confirmation flow, and the pflow-running disabled affordance with
 * tooltip.
 *
 * Network is stubbed via `globalThis.fetch`. The case + session + pflow
 * slices are reset between tests to avoid cross-test contamination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CaseNav } from '@/components/case/CaseNav';
import { makeQueryClient } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

/**
 * Seed the case slice with a loaded ieee14 case so CaseNav renders the
 * summary card. Topology defaults to `pre-setup`.
 */
function seedLoadedCase() {
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [parseWorkspacePath('ieee14.dyr')],
    },
    topology: {
      state: 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    },
    layoutSidecar: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId('sess-loaded') });
}

describe('<CaseNav />', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders an inline empty hint (not the full picker) when no case is loaded', () => {
    // v3 LeftSidebar mounts SavedCasesList in a sibling section, so
    // CaseNav's no-case branch shows an inline hint pointing the user
    // there instead of duplicating the file picker.
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    expect(screen.getByTestId('case-nav-empty')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading workspace/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Loaded case/i)).not.toBeInTheDocument();
  });

  it('renders the summary card when a case is loaded', () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    expect(screen.getByText('Loaded case')).toBeInTheDocument();
    expect(screen.getByText('ieee14.raw')).toBeInTheDocument();
    expect(screen.getByText('ieee14.dyr')).toBeInTheDocument();
    expect(screen.getByText('pre-setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change case/i })).toBeEnabled();
  });

  it('Change case opens the confirm dialog; Cancel closes it without side effects', async () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    await userEvent.click(screen.getByRole('button', { name: /change case/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Discard current session\?/i);

    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Case slice is unchanged.
    expect(useCaseStore.getState().selection?.primaryPath).toBe('ieee14.raw');
  });

  it('confirm fires DELETE and clears the case slice (POST owned by App-level driver)', async () => {
    // v0.2 polish Unit 1 — CaseNav no longer calls ``createSession``
    // itself. The session re-create is owned by the App-level
    // ``useSessionRecovery`` driver (single source of truth — see hook
    // docstring). CaseNav's responsibility ends at clearing the slices
    // and issuing DELETE; the recovery hook picks up ``sessionId === null``
    // and mints the fresh one.
    seedLoadedCase();
    fetchSpy.mockImplementation((...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL;
      const init = args[1] as RequestInit | undefined;
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      const method = init?.method;
      if (url.endsWith('/api/sessions/sess-loaded') && method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith('/api/sessions') && method === 'POST') {
        // CaseNav should NOT fire this (App-level driver owns it). If we
        // see it, the test will assert against it below.
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      return new Promise<Response>(() => {});
    });
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    await userEvent.click(screen.getByRole('button', { name: /change case/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Discard & change case/i }));

    // Case slice cleared (selection back to null) and the picker reappears.
    await waitFor(() => {
      expect(useCaseStore.getState().selection).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Verify the DELETE was issued for the original session id.
    const deleteCall = fetchSpy.mock.calls.find(([url, init]) => {
      const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
      const m = (init as RequestInit | undefined)?.method;
      return u.endsWith('/api/sessions/sess-loaded') && m === 'DELETE';
    });
    expect(deleteCall).toBeDefined();

    // CaseNav does NOT call ``POST /sessions`` itself any more. The
    // App-level useSessionRecovery driver owns that. (Test does not
    // mount the driver, so no POST should fire from this surface.)
    const postCall = fetchSpy.mock.calls.find(([url, init]) => {
      const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
      const m = (init as RequestInit | undefined)?.method;
      return u.endsWith('/api/sessions') && m === 'POST';
    });
    expect(postCall).toBeUndefined();
    // Session id was cleared by the DELETE handler's ``clearSession()``
    // and stays null until the App-level driver mints a new one.
    expect(useSessionStore.getState().sessionId).toBeNull();
  });

  it('disables Change case while pflow is running and shows the explanatory tooltip', async () => {
    seedLoadedCase();
    usePflowStore.setState({ isRunning: true, lastRun: null, error: null });
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    const changeCase = screen.getByRole('button', { name: /change case/i });
    expect(changeCase).toBeDisabled();

    // Hovering / focusing the wrapping span surfaces the tooltip explaining
    // the disabled cause. Radix Tooltip mounts the content into a portal
    // on open.
    await userEvent.hover(changeCase.parentElement!);

    // Radix mounts a visible tooltip + a screen-reader-only copy with
    // role="tooltip"; findAllByText returns both. Asserting on the
    // count is more deterministic than relying on the visible one.
    const matches = await screen.findAllByText('Wait for power flow to finish.');
    expect(matches.length).toBeGreaterThan(0);
  });
});
