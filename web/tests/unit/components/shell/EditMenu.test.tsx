/**
 * Tests for `<EditMenu />`.
 *
 * Unit 9 of the v2.0 polish plan refactored this menu to derive items
 * from the shared command registry instead of embedding
 * `<WorkflowToolbar />`. The menu now renders one
 * `<TopBarMenuItem />` per command in the `edit` group; the
 * underlying mutation logic is still exercised by
 * `tests/unit/components/case/WorkflowToolbar.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { TopologySummary } from '@/api/types';
import { EditMenu } from '@/components/shell/EditMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useSessionStore.setState({
    sessionId: parseSessionId('test-session-id'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
    cloneInitialized: false,
    cloneUndoDepth: 0,
    cloneRedoDepth: 0,
  });
});

afterEach(() => {
  cleanup();
});

describe('<EditMenu />', () => {
  it('mounts the trigger button', () => {
    render(withProviders(<EditMenu />));
    expect(screen.getByTestId('topbar-menu-edit-trigger')).toBeInTheDocument();
  });

  it('opens on click and surfaces the Undo + Reload registry commands', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const content = await screen.findByTestId('topbar-menu-edit-content');
    expect(content).toBeInTheDocument();
    // Items come from the registry (`edit.undo`, `edit.reload`).
    expect(screen.getByTestId('topbar-menu-edit-undo')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-edit-reload')).toBeInTheDocument();
  });

  it('has one Undo and one Redo, each naming the change it would act on', async () => {
    MOCK_TOPOLOGY = {
      ...MOCK_TOPOLOGY!,
      undo: { op: 'delete', model: 'Bus', idx: 3, params: [], also: 4 },
      redo: { op: 'add', model: 'Line', idx: 'L_new', params: [], also: 0 },
    };
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const undo = await screen.findByTestId('topbar-menu-edit-undo');
    const redo = screen.getByTestId('topbar-menu-edit-redo');
    expect(undo).toHaveTextContent('Undo: delete Bus 3 and 4 more');
    expect(redo).toHaveTextContent('Redo: add Line L_new');
    expect(undo).not.toHaveAttribute('aria-disabled');
    // The parameter edits have no Undo of their own any more.
    expect(screen.queryByTestId('topbar-menu-edit-clone-undo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-edit-clone-redo')).not.toBeInTheDocument();
    // The hover text says everything Undo takes back, and is on the screen while
    // the pointer is over the item, where a browser's own tooltip is not in the
    // page for anything to read.
    expect(undo.getAttribute('aria-description')).toMatch(/added, changed or deleted/);
    expect(undo.getAttribute('aria-description')).toMatch(/controller parameter/);
    await user.hover(undo);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/added, changed or deleted/);
  });

  it('names a controller parameter edit when that is what Undo and Redo would act on', async () => {
    MOCK_TOPOLOGY = { ...MOCK_TOPOLOGY!, state: 'committed' };
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 1, cloneRedoDepth: 1 });
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    expect(await screen.findByTestId('topbar-menu-edit-undo')).toHaveTextContent(
      'Undo: parameter edit',
    );
    expect(screen.getByTestId('topbar-menu-edit-redo')).toHaveTextContent('Redo: parameter edit');
  });

  it('lists Undo and Save parameter edits greyed out, with what to do first, until there is an edit', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const undo = await screen.findByTestId('topbar-menu-edit-undo');
    const save = screen.getByTestId('topbar-menu-edit-clone-save-as');
    expect(undo).toHaveAttribute('aria-disabled', 'true');
    expect(undo).toHaveTextContent(
      /Nothing to undo yet. Move something on the diagram, or add, change or delete an element first/,
    );
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveTextContent('Save parameter edits as case…');
    expect(save).toHaveTextContent(/Nothing to save yet/);
    // Nothing that is not about edits shows a reason, and Redo and Discard stay out.
    expect(screen.getByTestId('topbar-menu-edit-reload')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('topbar-menu-edit-redo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-edit-clone-reset')).not.toBeInTheDocument();
    // A click on the greyed Save does not open its dialog.
    await user.click(save);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says after a run that there is nothing to undo once Edit mode is on but no parameter has changed', async () => {
    MOCK_TOPOLOGY = { ...MOCK_TOPOLOGY!, state: 'committed' };
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 0, cloneRedoDepth: 0 });
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const undo = await screen.findByTestId('topbar-menu-edit-undo');
    expect(undo).toHaveAttribute('aria-disabled', 'true');
    expect(undo).toHaveTextContent(/No controller parameter has been changed yet/);
    // The copy exists, so Save parameter edits as case is usable.
    expect(screen.getByTestId('topbar-menu-edit-clone-save-as')).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('turns the greyed Save parameter edits as case into a working one once there is a copy', async () => {
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 1, cloneRedoDepth: 0 });
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const save = await screen.findByTestId('topbar-menu-edit-clone-save-as');
    expect(save).not.toHaveAttribute('aria-disabled');
    expect(save).not.toHaveTextContent(/Nothing to save yet/);
    expect(screen.getByTestId('topbar-menu-edit-undo')).not.toHaveAttribute('aria-disabled');
  });

  it('lists no edit command when no case is open, since there is nothing to edit', async () => {
    MOCK_TOPOLOGY = null;
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    await screen.findByTestId('topbar-menu-edit-content');
    expect(screen.queryByTestId('topbar-menu-edit-undo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-edit-clone-save-as')).not.toBeInTheDocument();
  });

  it('explains Edit mode in the hover text of the item that switches it on', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const toggle = await screen.findByTestId('topbar-menu-edit-toggle-edit-mode');
    expect(toggle.getAttribute('aria-description')).toMatch(/controller parameters/);
    expect(toggle.getAttribute('aria-description')).toMatch(/copy of the case/);
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    await screen.findByTestId('topbar-menu-edit-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-edit-content')).not.toBeInTheDocument();
    });
  });
});
