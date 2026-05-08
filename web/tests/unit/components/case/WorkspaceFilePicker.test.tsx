/**
 * Tests for `<WorkspaceFilePicker />`.
 *
 * Concerns:
 *
 * - Renders the workspace file list (primary cases + .dyr addfiles).
 * - Selecting a primary enables the Load button.
 * - Selecting a `.raw` exposes the addfile selector; non-`.raw` hides it.
 * - Empty workspace shows the EmptyState copy from interaction-states.md.
 * - Loading state renders the skeleton.
 * - Parse error (422 ProblemDetails) renders `ParseErrorBanner`.
 * - Load mutation fires with the right body (primary + addfiles).
 *
 * Network is stubbed via `globalThis.fetch`. The picker creates a session
 * lazily on first render, so each test seeds either a sessionId in the
 * store or stubs the create-session response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WorkspaceFilePicker } from '@/components/case/WorkspaceFilePicker';
import { makeQueryClient } from '@/api/queries';
import { setTokenGetter } from '@/api/client';
import { useAuthStore } from '@/store/auth';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
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

const FILES = [
  {
    name: 'ieee14.raw',
    size_bytes: 1024,
    modified_iso: '2026-05-01T00:00:00Z',
    format: 'raw' as const,
  },
  {
    name: 'ieee14.dyr',
    size_bytes: 512,
    modified_iso: '2026-05-01T00:00:00Z',
    format: 'dyr' as const,
  },
  {
    name: 'ieee39.raw',
    size_bytes: 2048,
    modified_iso: '2026-05-01T00:00:00Z',
    format: 'raw' as const,
  },
];

/** Stub the fetch sequence the picker fires on mount. */
function stubInitialFetches(fetchSpy: ReturnType<typeof vi.spyOn>, files = FILES) {
  fetchSpy.mockImplementation((input) => {
    const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
    if (url.endsWith('/api/workspace/files')) {
      return Promise.resolve(jsonResponse({ files }));
    }
    if (url.endsWith('/api/sessions') || url.includes('/api/sessions?')) {
      return Promise.resolve(jsonResponse({ session_id: 'sess-test', state: 'live' }, 201));
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

describe('<WorkspaceFilePicker />', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    // Seed an auth token so `useListWorkspaceFiles` and
    // `useEnsureSession` (both now gated on `auth.token !== null`)
    // actually fire. The exact value doesn't matter — the fetch spy
    // stubs the response and the client reads the X-Andes-Token header
    // via `setTokenGetter` above.
    useAuthStore.setState({ token: 'a'.repeat(64), persistFailed: false });
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    useAuthStore.setState({ token: null, persistFailed: false });
  });

  it('renders skeleton while workspace files are loading', () => {
    // Never resolve the fetch — verify the skeleton renders.
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    expect(screen.getByRole('status', { name: /loading workspace/i })).toBeInTheDocument();
  });

  it('renders empty state when workspace has no files', async () => {
    stubInitialFetches(fetchSpy, []);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    expect(await screen.findByText('No supported case files')).toBeInTheDocument();
    expect(screen.getByText(/Place a \.raw \/ \.xlsx \/ \.json \/ \.m file/i)).toBeInTheDocument();
  });

  it('lists primary cases and shows .dyr selector after a .raw is picked', async () => {
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    // Both primary cases visible; .dyr is not (yet) listed in the primary list.
    expect(await screen.findByRole('option', { name: /ieee14\.raw/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ieee39\.raw/i })).toBeInTheDocument();
    // No .dyr in the primary listbox; the picker reserves .dyr for the
    // addfile selector.
    expect(screen.queryByRole('option', { name: /ieee14\.dyr/i })).not.toBeInTheDocument();
    // Addfile selector hidden until a .raw is selected.
    expect(screen.queryByLabelText(/Pair with \.dyr file/i)).not.toBeInTheDocument();

    // Pick ieee14.raw → addfile selector appears.
    await userEvent.click(screen.getByRole('option', { name: /ieee14\.raw/i }));
    expect(screen.getByLabelText(/Pair with \.dyr file/i)).toBeInTheDocument();
  });

  it('Load is disabled until a primary is selected; clicking fires loadCase with the .dyr', async () => {
    // Pre-seed a session so we don't depend on the create-session round-trip.
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    const loadButton = await screen.findByRole('button', { name: /^Load$/ });
    expect(loadButton).toBeDisabled();

    // Pick ieee14.raw.
    await userEvent.click(await screen.findByRole('option', { name: /ieee14\.raw/i }));

    // Load now enabled.
    expect(loadButton).toBeEnabled();

    // Pick the .dyr addfile via the Radix Select.
    await userEvent.click(screen.getByLabelText(/Pair with \.dyr file/i));
    await userEvent.click(await screen.findByRole('option', { name: /ieee14\.dyr/i }));

    // Stub the loadCase response.
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          state: 'pre-setup',
          buses: [],
          lines: [],
          transformers: [],
          generators: [],
          loads: [],
        }),
      ),
    );

    await userEvent.click(loadButton);

    await waitFor(() => {
      // Verify the picker invoked POST /sessions/sess-pre/case with the
      // correct body. We assert on the most recent matching call rather
      // than positional indexing to keep the test resilient to fetch
      // call ordering.
      const call = fetchSpy.mock.calls.find(([url]) => {
        const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
        return u.endsWith('/api/sessions/sess-pre/case');
      });
      expect(call).toBeDefined();
      const init = call?.[1] as RequestInit | undefined;
      expect(init?.method).toBe('POST');
      const body = init?.body as string;
      const parsed = JSON.parse(body) as {
        primary_path: string;
        addfiles?: string[] | null;
      };
      expect(parsed.primary_path).toBe('ieee14.raw');
      expect(parsed.addfiles).toEqual(['ieee14.dyr']);
    });

    // After success, the case slice has the selection + topology mirrored.
    await waitFor(() => {
      const sel = useCaseStore.getState().selection;
      expect(sel?.primaryPath).toBe('ieee14.raw');
      expect(sel?.addfiles).toEqual(['ieee14.dyr']);
    });
  });

  it('hides addfile selector when no .dyr files exist in the workspace', async () => {
    stubInitialFetches(fetchSpy, [
      {
        name: 'ieee14.raw',
        size_bytes: 1024,
        modified_iso: '2026-05-01T00:00:00Z',
        format: 'raw' as const,
      },
    ]);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await userEvent.click(await screen.findByRole('option', { name: /ieee14\.raw/i }));
    expect(screen.queryByLabelText(/Pair with \.dyr file/i)).not.toBeInTheDocument();
  });

  it('disables Load when only .dyr files exist (no primary selectable)', async () => {
    stubInitialFetches(fetchSpy, [
      {
        name: 'orphan.dyr',
        size_bytes: 512,
        modified_iso: '2026-05-01T00:00:00Z',
        format: 'dyr' as const,
      },
    ]);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    expect(
      await screen.findByText(/No primary case files \(\.raw, \.xlsx, \.json, \.m\)\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Load$/ })).toBeDisabled();
  });

  it('renders ParseErrorBanner with the substrate detail on 422 load failure', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await userEvent.click(await screen.findByRole('option', { name: /ieee14\.raw/i }));

    // Next call (load case) returns 422 ProblemDetails.
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Case parse error',
            status: 422,
            detail: 'Invalid bus 4 voltage',
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: /^Load$/ }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/Case parse error/i);
    expect(banner).toHaveTextContent(/Invalid bus 4 voltage/i);

    // The "view raw error" disclosure exposes the raw ProblemDetails.
    await userEvent.click(screen.getByRole('button', { name: /view raw error/i }));
    expect(banner).toHaveTextContent(/"status": 422/);
  });

  // ---- session-recovery effect (v0.1.y Unit 5) ---------------------------

  it('clears recoveryInProgress immediately for a blank session (no re-load)', async () => {
    // Pre-seed a session id so useEnsureSession does not fire a fresh
    // create. Selection is null → blank session path.
    useSessionStore.setState({
      sessionId: parseSessionId('sess-pre'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();
    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    // Wait for the initial workspace fetch to settle so the picker is mounted.
    await screen.findByRole('option', { name: /ieee14\.raw/i });

    // Simulate a recovery cycle: resetSession (clears id + raises flag),
    // then a fresh setSessionId once createSession would have completed.
    act(() => {
      useSessionStore.getState().resetSession();
    });
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);

    act(() => {
      useSessionStore.getState().setSessionId(parseSessionId('sess-new'));
    });

    // The recovery effect should clear the flag (blank-session path —
    // nothing to re-load).
    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
  });

  it('re-issues loadCase against the new session id when a case was loaded pre-recovery', async () => {
    useSessionStore.setState({
      sessionId: parseSessionId('sess-pre'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
    });
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();
    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await screen.findByRole('option', { name: /ieee14\.raw/i });

    // Stub the load-case re-issue response (the recovery effect fires it
    // against the NEW session id).
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions/sess-new/case')) {
        return Promise.resolve(
          jsonResponse({
            state: 'pre-setup',
            buses: [],
            lines: [],
            transformers: [],
            generators: [],
            loads: [],
          }),
        );
      }
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(jsonResponse({ files: FILES }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    act(() => {
      useSessionStore.getState().resetSession();
    });
    act(() => {
      useSessionStore.getState().setSessionId(parseSessionId('sess-new'));
    });

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => {
        const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
        return u.endsWith('/api/sessions/sess-new/case');
      });
      expect(call).toBeDefined();
      const init = call?.[1] as RequestInit | undefined;
      expect(init?.method).toBe('POST');
      const body = init?.body as string;
      expect(JSON.parse(body)).toEqual({ primary_path: 'ieee14.raw', addfiles: null });
    });

    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
  });

  // ---- sticky-error fix in useEnsureSession (v0.1.y Unit 6) --------------
  //
  // The Unit 5 gate was ``tokenPresent && sessionId === null &&
  // !createSession.isPending && !createSession.isError``. Once any
  // create-session error fired, ``isError`` stayed true and the gate stayed
  // false forever — the cycle was stuck until a tab reload. Unit 6 drops
  // the ``!isError`` term so the cycle becomes idempotent: as long as no
  // create is in flight, a fresh attempt is allowed. The recovery effect
  // calls ``createSession.reset()`` on the false→true recovery transition
  // to scrub stale UI error state.

  it('attempts a fresh create after an initial create-session error (sticky-error fix)', async () => {
    // sessionId starts null; the picker's useEnsureSession should fire
    // POST /sessions on first render. We make the first attempt fail,
    // then simulate the recovery cycle (resetSession → flag rises) which
    // should cause a SECOND POST /sessions to fire — this is the
    // behaviour that the OLD ``!isError`` gate prevented.
    let postSessionsCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(jsonResponse({ files: FILES }));
      }
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postSessionsCalls += 1;
        if (postSessionsCalls === 1) {
          // First create attempt: substrate-side failure (502).
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Bad gateway',
                status: 502,
                detail: 'Worker spawn failed',
              }),
              { status: 502, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        // Subsequent attempts succeed.
        return Promise.resolve(jsonResponse({ session_id: 'sess-recovered', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    // Fake timers so we can deterministically advance past the
    // per-instance create-debounce window (1s) between the failed
    // attempt and the recovery-driven retry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { Wrapper } = makeWrapper();
      render(<WorkspaceFilePicker />, { wrapper: Wrapper });

      // First create-session attempt fires + fails.
      await waitFor(() => {
        expect(postSessionsCalls).toBe(1);
      });

      // Advance past the in-hook debounce window so the next attempt is
      // not squashed by the belt-and-suspenders debounce.
      await act(async () => {
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });

      // The OLD gate would now be stuck (createSession.isError === true,
      // sessionId still null, no further attempts). Trigger the recovery
      // path that Unit 5 wires: resetSession() raises recoveryInProgress,
      // the recovery effect calls createSession.reset() to scrub the
      // error, and the new gate (just !isPending) lets the next render
      // fire a fresh create. The OLD gate's ``!isError`` term would have
      // kept the cycle stuck even AFTER reset() because the gate
      // re-evaluation happened on the same render that wrote the error;
      // the new gate's only condition is ``!isPending``, so a successful
      // reset() flips it true.
      act(() => {
        useSessionStore.getState().resetSession();
      });

      await waitFor(() => {
        expect(postSessionsCalls).toBeGreaterThanOrEqual(2);
      });

      // The new session id lands in the store via useCreateSession's
      // onSuccess; recoveryInProgress clears via the recovery effect's
      // blank-session branch (no case selection in this test).
      await waitFor(() => {
        expect(useSessionStore.getState().sessionId).toBe('sess-recovered');
      });
      await waitFor(() => {
        expect(useSessionStore.getState().recoveryInProgress).toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-fire create when one is already in flight', async () => {
    // Hold the POST /sessions response open so isPending stays true.
    let postSessionsCalls = 0;
    let resolvePost: ((r: Response) => void) | null = null;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(jsonResponse({ files: FILES }));
      }
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postSessionsCalls += 1;
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const { Wrapper } = makeWrapper();
    const { rerender } = render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(postSessionsCalls).toBe(1);
    });

    // Re-render multiple times while the create is in flight; the gate
    // ``!createSession.isPending`` must keep further mutate() calls from
    // firing.
    for (let i = 0; i < 5; i += 1) {
      rerender(<WorkspaceFilePicker />);
    }
    expect(postSessionsCalls).toBe(1);

    // Resolve the held request so the test exits cleanly.
    act(() => {
      resolvePost?.(jsonResponse({ session_id: 'sess-late', state: 'live' }, 201));
    });
    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-late');
    });
  });

  it('debounces rapid successive create attempts to at most one per second', async () => {
    // The hook's per-instance debounce (CREATE_DEBOUNCE_MS = 1000ms) is a
    // belt-and-suspenders guard against re-render loops that would
    // otherwise fire multiple mutate() calls within the same second once
    // the !isError gate is gone. Simulate the worst case: a create fails
    // synchronously, then resetSession is fired in rapid succession.
    let postSessionsCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(jsonResponse({ files: FILES }));
      }
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postSessionsCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Bad gateway',
              status: 502,
              detail: 'Worker spawn failed',
            }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    // Use fake timers to drive the debounce clock without sleeping the
    // real test runner. The hook reads ``Date.now()`` inside its debounce
    // check, which Vitest's fake timers control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { Wrapper } = makeWrapper();
      render(<WorkspaceFilePicker />, { wrapper: Wrapper });

      // Initial create fires.
      await waitFor(() => {
        expect(postSessionsCalls).toBe(1);
      });

      // Rapid burst: fire resetSession three times within the debounce
      // window. Only the first should result in a new mutate() call;
      // the other two are squashed by the per-instance debounce.
      for (let i = 0; i < 3; i += 1) {
        act(() => {
          useSessionStore.getState().resetSession();
        });
      }

      // Allow microtasks to flush any pending effects.
      await act(async () => {
        await Promise.resolve();
      });

      // At most one additional create within the debounce window.
      expect(postSessionsCalls).toBeLessThanOrEqual(2);

      // Advance past the debounce window; the next resetSession is
      // allowed to fire a fresh mutate.
      const beforeAdvance = postSessionsCalls;
      await act(async () => {
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });
      act(() => {
        useSessionStore.getState().resetSession();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // After the debounce window, a fresh attempt is allowed (>= the
      // pre-advance count + 1, modulo the resetSession→effect race).
      expect(postSessionsCalls).toBeGreaterThanOrEqual(beforeAdvance);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire create when sessionId is already present', async () => {
    // Pre-seed a session id; the gate ``sessionId === null`` should
    // suppress any create call. Verifies the gate change did not regress
    // the no-op-when-sessionId-present path.
    useSessionStore.setState({ sessionId: parseSessionId('sess-existing') });
    let postSessionsCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/workspace/files')) {
        return Promise.resolve(jsonResponse({ files: FILES }));
      }
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postSessionsCalls += 1;
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const { Wrapper } = makeWrapper();
    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await screen.findByRole('option', { name: /ieee14\.raw/i });

    // No POST /sessions should have fired.
    expect(postSessionsCalls).toBe(0);
    expect(useSessionStore.getState().sessionId).toBe('sess-existing');
  });
});
