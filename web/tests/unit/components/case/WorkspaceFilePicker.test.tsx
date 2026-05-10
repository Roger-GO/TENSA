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
import { render, screen, waitFor } from '@testing-library/react';
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
    // Pre-seed a session id so the Load button text is "Load" (not
    // "Connecting…"). The picker no longer drives session creation —
    // that's owned by ``useSessionRecovery`` at the App root — so a
    // standalone picker render with sessionId=null leaves the button in
    // the "Connecting…" state forever.
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
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

  // ---- v0.2 polish Unit 1 — same-file no-op guard ------------------------

  it('clicking Load on the same file as the currently-loaded selection is a no-op', async () => {
    // Pre-seed a loaded selection that exactly matches the file the user
    // will click. The Load click should NOT fire ``POST /case`` again —
    // reloading the same case would tear down PF results, snapshots, etc.
    // to land back at the same state.
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
    });
    stubInitialFetches(fetchSpy);
    const { Wrapper } = makeWrapper();

    render(<WorkspaceFilePicker />, { wrapper: Wrapper });

    await userEvent.click(await screen.findByRole('option', { name: /ieee14\.raw/i }));

    // Track whether POST /case fires after this point.
    const callsBefore = fetchSpy.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /^Load$/ }));

    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 50));

    // No new ``POST /case`` calls (the only fetch we'd accept is the
    // workspace-files refetch, which we don't trigger here).
    const newCalls = fetchSpy.mock.calls.slice(callsBefore);
    const caseCalls = newCalls.filter(([url, init]) => {
      const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
      const m = (init as RequestInit | undefined)?.method;
      return u.endsWith('/case') && m === 'POST';
    });
    expect(caseCalls).toHaveLength(0);
  });
});
