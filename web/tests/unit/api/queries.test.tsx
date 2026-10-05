/**
 * Smoke tests for the TanStack Query hooks in `src/api/queries.ts`.
 *
 * These tests don't exercise every cache permutation — the goal is to
 * prove the wrapper-around-fetch-+-store-write contract holds end-to-end:
 *
 * - `useCreateSession` writes to the session store on success.
 * - `useLoadCase` populates the topology cache on success.
 * - `useRunPflow` invalidates the topology cache (state flips).
 *
 * The fetch is stubbed; the QueryClient is freshly minted per test to
 * isolate cache state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  queryKeys,
  fetchComtradeRecord,
  fetchResponseMetrics,
  isWaitingForSession,
  useAlterableParams,
  useCpfQvRun,
  useCpfRun,
  useCreateSession,
  useDaeVariables,
  useListPmus,
  useListProfiles,
  useListSnapshots,
  useLoadCase,
  useRestoreSnapshot,
  useRunPflow,
  useSaveSnapshot,
  useTdsControllers,
  useTopology,
  useUploadWorkspaceFile,
} from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useRecentCasesStore } from '@/store/recentCases';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useMessagesStore } from '@/store/messages';
import { useJobsStore, LOCAL_ID_PREFIX, isTerminalStatus } from '@/store/jobs';
import type { SessionId, WorkspacePath } from '@/api/types';

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

describe('queries hooks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, loadingPath: null });
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useCaseStore.setState({ selection: null });
  });

  it('useCreateSession writes session_id to the session store', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ session_id: 'sess-123', state: 'live' }, 201));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(useSessionStore.getState().sessionId).toBe('sess-123');
  });

  it('useLoadCase seeds the topology cache on success', async () => {
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(topology));

    const { client, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    const sessionId = 'sess-1' as SessionId;
    result.current.mutate({
      sessionId,
      request: { primary_path: 'ieee14.xlsx' },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(client.getQueryData(queryKeys.topology(sessionId))).toEqual(topology);
  });

  it('useLoadCase puts the case, and the dynamic files it loaded with, at the top of the recent cases', async () => {
    useRecentCasesStore.setState({ cases: [] });
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    fetchSpy.mockImplementation(async () => jsonResponse(topology));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    const sessionId = 'sess-recent' as SessionId;
    await act(async () => {
      await result.current.mutateAsync({ sessionId, request: { primary_path: 'kundur.raw' } });
      await result.current.mutateAsync({
        sessionId,
        request: { primary_path: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
      });
    });
    expect(useRecentCasesStore.getState().cases).toMatchObject([
      { primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
      { primaryPath: 'kundur.raw', addfiles: [] },
    ]);
    useRecentCasesStore.setState({ cases: [] });
  });

  it('useLoadCase does not record a case that failed to load', async () => {
    useRecentCasesStore.setState({ cases: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'bad' },
        422,
      ),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    result.current.mutate({
      sessionId: 'sess-bad-recent' as SessionId,
      request: { primary_path: 'broken.raw' },
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(useRecentCasesStore.getState().cases).toEqual([]);
  });

  describe('useLoadCase and what ANDES said about the case it replaces', () => {
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    const said = (seq: number, text: string) => ({
      seq,
      time: 1_700_000_000 + seq,
      level: 'warning' as const,
      logger: 'andes.test',
      source: 'run_pflow',
      text,
      repeat: 1,
    });
    const page = (messages: ReturnType<typeof said>[]) => ({
      messages,
      first_seq: messages[0]?.seq ?? 1,
      last_seq: messages[messages.length - 1]?.seq ?? 0,
      next_after: messages[messages.length - 1]?.seq ?? 0,
      dropped: 0,
    });
    const texts = () => useMessagesStore.getState().messages.map((m) => m.text);

    afterEach(() => useMessagesStore.getState().reset());

    it('forgets them once the new case has loaded, and keeps what the load logged', async () => {
      useMessagesStore
        .getState()
        .receive('sess-msg', page([said(1, 'old case warning'), said(2, 'old case again')]));
      let release: (r: Response) => void = () => {};
      fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

      result.current.mutate({
        sessionId: 'sess-msg' as SessionId,
        request: { primary_path: 'kundur.xlsx' },
      });
      await waitFor(() => expect(useCaseStore.getState().loadingPath).toBe('kundur.xlsx'));
      // Still the old case's until the load lands, and the load's own messages are not lost
      // whether they were read before or after it.
      expect(texts()).toEqual(['old case warning', 'old case again']);
      useMessagesStore.getState().receive('sess-msg', page([said(3, 'load message')]));

      release(jsonResponse(topology));
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(texts()).toEqual(['load message']);
    });

    it('keeps them when the load fails, since the old case is still the one open', async () => {
      useMessagesStore.getState().receive('sess-msg', page([said(1, 'old case warning')]));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'bad' },
          422,
        ),
      );
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
      result.current.mutate({
        sessionId: 'sess-msg' as SessionId,
        request: { primary_path: 'broken.raw' },
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(texts()).toEqual(['old case warning']);
    });

    it('leaves the messages of another session alone', async () => {
      useMessagesStore.getState().receive('sess-other', page([said(1, 'other session')]));
      fetchSpy.mockResolvedValueOnce(jsonResponse(topology));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
      result.current.mutate({
        sessionId: 'sess-msg' as SessionId,
        request: { primary_path: 'kundur.xlsx' },
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(texts()).toEqual(['other session']);
    });
  });

  it('useLoadCase marks the case as loading while the request runs, and clears it after', async () => {
    // ``selection`` is only set once a load lands, so this flag is what lets
    // the UI say "Loading <file>…" through a slow first load.
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    let release: (r: Response) => void = () => {};
    fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    expect(useCaseStore.getState().loadingPath).toBeNull();

    result.current.mutate({
      sessionId: 'sess-slow' as SessionId,
      request: { primary_path: 'wscc9.xlsx' },
    });
    await waitFor(() => expect(useCaseStore.getState().loadingPath).toBe('wscc9.xlsx'));

    release(jsonResponse(topology));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(useCaseStore.getState().loadingPath).toBeNull();
  });

  it('useLoadCase clears the loading flag when the load fails', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no such file' },
        404,
      ),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    result.current.mutate({
      sessionId: 'sess-bad' as SessionId,
      request: { primary_path: 'missing.xlsx' },
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(useCaseStore.getState().loadingPath).toBeNull();
  });

  it('useLoadCase invalidates the per-case snapshots list on success', async () => {
    // Snapshots are listed per-case; the query first runs before any case
    // is loaded (caching []). Loading a case must invalidate it so the new
    // case's existing snapshots surface (panel + Sweep picker).
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(topology));

    const { client, Wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    const sessionId = 'sess-snap' as SessionId;
    result.current.mutate({ sessionId, request: { primary_path: 'kundur_full.xlsx' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['snapshots', sessionId] });
  });

  it('snapshot hooks leave the solver-state (dill) blob opt-in', async () => {
    // A save writes no blob and a restore replays unless the caller opts in.
    const sessionId = 'sess-dill' as SessionId;
    const metadata = {
      andes_version: '2.0.0',
      tensa_version: '0.1.0',
      case_filename: 'ieee14.raw',
      case_sha256: null,
      disturbance_log: [],
      saved_at: 'now',
      has_pflow: true,
      has_tds: false,
    };
    const bodies = (): unknown[] =>
      fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

    // A fresh Response per call: a body can be read only once.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          name: 'a',
          metadata,
          dill_bytes: 0,
          metadata_bytes: 1,
          used_dill: false,
          fallback_reason: null,
          disturbances_replayed: 0,
        }),
      ),
    );
    const { Wrapper } = makeWrapper();
    const save = renderHook(() => useSaveSnapshot(), { wrapper: Wrapper });
    const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

    await save.result.current.mutateAsync({ sessionId, name: 'a' });
    await restore.result.current.mutateAsync({ sessionId, name: 'a' });
    expect(bodies()).toEqual([
      { name: 'a', force: false, include_dill: false },
      { name: 'a', use_dill_optimization: false },
    ]);

    fetchSpy.mockClear();
    await save.result.current.mutateAsync({ sessionId, name: 'a', includeDill: true });
    await restore.result.current.mutateAsync({ sessionId, name: 'a', useDillOptimization: true });
    expect(bodies()).toEqual([
      { name: 'a', force: false, include_dill: true },
      { name: 'a', use_dill_optimization: true },
    ]);
  });

  it('useAlterableParams hits the substrate path scoped to (session, model)', async () => {
    const sessionId = parseSessionId('sess-alter');
    useSessionStore.setState({ sessionId });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ model: 'PQ', params: ['p0', 'q0'] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAlterableParams('PQ'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.params).toEqual(['p0', 'q0']);
    // The fetch went to the alterable_params path scoped to the session.
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/sessions/sess-alter/topology/models/PQ/alterable_params');
  });

  it('useAlterableParams stays disabled until session + model are present', () => {
    useSessionStore.setState({ sessionId: null });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAlterableParams('PQ'), { wrapper: Wrapper });
    // Without a session, the hook never fires; status sits at "pending"
    // with fetchStatus "idle".
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useDaeVariables asks for a page of the matches of the words, scoped to the session', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-dae') });
    useCaseStore.setState({
      selection: { primaryPath: 'kundur_full.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ total: 1, items: [] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDaeVariables(' omega gen ', 50), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ''), 'http://localhost');
    expect(url.pathname).toBe('/api/sessions/sess-dae/dae-variables');
    // The words are trimmed, and the page size is asked for.
    expect(url.searchParams.get('q')).toBe('omega gen');
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('useDaeVariables sends no q for no words', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-dae') });
    useCaseStore.setState({
      selection: { primaryPath: 'kundur_full.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDaeVariables('  ', 25), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ''), 'http://localhost');
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('useDaeVariables lists a blank system too: it has no file but it has devices', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-dae') });
    useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDaeVariables('', 10), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('useTdsControllers asks the session for what a controller can command', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-ctl') });
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14_esd1.xlsx' as WorkspacePath, addfiles: [] },
    });
    const catalogue = {
      types: ['droop', 'ffr'],
      coi_available: true,
      freq_hz: 60,
      base_mva: 100,
      targets: [],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(catalogue));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTdsControllers(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(catalogue);
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ''), 'http://localhost');
    expect(url.pathname).toBe('/api/sessions/sess-ctl/tds/controllers');
  });

  it('useTdsControllers stays disabled without a session or without a case', () => {
    const { Wrapper } = makeWrapper();
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14_esd1.xlsx' as WorkspacePath, addfiles: [] },
    });
    const noSession = renderHook(() => useTdsControllers(), { wrapper: Wrapper });
    expect(noSession.result.current.fetchStatus).toBe('idle');

    useSessionStore.setState({ sessionId: parseSessionId('sess-ctl') });
    useCaseStore.setState({ selection: null });
    const noCase = renderHook(() => useTdsControllers(), { wrapper: Wrapper });
    expect(noCase.result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useTdsControllers asks again once a battery has been added to the case', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-ctl') });
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14.raw' as WorkspacePath, addfiles: [] },
      topology: null,
    });
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ types: [], coi_available: false, freq_hz: 60, base_mva: 100, targets: [] }),
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTdsControllers(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    act(() => {
      useCaseStore.setState({
        topology: {
          state: 'pre-setup',
          buses: [],
          lines: [],
          transformers: [],
          generators: [],
          loads: [],
          controllers: [{ idx: 'ESD1_1', name: 'ESD1_1', kind: 'ESD1', params: {} }],
        },
      });
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    useCaseStore.setState({ topology: null });
  });

  it('useTdsControllers asks again when another request held the session', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-busy') });
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14_esd1.xlsx' as WorkspacePath, addfiles: [] },
    });
    // The TDS tab asks for the variables and the controllers at once; one is refused.
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'busy' }, 409),
      )
      .mockResolvedValueOnce(
        jsonResponse({ types: [], coi_available: true, freq_hz: 60, base_mva: 100, targets: [] }),
      );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTdsControllers(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a list refused because another request held the session is asked for again', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-busy') });
    useCaseStore.setState({
      selection: { primaryPath: 'kundur_full.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'busy' }, 409),
      )
      .mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDaeVariables('', 10), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The refusal never showed as an error.
    expect(result.current.isError).toBe(false);
  });

  describe('a list a run keeps from its caller', () => {
    const refused = () =>
      Promise.resolve(
        jsonResponse({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'busy' }, 409),
      );
    const CATALOGUE = {
      types: ['droop', 'ffr'],
      coi_available: true,
      freq_hz: 60,
      base_mva: 100,
      targets: [],
    };

    /** Let ``ms`` of the hook's waiting between two tries go by. */
    async function pass(ms: number): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      useSessionStore.setState({ sessionId: parseSessionId('sess-busy') });
      useCaseStore.setState({
        selection: { primaryPath: 'ieee14_esd1.xlsx' as WorkspacePath, addfiles: [] },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('says so after a few tries, and goes on saying so while it asks once every two seconds', async () => {
      fetchSpy.mockImplementation(refused);
      // Whether a caller would show its busy message, at each render.
      const shown: boolean[] = [];
      const { Wrapper } = makeWrapper();
      const { result, unmount } = renderHook(
        () => {
          const list = useDaeVariables('', 10);
          shown.push(isWaitingForSession(list));
          return list;
        },
        { wrapper: Wrapper },
      );

      // Two of the quick tries in: nothing to say yet, another list may be all that is in the way.
      await pass(500);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(isWaitingForSession(result.current)).toBe(false);

      // The first try and three more, within about a second.
      await pass(600);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(isWaitingForSession(result.current)).toBe(true);

      // From here on one request every two seconds, for as long as the run goes.
      await pass(10_000);
      expect(fetchSpy).toHaveBeenCalledTimes(9);
      // Never an error and never loading afresh in between: once the message
      // is up it stays up, through every refusal that follows.
      expect(result.current.isError).toBe(false);
      const since = shown.indexOf(true);
      expect(shown.length - since).toBeGreaterThan(5);
      expect(shown.slice(since)).not.toContain(false);
      unmount();
    });

    const LISTS: { list: string; use: () => UseQueryResult<unknown, Error>; answer: unknown }[] = [
      {
        list: 'the ANDES variables',
        use: () => useDaeVariables('omega', 10),
        answer: { total: 1, items: [] },
      },
      {
        list: 'the devices a controller can command',
        use: () => useTdsControllers(),
        answer: CATALOGUE,
      },
    ];

    it.each(LISTS)('$list are back when the run ends, with nothing asked anew', async (given) => {
      const { use, answer } = given;
      fetchSpy.mockImplementation(refused);
      const { Wrapper } = makeWrapper();
      // Rendered once: nothing about what is asked for changes from here on.
      const { result, unmount } = renderHook(use, { wrapper: Wrapper });

      await pass(8_000);
      expect(isWaitingForSession(result.current)).toBe(true);
      expect(result.current.data).toBeUndefined();
      const asked = fetchSpy.mock.calls.length;

      // The run ends: the next time the list is asked for it is answered.
      fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(answer)));
      await pass(2_000);

      expect(result.current.isSuccess).toBe(true);
      expect(result.current.data).toEqual(answer);
      expect(isWaitingForSession(result.current)).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(asked + 1);
      // And that is the end of the asking.
      await pass(4_000);
      expect(fetchSpy).toHaveBeenCalledTimes(asked + 1);
      unmount();
    });

    it('gives up on a list nobody waits for any more, and asks again when somebody does', async () => {
      fetchSpy.mockImplementation(refused);
      const { Wrapper } = makeWrapper();
      const first = renderHook(() => useTdsControllers(), { wrapper: Wrapper });
      await pass(4_000);
      expect(isWaitingForSession(first.result.current)).toBe(true);

      // The TDS tab is closed while the run goes: no more requests.
      first.unmount();
      await pass(2_000);
      const asked = fetchSpy.mock.calls.length;
      await pass(10_000);
      expect(fetchSpy).toHaveBeenCalledTimes(asked);

      // Opened again after the run: the list is asked for and answered.
      fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(CATALOGUE)));
      const second = renderHook(() => useTdsControllers(), { wrapper: Wrapper });
      await pass(100);
      expect(second.result.current.data).toEqual(CATALOGUE);
      second.unmount();
    });

    it('does not take any other failure for a run', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ type: 'about:blank', title: 'Not found', status: 404, detail: 'x' }, 404),
        ),
      );
      const { Wrapper } = makeWrapper();
      const { result, unmount } = renderHook(() => useDaeVariables('', 10), { wrapper: Wrapper });

      await pass(8_000);
      expect(result.current.isError).toBe(true);
      expect(isWaitingForSession(result.current)).toBe(false);
      // Asked for once: a refusal that is not about the session being held stands.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  it('useDaeVariables stays disabled without a session or without a case', () => {
    const { Wrapper } = makeWrapper();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: { primaryPath: 'kundur_full.xlsx' as WorkspacePath, addfiles: [] },
    });
    const noSession = renderHook(() => useDaeVariables('', 10), { wrapper: Wrapper });
    expect(noSession.result.current.fetchStatus).toBe('idle');

    useSessionStore.setState({ sessionId: parseSessionId('sess-dae') });
    useCaseStore.setState({ selection: null });
    const noCase = renderHook(() => useDaeVariables('', 10), { wrapper: Wrapper });
    expect(noCase.result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useDaeVariables asks again for another case, and for other words', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-dae') });
    useCaseStore.setState({
      selection: { primaryPath: 'kundur_full.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ total: 0, items: [] })));
    const { Wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ q }) => useDaeVariables(q, 10), {
      wrapper: Wrapper,
      initialProps: { q: 'omega' },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: 'vf' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    act(() =>
      useCaseStore.setState({
        selection: { primaryPath: 'wscc9.xlsx' as WorkspacePath, addfiles: [] },
      }),
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });

  it('fetchResponseMetrics posts the series as JSON to a route that needs no session', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ results: [{ name: 'w', error: null }] }));

    const answer = await fetchResponseMetrics({
      series: [{ name: 'w', t: [0, 1, 2], y: [1, 1, 1] }],
      settling_band: 0.02,
      rocof_window: 0.5,
    });

    expect(answer.results[0]!.name).toBe('w');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/response-metrics');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ series: [{ name: 'w' }] });
  });

  it('fetchComtradeRecord posts the signals as JSON to a route that needs no session and returns the archive', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    );

    const archive = await fetchComtradeRecord({
      t: [0, 1],
      channels: [{ name: 'Bus_1_v', unit: 'pu', values: [1, 0.9] }],
      name: 'ieee14_1a2b3c4d',
      station: 'ieee14',
      frequency_hz: 60,
    });

    expect(archive).toBeInstanceOf(Blob);
    expect(archive.type).toBe('application/zip');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/comtrade');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({
      t: [0, 1],
      channels: [{ name: 'Bus_1_v', unit: 'pu', values: [1, 0.9] }],
      name: 'ieee14_1a2b3c4d',
    });
  });

  it('useRunPflow onMutate registers a pending placeholder; onSuccess re-keys to the server job_id', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        run_id: 'r1',
        converged: true,
        iterations: 3,
        mismatch: 1e-6,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
        job_id: 'srv-pf-1',
      }),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-7' as SessionId);

    // onMutate placeholder appears synchronously.
    await waitFor(() => {
      const ids = Object.keys(useJobsStore.getState().jobs);
      expect(ids.some((id) => id.startsWith(LOCAL_ID_PREFIX))).toBe(true);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    // The placeholder re-keyed onto the canonical server job_id.
    expect(jobs['srv-pf-1']).toBeDefined();
    expect(jobs['srv-pf-1']!.status).toBe('done');
    expect(jobs['srv-pf-1']!.isPlaceholder).toBeUndefined();
    expect(Object.keys(jobs).some((id) => id.startsWith(LOCAL_ID_PREFIX))).toBe(false);
  });

  it('useRunPflow onSuccess WITHOUT a job_id marks the placeholder done in place', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        run_id: 'r2',
        converged: true,
        iterations: 2,
        mismatch: 1e-7,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
        // No job_id field.
      }),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-8' as SessionId);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    const ids = Object.keys(jobs);
    // The temp record stays under its local id, marked done.
    expect(ids).toHaveLength(1);
    expect(ids[0]!.startsWith(LOCAL_ID_PREFIX)).toBe(true);
    expect(jobs[ids[0]!]!.status).toBe('done');
  });

  it('a 409 SessionBusy onError produces a failed JobRecord carrying the problem + recovery', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Session Busy',
          status: 409,
          detail: 'A routine is already running on this session.',
          recovery: { kind: 'retry', label: 'Retry' },
        },
        409,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-9' as SessionId);

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    const ids = Object.keys(jobs);
    // No canonical record exists (WS not connected in this test), so the
    // placeholder is marked failed in place, carrying the problem.
    expect(ids).toHaveLength(1);
    const rec = jobs[ids[0]!]!;
    expect(rec.status).toBe('failed');
    expect(rec.problem?.title).toBe('Session Busy');
    expect(rec.problem?.status).toBe(409);
    expect(rec.problem?.recovery).toEqual({ kind: 'retry', label: 'Retry' });
  });

  describe('useRunPflow keeps a converged result for comparison', () => {
    const TOPOLOGY = {
      state: 'pre-setup' as const,
      buses: [{ idx: 1, name: 'North', kind: 'Bus' }],
      lines: [{ idx: 'L1', name: 'North-South', kind: 'Line' }],
      transformers: [{ idx: 'T1', name: 'Step-up', kind: 'Line' }],
      generators: [
        { idx: 'G1', name: 'Hydro', kind: 'Slack' },
        { idx: 'M1', name: 'Hydro machine', kind: 'GENROU' },
      ],
      loads: [{ idx: 'D1', name: 'Town', kind: 'PQ' }],
    };
    const solved = (overrides: Record<string, unknown> = {}) => ({
      run_id: 'pf-1',
      converged: true,
      iterations: 3,
      mismatch: 1e-6,
      bus_voltages: { '1': 1.02 },
      bus_angles: { '1': 0 },
      line_flows: {},
      ...overrides,
    });

    beforeEach(() => usePflowHistoryStore.getState().clear());
    afterEach(() => usePflowHistoryStore.getState().clear());

    it('with the case it was solved on and the names of its elements', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(solved()));
      const { client, Wrapper } = makeWrapper();
      const sessionId = 'sess-keep' as SessionId;
      client.setQueryData(queryKeys.topology(sessionId), TOPOLOGY);
      useCaseStore.setState({
        selection: { primaryPath: 'cases/kundur_full.xlsx' as WorkspacePath, addfiles: [] },
      });
      const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });

      result.current.mutate(sessionId);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const [snapshot] = usePflowHistoryStore.getState().snapshots;
      expect(snapshot).toMatchObject({ id: 'pf-1', ordinal: 1, caseName: 'kundur_full' });
      expect(snapshot?.result.bus_voltages).toEqual({ '1': 1.02 });
      expect(snapshot?.names).toEqual({
        buses: { '1': 'North' },
        lines: { L1: 'North-South', T1: 'Step-up' },
        generators: { G1: 'Hydro' },
        loads: { D1: 'Town' },
      });
    });

    it('under "New system" for a system built from scratch', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(solved()));
      useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });

      result.current.mutate('sess-keep' as SessionId);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(usePflowHistoryStore.getState().snapshots[0]?.caseName).toBe('New system');
    });

    it('and keeps none for a run that did not converge', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(solved({ converged: false, iterations: 26 })));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });

      result.current.mutate('sess-keep' as SessionId);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(usePflowHistoryStore.getState().snapshots).toEqual([]);
    });
  });

  it('useRunPflow sends the options store as the request body, only what was changed', async () => {
    const pfResult = {
      run_id: 'r1',
      converged: true,
      iterations: 3,
      mismatch: 1e-6,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(pfResult));
    fetchSpy.mockResolvedValueOnce(jsonResponse(pfResult));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });

    // Nothing set: an empty body, so the case keeps its own settings.
    usePflowOptionsStore.getState().resetOptions();
    result.current.mutate('sess-9' as SessionId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [, plain] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(plain.body))).toEqual({});

    usePflowOptionsStore
      .getState()
      .setOptions({ tolerance: 1e-8, maxIterations: 60, flatStart: true, enforceQLimits: true });
    result.current.mutate('sess-9' as SessionId);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [url, tuned] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/sess-9\/pflow$/);
    expect(JSON.parse(String(tuned.body))).toEqual({
      tolerance: 1e-8,
      max_iterations: 60,
      flat_start: true,
      enforce_q_limits: true,
    });
    usePflowOptionsStore.getState().resetOptions();
  });

  describe('the CPF runs', () => {
    const cpfResult = {
      lambdas: [0, 0.5],
      voltages_per_bus: { '1': [1, 0.9] },
      bus_idxes: ['1'],
      nose_idx: 1,
      max_lam: 0.5,
      truncated: false,
      done_msg: 'Nose point at lambda=0.500000',
      mode: 'pv',
    };

    function sentBody(call: number): { url: string; body: unknown } {
      const [url, init] = fetchSpy.mock.calls[call] as [string, RequestInit];
      return { url, body: JSON.parse(String(init.body)) };
    }

    afterEach(() => {
      usePflowOptionsStore.getState().resetOptions();
    });

    it('useCpfRun sends the default direction alone when nothing was set', async () => {
      usePflowOptionsStore.getState().resetOptions();
      fetchSpy.mockResolvedValueOnce(jsonResponse(cpfResult));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useCpfRun(), { wrapper: Wrapper });

      result.current.mutate({ sessionId: 'sess-9' as SessionId });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const { url, body } = sentBody(0);
      expect(url).toMatch(/\/sessions\/sess-9\/cpf$/);
      expect(body).toEqual({ direction: 'load' });
    });

    it('useCpfRun sends a custom direction, the full curve and the solver settings', async () => {
      usePflowOptionsStore.getState().resetOptions();
      fetchSpy.mockResolvedValueOnce(jsonResponse(cpfResult));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useCpfRun(), { wrapper: Wrapper });

      result.current.mutate({
        sessionId: 'sess-9' as SessionId,
        direction: 'custom',
        loadIncrease: [{ idx: 'PQ_1', p: 10, q: 3 }],
        generatorIncrease: [{ idx: '2', p: 10 }],
        stopAt: 'full',
        step: 0.05,
        maxIter: 800,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(sentBody(0).body).toEqual({
        direction: 'custom',
        load_increase: [{ idx: 'PQ_1', p: 10, q: 3 }],
        generator_increase: [{ idx: '2', p: 10 }],
        stop_at: 'full',
        step: 0.05,
        max_iter: 800,
      });
    });

    it('useCpfRun takes the Q-limit switch of the power-flow options, read when the run starts', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(cpfResult));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useCpfRun(), { wrapper: Wrapper });

      usePflowOptionsStore.getState().setOptions({ enforceQLimits: true });
      result.current.mutate({ sessionId: 'sess-9' as SessionId, direction: 'load-only' });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(sentBody(0).body).toEqual({ direction: 'load-only', enforce_q_limits: true });

      // Unticked is sent too: a case that turns limits on can be run without.
      usePflowOptionsStore.getState().setOptions({ enforceQLimits: false });
      result.current.mutate({ sessionId: 'sess-9' as SessionId });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      expect(sentBody(1).body).toEqual({ direction: 'load', enforce_q_limits: false });

      // A caller that says which it wants is not overruled by the store.
      result.current.mutate({ sessionId: 'sess-9' as SessionId, enforceQLimits: null });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
      expect(sentBody(2).body).toEqual({ direction: 'load' });
    });

    it('useCpfQvRun sends the bus, and the same switch', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ ...cpfResult, mode: 'qv' }));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useCpfQvRun(), { wrapper: Wrapper });

      usePflowOptionsStore.getState().resetOptions();
      result.current.mutate({ sessionId: 'sess-9' as SessionId, busIdx: '5' });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(sentBody(0).url).toMatch(/\/sessions\/sess-9\/cpf\/qv$/);
      expect(sentBody(0).body).toEqual({ bus_idx: '5' });

      usePflowOptionsStore.getState().setOptions({ enforceQLimits: true });
      result.current.mutate({ sessionId: 'sess-9' as SessionId, busIdx: '5', qRange: 2 });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      expect(sentBody(1).body).toEqual({ bus_idx: '5', q_range: 2, enforce_q_limits: true });
    });
  });

  it('useRunPflow learns what the case itself sets from a run that left a switch alone', async () => {
    const ran = (settings: Record<string, unknown>) => ({
      run_id: 'r1',
      converged: true,
      iterations: 3,
      mismatch: 1e-6,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
      settings,
    });
    const caseOn = {
      tolerance: 1e-6,
      max_iterations: 25,
      flat_start: false,
      enforce_q_limits: true,
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(ran(caseOn)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(ran({ ...caseOn, enforce_q_limits: false })));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    usePflowOptionsStore.getState().resetForNewCase();

    // Left alone, the run shows both: the case turns Q limits on and starts from its
    // own voltages.
    result.current.mutate('sess-9' as SessionId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(usePflowOptionsStore.getState().caseSettings).toEqual({
      flatStart: false,
      enforceQLimits: true,
    });

    // A run that sets Q limits off says nothing about what the case sets.
    usePflowOptionsStore.getState().setOptions({ enforceQLimits: false });
    result.current.mutate('sess-9' as SessionId);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(usePflowOptionsStore.getState().caseSettings.enforceQLimits).toBe(true);
    usePflowOptionsStore.getState().resetForNewCase();
  });

  it('useRunPflow invalidates the topology cache', async () => {
    const pfResult = {
      run_id: 'r1',
      converged: true,
      iterations: 3,
      mismatch: 1e-6,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(pfResult));

    const { client, Wrapper } = makeWrapper();
    const sessionId = 'sess-2' as SessionId;
    // Seed a topology cache value.
    client.setQueryData(queryKeys.topology(sessionId), {
      state: 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    });

    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate(sessionId);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.topology(sessionId) });
  });

  it('a 422 case-load leaves NO in-flight record (placeholder cleared, none stranded)', async () => {
    // STUCK-PILL FIX: a failed case-load must not leave any record in a
    // pending/running state that would spin the InFlightChip pill forever.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Failed to parse case file.',
        },
        422,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    result.current.mutate({
      sessionId: 'sess-422' as SessionId,
      request: { primary_path: 'bad.xlsx' },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = Object.values(useJobsStore.getState().jobs);
    // No record may remain in-flight — every record is terminal (here: the
    // single placeholder, marked failed in place).
    expect(jobs.every((j) => isTerminalStatus(j.status))).toBe(true);
    expect(jobs.some((j) => j.status === 'failed')).toBe(true);
  });

  it('failJob drives a stranded canonical running case-load record to failed (instant pill clear)', async () => {
    // Simulate the WS having registered the canonical ``srv-load`` record
    // (running) for this case-load before the HTTP 422 unwinds. The error
    // carries no job_id, so failJob must drive that stranded canonical record
    // to ``failed`` immediately — clearing the pill without a terminal WS event.
    useJobsStore.getState().upsertJob({
      job_id: 'srv-load',
      kind: 'case-load',
      status: 'running',
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'parse error' },
        422,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    result.current.mutate({
      sessionId: 'sess-x' as SessionId,
      request: { primary_path: 'bad.xlsx' },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    // The stranded canonical record is now terminal — the pill clears.
    expect(jobs['srv-load']!.status).toBe('failed');
    expect(Object.values(jobs).every((j) => isTerminalStatus(j.status))).toBe(true);
  });

  it('useTopology stays disabled when selection is null even with a sessionId', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-gate') });
    useCaseStore.setState({ selection: null });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTopology(parseSessionId('sess-gate')), {
      wrapper: Wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useTopology fires once a case is loaded (selection set)', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-loaded') });
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        state: 'pre-setup',
        buses: [],
        lines: [],
        transformers: [],
        generators: [],
        loads: [],
      }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTopology(parseSessionId('sess-loaded')), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('the landing-state list queries stay disabled when selection is null (no 409 noise)', () => {
    // useListSnapshots / useListPmus / useListProfiles must NOT fire on a
    // fresh session with no case loaded — each would 409 and spam the console.
    useSessionStore.setState({ sessionId: parseSessionId('sess-landing') });
    useCaseStore.setState({ selection: null });
    const { Wrapper } = makeWrapper();

    const snap = renderHook(() => useListSnapshots(), { wrapper: Wrapper });
    const pmus = renderHook(() => useListPmus(), { wrapper: Wrapper });
    const profiles = renderHook(() => useListProfiles(), { wrapper: Wrapper });

    expect(snap.result.current.fetchStatus).toBe('idle');
    expect(pmus.result.current.fetchStatus).toBe('idle');
    expect(profiles.result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useUploadWorkspaceFile', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const stored = {
    name: 'ieee14.raw',
    size_bytes: 11,
    modified_iso: '2026-10-04T00:00:00+00:00',
    format: 'raw',
    replaced: false,
  };

  it('posts the file itself under its name, and refreshes the workspace listing', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(stored, 201));
    const { client, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUploadWorkspaceFile(), { wrapper: Wrapper });

    const file = new File(['case data\n'], 'My Case.raw');
    let reply: unknown;
    await act(async () => {
      reply = await result.current.mutateAsync({ file });
    });

    expect(reply).toEqual(stored);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/workspace/files?name=My+Case.raw&overwrite=false');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workspaceFiles });
  });

  it('asks to replace a file of the same name only when told to', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ...stored, replaced: true }, 201));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUploadWorkspaceFile(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ file: new File(['x'], 'a.raw'), overwrite: true });
    });
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toBe('/api/workspace/files?name=a.raw&overwrite=true');
  });

  it('leaves the listing alone and surfaces the problem when the server refuses', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Conflict', status: 409, detail: "'a.raw' already exists" },
        409,
      ),
    );
    const { client, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUploadWorkspaceFile(), { wrapper: Wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ file: new File(['x'], 'a.raw') }),
      ).rejects.toMatchObject({ status: 409, detail: "'a.raw' already exists" });
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
