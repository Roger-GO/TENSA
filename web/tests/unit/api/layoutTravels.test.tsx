/**
 * The diagram's layout goes with a snapshot and comes back with a bundle.
 *
 * The hooks that save take the layout of the diagram as it is drawn
 * (`diagramLayout` in the case store) and the hooks that bring a system back
 * redraw from the layout that came with it. `fetch` is stubbed; what is asserted
 * is the request each hook sends and what the canvas would then read. The write
 * a drag asks for is here too, for the one case the canvas tests cannot show with
 * a stand-in for the mutation: sent while the canvas unmounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, type ReactNode } from 'react';

import {
  makeQueryClient,
  queryKeys,
  useImportBundle,
  usePutSidecar,
  useRestoreSnapshot,
  useSaveSnapshot,
} from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SidecarLayout } from '@/api/types';
import {
  __clearAllPendingForTests,
  buildSidecarLayout,
  debouncedPutSidecar,
  flushPendingSidecarPut,
} from '@/components/sld/sidecar';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useJobsStore } from '@/store/jobs';
import { useSessionStore } from '@/store/session';

const SESSION = parseSessionId('sess-layout');
const CASE = parseWorkspacePath('ieee14.raw');

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

/** The layout a snapshot or bundle carries: everything somewhere else than it is now. */
function carried(): SidecarLayout {
  return buildSidecarLayout(
    { '1': { x: 500, y: 40 }, '2': { x: 700, y: 40 } },
    { nonBusCoords: { load: { PQ_1: { x: 500, y: 110 } }, PQ: { PQ_1: { x: 500, y: 110 } } } },
  );
}

const METADATA = {
  andes_version: '2.0.0',
  tensa_version: '0.5.0',
  case_filename: 'ieee14.raw',
  case_sha256: null,
  disturbance_log: [],
  saved_at: 'now',
  has_pflow: true,
  has_tds: false,
};

function restoreResponse(layout: SidecarLayout | null): Response {
  return jsonResponse({
    used_dill: false,
    fallback_reason: null,
    disturbances_replayed: 0,
    metadata: { ...METADATA, has_layout: layout !== null },
    layout,
  });
}

describe('the layout travels with what is saved', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: SESSION });
    useCaseStore.setState({
      selection: { primaryPath: CASE, addfiles: [] },
      dragOverrides: {},
      connectorStyle: null,
      unitExpansion: {},
      diagramLayout: null,
    });
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __clearAllPendingForTests();
    useCaseStore.setState({
      selection: null,
      dragOverrides: {},
      connectorStyle: null,
      unitExpansion: {},
      diagramLayout: null,
    });
  });

  describe('a drag', () => {
    it('whose write is sent as the canvas unmounts still reaches the file and the cache', async () => {
      // The canvas sends a write that is still waiting from an effect cleanup,
      // when the component that owns the mutation is on its way out as well.
      // The request has to go out all the same, and the cached layout, which
      // the canvas reads when it comes back, has to follow.
      const layout = buildSidecarLayout({ '1': { x: 9, y: 9 } });
      function Inner({ put }: { put: (drawn: SidecarLayout) => void }) {
        useEffect(() => {
          debouncedPutSidecar(CASE, layout, put);
          return () => flushPendingSidecarPut(CASE);
        }, [put]);
        return null;
      }
      function Canvas() {
        const { mutate } = usePutSidecar();
        const put = useCallback(
          (drawn: SidecarLayout) => mutate({ casePath: CASE, layout: drawn }),
          [mutate],
        );
        return <Inner put={put} />;
      }
      fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
      const { client, Wrapper } = makeWrapper();
      const view = render(<Canvas />, { wrapper: Wrapper });
      expect(fetchSpy).not.toHaveBeenCalled();

      view.unmount();

      await waitFor(() => expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(layout));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('/workspace/layout?case_path=ieee14.raw');
      expect((init as RequestInit).method).toBe('PUT');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual(layout);
    });
  });

  describe('a snapshot', () => {
    it('is saved with the diagram as it is drawn', async () => {
      const drawn = buildSidecarLayout({ '1': { x: 10, y: 20 }, '2': { x: 210, y: 20 } });
      useCaseStore.setState({ diagramLayout: drawn });
      fetchSpy.mockResolvedValue(
        jsonResponse({ name: 'a', metadata: METADATA, dill_bytes: 0, metadata_bytes: 1 }),
      );
      const { Wrapper } = makeWrapper();
      const save = renderHook(() => useSaveSnapshot(), { wrapper: Wrapper });

      await save.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
      expect(body.name).toBe('a');
      expect({ ...body.layout, last_modified: drawn.last_modified }).toEqual(drawn);
    });

    it('is saved without a layout field when no diagram has been drawn', async () => {
      // The server then keeps the layout saved beside the case file.
      fetchSpy.mockResolvedValue(
        jsonResponse({ name: 'a', metadata: METADATA, dill_bytes: 0, metadata_bytes: 1 }),
      );
      const { Wrapper } = makeWrapper();
      const save = renderHook(() => useSaveSnapshot(), { wrapper: Wrapper });

      await save.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
      expect(body).toEqual({ name: 'a', force: false, include_dill: false });
    });

    it('restored into an opened case redraws the diagram from its layout', async () => {
      const layout = carried();
      const { client, Wrapper } = makeWrapper();
      // What the canvas was drawn from, and where things were dragged since.
      client.setQueryData(queryKeys.sidecar(CASE), buildSidecarLayout({ '1': { x: 1, y: 1 } }));
      useCaseStore.setState({ dragOverrides: { '1': { x: 9, y: 9 }, '2': { x: 8, y: 8 } } });
      fetchSpy.mockResolvedValue(restoreResponse(layout));
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      // The canvas reads the saved layout from this cache entry.
      expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(layout);
      // And the drags of before the restore would sit on top of it.
      expect(useCaseStore.getState().dragOverrides).toEqual({});
    });

    it('restored drops a layout write of before the restore that was still waiting', async () => {
      vi.useFakeTimers();
      const put = vi.fn();
      debouncedPutSidecar(CASE, buildSidecarLayout({ '1': { x: 9, y: 9 } }), put);
      fetchSpy.mockResolvedValue(restoreResponse(carried()));
      const { Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });
      vi.advanceTimersByTime(2000);

      // Sent after the restore, it would have put the old placement back on disk.
      expect(put).not.toHaveBeenCalled();
    });

    it('restored into a system built from scratch applies its positions as drags', async () => {
      // No case file, so no layout file to redraw from.
      useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
      fetchSpy.mockResolvedValue(restoreResponse(carried()));
      const { Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      expect(useCaseStore.getState().dragOverrides).toEqual({
        '1': { x: 500, y: 40 },
        '2': { x: 700, y: 40 },
        'load-PQ_1': { x: 500, y: 110 },
      });
    });

    it('restored into an opened case lets the connector style of its layout show', async () => {
      // A style chosen in this visit sits on top of the saved layout's, as
      // the drags do, and would hide the one the snapshot was saved with.
      const layout = { ...carried(), figure: { connector_style: 'elbow' } };
      useCaseStore.setState({ connectorStyle: 'straight' });
      fetchSpy.mockResolvedValue(restoreResponse(layout));
      const { client, Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      expect(useCaseStore.getState().connectorStyle).toBeNull();
      expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(layout);
    });

    it('restored into a system built from scratch applies its connector style as the one chosen', async () => {
      useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
      fetchSpy.mockResolvedValue(
        restoreResponse({ ...carried(), figure: { connector_style: 'elbow' } }),
      );
      const { Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      expect(useCaseStore.getState().connectorStyle).toBe('elbow');
    });

    it('restored into an opened case lets the control chains its layout draws out show', async () => {
      // A chain folded away in this visit sits on top of the saved layout's,
      // as the drags do, and would hide what the snapshot was saved with.
      const layout = { ...carried(), units: { '1': { expanded: true, bus: '1' } } };
      useCaseStore.setState({ unitExpansion: { '1': false, '2': true } });
      fetchSpy.mockResolvedValue(restoreResponse(layout));
      const { client, Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      expect(useCaseStore.getState().unitExpansion).toEqual({});
      expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(layout);
    });

    it('restored into a system built from scratch draws out the control chains its layout draws out', async () => {
      useCaseStore.setState({
        selection: { primaryPath: null, addfiles: [], blank: true },
        unitExpansion: { '2': true },
      });
      fetchSpy.mockResolvedValue(
        restoreResponse({
          ...carried(),
          units: { '1': { expanded: true, bus: '1' }, '3': { expanded: false } },
        }),
      );
      const { Wrapper } = makeWrapper();
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      // What the snapshot has, and nothing of what was chosen before it.
      expect(useCaseStore.getState().unitExpansion).toEqual({ '1': true, '3': false });
    });

    describe('that rearranges the diagram on screen', () => {
      /** The diagram as the user had arranged it since the snapshot was saved. */
      const arranged = () => buildSidecarLayout({ '1': { x: 9, y: 9 }, '2': { x: 300, y: 9 } });
      const dragged = { '1': { x: 9, y: 9 }, '2': { x: 300, y: 9 } };

      /** Restore, and hand back the action of the toast that reports the change. */
      async function restoreAndGetOffer(wrapper: ReturnType<typeof makeWrapper>['Wrapper']) {
        const info = vi.spyOn(toast, 'info').mockReturnValue('id');
        const restore = renderHook(() => useRestoreSnapshot(), { wrapper });
        await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });
        return info;
      }

      it('says so, and offers to keep the arrangement the diagram had', async () => {
        const drawnBefore = arranged();
        useCaseStore.setState({ diagramLayout: drawnBefore, dragOverrides: dragged });
        const { client, Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);

        expect(info).toHaveBeenCalledTimes(1);
        const [message, opts] = info.mock.calls[0]!;
        expect(message).toMatch(/placed as it was when the snapshot was saved/);
        expect(opts?.action?.label).toBe('Keep my layout');

        // Taking the offer: the earlier arrangement is drawn again and written
        // back beside the case, which the restore had overwritten.
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
        opts!.action!.onClick();
        expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(drawnBefore);
        expect(useCaseStore.getState().dragOverrides).toEqual(dragged);
        const [url, init] = fetchSpy.mock.calls[1]!;
        expect(String(url)).toContain('/workspace/layout?case_path=ieee14.raw');
        expect((init as RequestInit).method).toBe('PUT');
        expect(JSON.parse(String((init as RequestInit).body))).toEqual(drawnBefore);
      });

      it('says nothing when the snapshot has the diagram as it is drawn', async () => {
        // Saved a moment ago and restored: same placement, a later timestamp.
        const snapshotLayout = carried();
        useCaseStore.setState({
          diagramLayout: { ...snapshotLayout, last_modified: '2027-01-01T00:00:00Z' },
        });
        const { Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(snapshotLayout));
        const info = await restoreAndGetOffer(Wrapper);

        expect(info).not.toHaveBeenCalled();
      });

      it('keeps the arrangement of a system built from scratch without writing a file', async () => {
        useCaseStore.setState({
          selection: { primaryPath: null, addfiles: [], blank: true },
          diagramLayout: arranged(),
          dragOverrides: dragged,
        });
        const { Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);
        expect(useCaseStore.getState().dragOverrides['1']).toEqual({ x: 500, y: 40 });

        info.mock.calls[0]![1]!.action!.onClick();

        expect(useCaseStore.getState().dragOverrides).toEqual(dragged);
        expect(fetchSpy).toHaveBeenCalledTimes(1); // the restore itself, nothing since
      });

      it('gives back the connector style that was chosen with the arrangement', async () => {
        const drawnBefore = { ...arranged(), figure: { connector_style: 'elbow' } };
        useCaseStore.setState({
          diagramLayout: drawnBefore,
          dragOverrides: dragged,
          connectorStyle: 'elbow',
        });
        const { Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);
        // The snapshot's layout names no style: its connectors are straight.
        expect(useCaseStore.getState().connectorStyle).toBeNull();

        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
        info.mock.calls[0]![1]!.action!.onClick();

        expect(useCaseStore.getState().connectorStyle).toBe('elbow');
        expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)).figure).toEqual(
          {
            connector_style: 'elbow',
          },
        );
      });

      it('gives back the control chains that were drawn out with the arrangement', async () => {
        const drawnBefore = { ...arranged(), units: { '1': { expanded: true, bus: '1' } } };
        useCaseStore.setState({
          diagramLayout: drawnBefore,
          dragOverrides: dragged,
          unitExpansion: { '1': true },
        });
        const { Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);
        expect(useCaseStore.getState().unitExpansion).toEqual({});

        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
        info.mock.calls[0]![1]!.action!.onClick();

        expect(useCaseStore.getState().unitExpansion).toEqual({ '1': true });
        expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)).units).toEqual({
          '1': { expanded: true, bus: '1' },
        });
      });

      it('taken up after another case was opened, leaves that case alone', async () => {
        const drawnBefore = arranged();
        useCaseStore.setState({ diagramLayout: drawnBefore, dragOverrides: dragged });
        const { client, Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);

        const other = parseWorkspacePath('kundur.xlsx');
        useCaseStore.getState().setCase({ primaryPath: other, addfiles: [] });
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
        info.mock.calls[0]![1]!.action!.onClick();

        // The case now open keeps its (no) drags and its own layout.
        expect(useCaseStore.getState().dragOverrides).toEqual({});
        expect(client.getQueryData(queryKeys.sidecar(other))).toBeUndefined();
        // The file of the case the restore was made in still gets its layout back.
        expect(String(fetchSpy.mock.calls[1]![0])).toContain('case_path=ieee14.raw');
        expect(client.getQueryData(queryKeys.sidecar(CASE))).toEqual(drawnBefore);
      });

      it('reports a layout that could not be written back', async () => {
        useCaseStore.setState({ diagramLayout: arranged(), dragOverrides: dragged });
        const { Wrapper } = makeWrapper();
        fetchSpy.mockResolvedValueOnce(restoreResponse(carried()));
        const info = await restoreAndGetOffer(Wrapper);
        const failure = vi.spyOn(toast, 'error').mockReturnValue('id');

        fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        info.mock.calls[0]![1]!.action!.onClick();

        await waitFor(() =>
          expect(failure).toHaveBeenCalledWith(
            'Could not save the earlier layout back',
            expect.anything(),
          ),
        );
      });
    });

    it('with no layout leaves the diagram as it is placed now', async () => {
      // A snapshot saved by an earlier release.
      const { client, Wrapper } = makeWrapper();
      const current = buildSidecarLayout({ '1': { x: 1, y: 1 } });
      client.setQueryData(queryKeys.sidecar(CASE), current);
      useCaseStore.setState({ dragOverrides: { '1': { x: 9, y: 9 } } });
      fetchSpy.mockResolvedValue(restoreResponse(null));
      const restore = renderHook(() => useRestoreSnapshot(), { wrapper: Wrapper });

      await restore.result.current.mutateAsync({ sessionId: SESSION, name: 'a' });

      expect(client.getQueryData(queryKeys.sidecar(CASE))).toBe(current);
      expect(useCaseStore.getState().dragOverrides).toEqual({ '1': { x: 9, y: 9 } });
    });
  });

  describe('a bundle', () => {
    const committed = {
      status: 'committed',
      plan: { manifest: {}, case_files: ['ieee14.raw'], conflicts: [], blocked: false },
      warnings: [],
      case_filename: 'ieee14.raw',
      addfile_filenames: [],
      disturbances_replayed: 0,
      layout_restored: true,
    };

    it('imported makes the layout it brought the one the diagram is read from', async () => {
      // The case was open here before, so a copy of its old layout is cached.
      const { client, Wrapper } = makeWrapper();
      client.setQueryData(queryKeys.sidecar(CASE), buildSidecarLayout({ '1': { x: 1, y: 1 } }));
      fetchSpy.mockResolvedValue(jsonResponse(committed));
      const importBundle = renderHook(() => useImportBundle(), { wrapper: Wrapper });

      await importBundle.result.current.mutateAsync({
        sessionId: SESSION,
        file: new File(['zip'], 'bundle.zip'),
      });

      expect(client.getQueryState(queryKeys.sidecar(CASE))?.isInvalidated).toBe(true);
    });

    it('that only reports conflicts leaves the cached layout alone', async () => {
      const { client, Wrapper } = makeWrapper();
      client.setQueryData(queryKeys.sidecar(CASE), buildSidecarLayout({ '1': { x: 1, y: 1 } }));
      fetchSpy.mockResolvedValue(
        jsonResponse({ detail: { ...committed, status: 'plan', layout_restored: false } }, 409),
      );
      const importBundle = renderHook(() => useImportBundle(), { wrapper: Wrapper });

      await importBundle.result.current.mutateAsync({
        sessionId: SESSION,
        file: new File(['zip'], 'bundle.zip'),
      });

      expect(client.getQueryState(queryKeys.sidecar(CASE))?.isInvalidated).toBe(false);
    });
  });
});
