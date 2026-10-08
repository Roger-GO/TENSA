/**
 * DraftInspector: the Inspector of a draft, an element that was placed on
 * the diagram and is not in the system yet. It is the form of the draft's
 * kind, checked as it is typed, with every field that is set kept with the
 * draft at once. Add to system is the first the server hears of the draft:
 * when it is taken the draft goes, the element stands where the draft stood
 * and is selected in its place; what the server refuses leaves the draft as
 * it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { DRAFT_NODE_SIZE } from '@/components/sld/drafts';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useDraftsStore, type DraftElement } from '@/store/drafts';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';
import { IEEE14 } from '../../helpers/exampleCases';
import { TOPOLOGY_SCHEMA } from '../../helpers/topologySchema';

const postSpy = vi.fn();
let postResult: () => Promise<unknown> = () => Promise.resolve({ element: {} });

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: () => Promise.resolve({}),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return postResult();
      },
      put: vi.fn(),
    },
  };
});

let mockTopology: TopologySummary | null = IEEE14;
const resetSpy = vi.fn();
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTopologySchema: () => ({ data: TOPOLOGY_SCHEMA, isLoading: false, isError: false }),
    useCurrentTopology: () => mockTopology,
  };
});
vi.mock('@/lib/useResetRunAction', () => ({
  useResetRunAction: () => ({ reset: resetSpy, isPending: false }),
}));

import { DraftInspector } from '@/components/inspector/DraftInspector';

const CASE = 'ieee14.raw';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** Place `drafts` on the case and draw the Inspector of the one with `id`, as the store has it. */
function renderDraft(
  drafts: DraftElement[] = [{ id: 'draft-1', kind: 'PV', position: { x: 40, y: 60 }, values: {} }],
  id = 'draft-1',
) {
  useDraftsStore.setState({ byCase: { [CASE]: drafts }, placements: {} });
  useSldStore.getState().setSelectedNodeId(id, 'diagram');
  function Shown() {
    const draft = useDraftsStore((s) => (s.byCase[CASE] ?? []).find((d) => d.id === id));
    return draft === undefined ? (
      <p data-testid="gone">gone</p>
    ) : (
      <DraftInspector draft={draft} caseKey={CASE} />
    );
  }
  return render(withQueryClient(<Shown />));
}

const held = () => useDraftsStore.getState().byCase[CASE]?.[0]?.values;

beforeEach(() => {
  postSpy.mockClear();
  resetSpy.mockClear();
  postResult = () => Promise.resolve({ element: {} });
  mockTopology = IEEE14;
  useSessionStore.setState({ sessionId: parseSessionId('s-1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath(CASE), addfiles: [] },
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useDraftsStore.setState({ byCase: {}, placements: {} });
  useSldStore.getState().clearSelectedNodeId();
  useCaseStore.setState({ selection: null, selectedElement: null });
});

describe('<DraftInspector />', () => {
  it('says that it is a draft, what it is, and what it still lacks', () => {
    renderDraft();
    const header = screen.getByTestId('draft-inspector-header');
    expect(header).toHaveTextContent('Draft');
    expect(header).toHaveTextContent('PV generator 6');
    expect(screen.getByTestId('draft-inspector-status')).toHaveTextContent('Incomplete');
    expect(screen.getByTestId('draft-inspector-note')).toHaveTextContent(
      'A draft is on the diagram but not in the system',
    );
    expect(screen.getByTestId('draft-inspector-summary')).toHaveTextContent(
      'Missing bus, Sn, Vn, p0 and v0.',
    );
    // The form marks each of them, and its button is off until they are given.
    expect(screen.getByTestId('field-error-bus')).toHaveTextContent('Required');
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeDisabled();
  });

  it('keeps every field with the draft as it is set', async () => {
    const user = userEvent.setup();
    renderDraft();
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '4');
    expect(held()).toEqual({ bus: '4' });
    await user.type(screen.getByTestId('field-Sn').querySelector('input')!, '100');
    expect(held()).toEqual({ bus: '4', Sn: '100' });
    expect(screen.getByTestId('draft-inspector-summary')).toHaveTextContent(
      'Missing Vn, p0 and v0.',
    );
  });

  it('shows the bus the diagram gave the draft while its form is open, with what was typed kept', async () => {
    const user = userEvent.setup();
    renderDraft();
    await user.type(screen.getByTestId('field-Sn').querySelector('input')!, '100');
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('');
    // The draft was dropped on bus 9, or the end of its connector dragged there.
    act(() => useDraftsStore.getState().connect(CASE, 'draft-1', { bus: '9' }));
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('9');
    expect(screen.getByTestId('field-Sn').querySelector('input')).toHaveValue(100);
    expect(screen.getByTestId('draft-inspector-summary')).toHaveTextContent(
      'Missing Vn, p0 and v0.',
    );
    // And what the form sets next goes on top of it, not of what it opened with.
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '69');
    expect(held()).toEqual({ Sn: '100', bus: '9', Vn: '69' });
  });

  it('opens on what the draft was given before, and says Ready once nothing is missing', () => {
    renderDraft([
      {
        id: 'draft-1',
        kind: 'PV',
        position: { x: 40, y: 60 },
        values: { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' },
      },
    ]);
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('4');
    expect(screen.getByTestId('draft-inspector-status')).toHaveTextContent('Ready');
    expect(screen.getByTestId('draft-inspector-summary')).toHaveTextContent(
      'Ready: press Add to system.',
    );
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeEnabled();
  });

  it('adds the draft to the system: the element takes its place and is selected, and the draft goes', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    renderDraft([
      {
        id: 'draft-1',
        kind: 'PV',
        position: { x: 40, y: 60 },
        values: { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' },
      },
    ]);
    // Nothing was sent for a draft that was only placed and filled in.
    expect(postSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add to system' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]?.[1]).toEqual({
      model: 'PV',
      params: { idx: '6', name: '6', bus: '4', Sn: 100, Vn: 69, p0: 0.4, v0: 1.02 },
    });
    await waitFor(() => expect(screen.getByTestId('gone')).toBeInTheDocument());
    expect(useDraftsStore.getState().byCase[CASE]).toBeUndefined();
    // The middle of the draft's box is where the generator comes to stand.
    expect(useDraftsStore.getState().placements).toEqual({
      'generator-6': { x: 40 + DRAFT_NODE_SIZE.width / 2, y: 60 + DRAFT_NODE_SIZE.height / 2 },
    });
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '6',
      modelClass: 'PV',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-6');
    expect(success).toHaveBeenCalledWith(
      'Added to the system: PV generator 6',
      expect.objectContaining({ description: expect.stringContaining('Undo') }),
    );
  });

  it('sends what the kind itself sets with the add: a transformer keeps its tap', async () => {
    const user = userEvent.setup();
    renderDraft([
      {
        id: 'draft-1',
        kind: 'Transformer2W',
        position: { x: 0, y: 0 },
        values: { name: 'T9', bus1: '1', bus2: '2', r: '0', x: '0.1' },
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Add to system' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      model: 'Line',
      params: { tap: 1.05, bus1: '1', bus2: '2' },
    });
    // A line is drawn between its buses: there is no place to hand on.
    await waitFor(() => expect(screen.getByTestId('gone')).toBeInTheDocument());
    expect(useDraftsStore.getState().placements).toEqual({});
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'transformer',
      idx: 'Line_21',
    });
  });

  it('keeps the draft as it is when the server refuses it, and says what the server said', async () => {
    const user = userEvent.setup();
    postResult = () =>
      Promise.reject(
        new ProblemDetailsError({
          type: 'about:blank',
          status: 422,
          title: 'Unprocessable',
          detail: 'Vn must be positive',
        }),
      );
    renderDraft([
      {
        id: 'draft-1',
        kind: 'PV',
        position: { x: 40, y: 60 },
        values: { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' },
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Add to system' }));
    expect(await screen.findByTestId('form-server-error')).toHaveTextContent('Vn must be positive');
    expect(useDraftsStore.getState().byCase[CASE]).toHaveLength(1);
    expect(useDraftsStore.getState().placements).toEqual({});
    // An edit takes the refusal away: the form no longer holds what was refused.
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '0');
    expect(screen.queryByTestId('form-server-error')).toBeNull();
  });

  it('cannot be added while a run has locked the system, says why, and offers the reset', async () => {
    const user = userEvent.setup();
    mockTopology = { ...IEEE14, state: 'committed' };
    renderDraft([
      {
        id: 'draft-1',
        kind: 'PV',
        position: { x: 40, y: 60 },
        values: { bus: '4', Sn: '100', Vn: '69', p0: '0.4', v0: '1.02' },
      },
    ]);
    expect(screen.getByTestId('form-blocked')).toHaveTextContent(
      'A run has set the system up, which locks its elements. Reset the run to add this draft; it is kept meanwhile.',
    );
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeDisabled();
    await user.click(screen.getByTestId('draft-inspector-reset-run'));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('waits for a power flow that is running, and for the session', () => {
    usePflowStore.setState({ isRunning: true });
    const { unmount } = renderDraft();
    expect(screen.getByTestId('form-blocked')).toHaveTextContent(
      'Wait for the power flow to finish.',
    );
    unmount();
    usePflowStore.setState({ isRunning: false });
    useSessionStore.setState({ sessionId: null });
    renderDraft();
    expect(screen.getByTestId('form-blocked')).toHaveTextContent(
      'The server session is not ready yet.',
    );
  });

  it('deletes the draft from its own button, and the notice offers to put it back', async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, 'info');
    renderDraft([{ id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: { bus: '4' } }]);
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(screen.getByTestId('gone')).toBeInTheDocument();
    expect(useSldStore.getState().selectedNodeId).toBeNull();
    const [title, options] = info.mock.calls[0]!;
    expect(title).toBe('Draft deleted: PV generator 6');
    act(() => (options as { action: { onClick: () => void } }).action.onClick());
    // Back with what it held, where it stood, and picked again.
    expect(useDraftsStore.getState().byCase[CASE]).toEqual([
      { id: 'draft-1', kind: 'PV', position: { x: 1, y: 2 }, values: { bus: '4' } },
    ]);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
  });

  it('opens a second draft of a model on the next idx after the first', () => {
    renderDraft(
      [
        { id: 'draft-1', kind: 'PQ', position: { x: 0, y: 0 }, values: {} },
        { id: 'draft-2', kind: 'PQ', position: { x: 200, y: 0 }, values: {} },
      ],
      'draft-2',
    );
    expect(screen.getByTestId('draft-inspector-header')).toHaveTextContent('PQ load PQ_13');
    expect(screen.getByTestId('field-idx').querySelector('input')).toHaveValue('PQ_13');
  });

  it('can only delete a draft of a kind the app no longer offers', async () => {
    const user = userEvent.setup();
    renderDraft([{ id: 'draft-1', kind: 'Gone', position: { x: 0, y: 0 }, values: {} }]);
    expect(screen.getByTestId('draft-inspector')).toHaveTextContent(
      'This draft is of a kind (Gone) that can no longer be added.',
    );
    expect(screen.queryByRole('button', { name: 'Add to system' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(screen.getByTestId('gone')).toBeInTheDocument();
  });
});
