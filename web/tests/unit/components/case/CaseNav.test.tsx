/**
 * Tests for `<CaseNav />`.
 *
 * Covers the picker ↔ summary toggle, the Change-case destructive
 * confirmation flow, the pflow-running disabled affordance with
 * tooltip, and the Add element button of the summary card.
 *
 * Network is stubbed via `globalThis.fetch`. The case + session + pflow
 * slices are reset between tests to avoid cross-test contamination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CaseNav } from '@/components/case/CaseNav';
import { makeQueryClient, queryKeys } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useLayoutStore } from '@/store/layout';
import { useReloadedCaseStore } from '@/store/reloadedCase';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

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

/** The session's topology as the query cache holds it once the case has loaded. */
function loadedTopology(state: TopologySummary['state']): TopologySummary {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

describe('<CaseNav />', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
    useCaseStore.getState().closeAddPanel();
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useReloadedCaseStore.setState({ closed: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useReloadedCaseStore.setState({ closed: null });
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

  it('points at the Saved cases below and opens the Components tab from the hint', async () => {
    useLayoutStore.setState({ leftSidebarTab: 'project', leftSidebarCollapsed: false });
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    const user = userEvent.setup();

    render(<CaseNav />, { wrapper: Wrapper });

    const hint = screen.getByTestId('case-nav-empty');
    expect(hint).toHaveTextContent(
      'No case loaded. Pick a file from Saved cases below, drop a case file anywhere in this window, or start a blank system with a component from the Components tab.',
    );
    await user.click(within(hint).getByRole('button', { name: 'Components tab' }));
    expect(useLayoutStore.getState().leftSidebarTab).toBe('components');
  });

  it('says nothing of a reload on a first visit', () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    expect(screen.queryByTestId('reloaded-case-note-project')).not.toBeInTheDocument();
  });

  it('after a reload, names the case the reload closed and reopens it from the card', async () => {
    // A reload starts an empty session, so the card read "No case loaded" as
    // on a first visit and the case had to be found again among the saved ones.
    useReloadedCaseStore.setState({ closed: { primaryPath: 'kundur_full.xlsx', addfiles: [] } });
    useSessionStore.setState({ sessionId: parseSessionId('sess-new') });
    const loads: unknown[] = [];
    fetchSpy.mockImplementation((...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL;
      const init = args[1] as RequestInit | undefined;
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(
          jsonResponse({
            files: [
              {
                name: 'kundur_full.xlsx',
                size_bytes: 1024,
                modified_iso: '2026-05-01T00:00:00Z',
                format: 'xlsx',
              },
            ],
          }),
        );
      }
      if (url.endsWith('/api/sessions/sess-new/case') && init?.method === 'POST') {
        loads.push(JSON.parse(String(init.body)));
        return Promise.resolve(jsonResponse(loadedTopology('pre-setup')));
      }
      return new Promise<Response>(() => {});
    });
    const { Wrapper } = makeWrapper();
    const user = userEvent.setup();

    render(<CaseNav />, { wrapper: Wrapper });

    const hint = screen.getByTestId('case-nav-empty');
    expect(within(hint).getByTestId('reloaded-case-note-project')).toHaveTextContent(
      'A reload of the page closes the open case. kundur_full.xlsx was open.',
    );
    // The ways to another case are still there, under the note.
    expect(hint).toHaveTextContent('No case loaded. Pick a file from Saved cases below');

    await user.click(within(hint).getByRole('button', { name: 'Reopen kundur_full.xlsx' }));

    expect(await screen.findByText('Loaded case')).toBeInTheDocument();
    expect(screen.getByText('kundur_full.xlsx')).toBeInTheDocument();
    expect(loads).toEqual([{ primary_path: 'kundur_full.xlsx', addfiles: null }]);
    expect(screen.queryByTestId('reloaded-case-note-project')).not.toBeInTheDocument();
  });

  it('keeps the note of a reload away while a case is being opened', () => {
    useReloadedCaseStore.setState({ closed: { primaryPath: 'kundur_full.xlsx', addfiles: [] } });
    useCaseStore.setState({ loadingPath: parseWorkspacePath('wscc9.xlsx') });
    try {
      fetchSpy.mockImplementation(() => new Promise(() => {}));
      const { Wrapper } = makeWrapper();

      render(<CaseNav />, { wrapper: Wrapper });

      expect(screen.getByTestId('case-nav-empty')).toHaveTextContent('Loading wscc9.xlsx');
      expect(screen.queryByTestId('reloaded-case-note-project')).not.toBeInTheDocument();
    } finally {
      useCaseStore.setState({ loadingPath: null });
    }
  });

  it('says which case is loading, instead of "No case loaded", while a load runs', () => {
    useCaseStore.setState({ loadingPath: parseWorkspacePath('wscc9.xlsx') });
    try {
      fetchSpy.mockImplementation(() => new Promise(() => {}));
      const { Wrapper } = makeWrapper();

      render(<CaseNav />, { wrapper: Wrapper });

      const hint = screen.getByTestId('case-nav-empty');
      expect(hint).toHaveTextContent('Loading wscc9.xlsx');
      expect(hint).toHaveAttribute('aria-busy', 'true');
      expect(hint).not.toHaveTextContent('No case loaded');
    } finally {
      useCaseStore.setState({ loadingPath: null });
    }
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

  it('has an Add element button that opens the Add element panel, the kind still to pick', async () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { client, Wrapper } = makeWrapper();
    client.setQueryData(
      queryKeys.topology(parseSessionId('sess-loaded')),
      loadedTopology('pre-setup'),
    );

    render(<CaseNav />, { wrapper: Wrapper });

    const add = screen.getByRole('button', { name: 'Add element' });
    expect(add).toBeEnabled();
    expect(screen.queryByTestId('add-element-blocked')).toBeNull();
    await userEvent.click(add);
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: null });
  });

  it('greys Add element out and says why under it once a run has locked the system', () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { client, Wrapper } = makeWrapper();
    client.setQueryData(
      queryKeys.topology(parseSessionId('sess-loaded')),
      loadedTopology('committed'),
    );

    render(<CaseNav />, { wrapper: Wrapper });

    const add = screen.getByRole('button', { name: 'Add element' });
    expect(add).toBeDisabled();
    const reason = screen.getByTestId('add-element-blocked');
    expect(reason).toHaveTextContent('A run has locked the system.');
    expect(reason).toHaveTextContent('Reset run');
    // The reason is read out with the button, not only shown beside it.
    expect(add).toHaveAttribute('aria-describedby', reason.id);
    // Changing the case is another matter, and stays possible.
    expect(screen.getByRole('button', { name: /change case/i })).toBeEnabled();
  });

  it('holds Add element back while the case is still loading', () => {
    seedLoadedCase();
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<CaseNav />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: 'Add element' })).toBeDisabled();
    expect(screen.getByTestId('add-element-blocked')).toHaveTextContent(
      'The case is still loading.',
    );
  });
});
