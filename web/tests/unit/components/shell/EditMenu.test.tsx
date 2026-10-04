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

  it('names the two undos for what each one undoes, and explains them on hover', async () => {
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 1, cloneRedoDepth: 1 });
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const addition = await screen.findByTestId('topbar-menu-edit-undo');
    const parameter = screen.getByTestId('topbar-menu-edit-clone-undo');
    expect(addition).toHaveTextContent('Undo last addition');
    expect(parameter).toHaveTextContent('Undo parameter edit');
    // Each hover text says what it leaves alone, so neither is read as the other.
    expect(addition.getAttribute('aria-description')).toMatch(/added last/);
    expect(parameter.getAttribute('aria-description')).toMatch(/Undo last addition/);
    expect(screen.getByTestId('topbar-menu-edit-clone-redo')).toHaveTextContent(
      'Redo parameter edit',
    );
    // The hover text is on the screen while the pointer is over the item, where a
    // browser's own tooltip is not in the page for anything to read.
    await user.hover(addition);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/added last/);
  });

  it('lists the two parameter commands greyed out, with what to do first, until Edit mode has run', async () => {
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const undo = await screen.findByTestId('topbar-menu-edit-clone-undo');
    const save = screen.getByTestId('topbar-menu-edit-clone-save-as');
    expect(undo).toHaveAttribute('aria-disabled', 'true');
    expect(undo).toHaveTextContent(/Switch to Edit mode and change a controller parameter first/);
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveTextContent('Save parameter edits as case…');
    expect(save).toHaveTextContent(/Nothing to save yet/);
    // Nothing that is not about edits shows a reason, and Redo and Discard stay out.
    expect(screen.getByTestId('topbar-menu-edit-undo')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('topbar-menu-edit-clone-redo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-edit-clone-reset')).not.toBeInTheDocument();
    // A click on the greyed Save does not open its dialog.
    await user.click(save);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says there is nothing to undo once Edit mode is on but no parameter has changed', async () => {
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 0, cloneRedoDepth: 0 });
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    const undo = await screen.findByTestId('topbar-menu-edit-clone-undo');
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
    expect(screen.getByTestId('topbar-menu-edit-clone-undo')).not.toHaveAttribute('aria-disabled');
  });

  it('lists no parameter command when no case is open, since there is nothing to edit', async () => {
    MOCK_TOPOLOGY = null;
    const user = userEvent.setup();
    render(withProviders(<EditMenu />));
    await user.click(screen.getByTestId('topbar-menu-edit-trigger'));
    await screen.findByTestId('topbar-menu-edit-content');
    expect(screen.queryByTestId('topbar-menu-edit-clone-undo')).not.toBeInTheDocument();
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
