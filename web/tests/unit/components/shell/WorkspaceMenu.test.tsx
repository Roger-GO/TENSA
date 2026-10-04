/**
 * Tests for `<WorkspaceMenu />` (Unit 8 of the v2.0 polish plan).
 *
 * Covers happy-path opening, item gating on session/case state,
 * dispatching to the right store actions, and the close-on-Escape
 * contract inherited from `<TopBarMenu />`.
 *
 * Integration coverage with the per-component dialogs lives in those
 * components' own tests (SaveSystemDialog, SnapshotMenu, etc.). We
 * verify here that the menu items reach the same store actions that
 * the dialogs read from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { TopologySummary } from '@/api/types';
import { WorkspaceMenu } from '@/components/shell/WorkspaceMenu';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useSnapshotStore } from '@/store/snapshot';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { __requestPaletteDialog, subscribePaletteDialog } from '@/lib/commands';
import { useReportDialogStore } from '@/store/reportDialog';
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

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
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
  useSnapshotStore.getState().reset();
  useReportDialogStore.setState({ dialogOpen: false, activeRoutine: 'pflow' });
});

afterEach(() => {
  cleanup();
});

describe('<WorkspaceMenu /> — render + open', () => {
  it('mounts the trigger button with the kebab-case testid', () => {
    render(withProviders(<WorkspaceMenu />));
    expect(screen.getByTestId('topbar-menu-workspace-trigger')).toBeInTheDocument();
  });

  it('opens on click, exposing every workspace item', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.getByTestId('topbar-menu-workspace-add-element')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-add-pmu')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-import-profile')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-save-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-load-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-report')).toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — actions', () => {
  it('"Save snapshot" routes through the snapshot store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-save-snapshot'));
    expect(useSnapshotStore.getState().saveDialogOpen).toBe(true);
  });

  it('"Load snapshot" routes through the snapshot store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-load-snapshot'));
    expect(useSnapshotStore.getState().loadDialogOpen).toBe(true);
  });

  it('"Add element" opens the add-element panel via the case store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-add-element'));
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
  });

  it('"Report" opens the report dialog via the local report store', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-report'));
    expect(useReportDialogStore.getState().dialogOpen).toBe(true);
  });
});

describe('<WorkspaceMenu /> Open case, Save system and Import bundle', () => {
  afterEach(() => {
    useCommandPaletteStore.setState({ open: false, page: 'commands' });
  });

  it('lists Open case first, and it switches the palette to its Open case page', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    const content = await screen.findByTestId('topbar-menu-workspace-content');
    const first = content.querySelector('[role="menuitem"]');
    expect(first).toBe(screen.getByTestId('topbar-menu-workspace-open-case'));
    await user.click(screen.getByTestId('topbar-menu-workspace-open-case'));
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });
    // The click closed the menu like every other item.
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
    });
  });

  it('"Save system as…" opens the save dialog, and the menu closes', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-save-system'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Save system as/);
    expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
  });

  it('lists Save before Save system as, each with hover text that says what it writes', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    const save = await screen.findByTestId('topbar-menu-workspace-save');
    const saveAs = screen.getByTestId('topbar-menu-workspace-save-system');
    expect(save).toHaveTextContent('Save');
    expect(saveAs).toHaveTextContent('Save system as…');
    expect(save.compareDocumentPosition(saveAs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The case of these tests is a raw one, which Save cannot write back: it asks.
    expect(save.getAttribute('aria-description')).toMatch(/Asks for a name and format/);
    expect(saveAs.getAttribute('aria-description')).toMatch(/new file/);
    // The hover text is drawn on the screen too, not only left to the browser.
    await user.hover(saveAs);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/new file/);
  });

  it('lists Save parameter edits as case with the other saves, greyed out until there is a copy', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    const saveAs = await screen.findByTestId('topbar-menu-workspace-save-system');
    const saveEdits = screen.getByTestId('topbar-menu-workspace-clone-save-as');
    const snapshot = screen.getByTestId('topbar-menu-workspace-save-snapshot');
    expect(saveEdits).toHaveTextContent('Save parameter edits as case…');
    // Right after Save system as, before the snapshots.
    expect(
      saveAs.compareDocumentPosition(saveEdits) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      saveEdits.compareDocumentPosition(snapshot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // It says what to do first, and a click does not open its dialog.
    expect(saveEdits).toHaveAttribute('aria-disabled', 'true');
    expect(saveEdits).toHaveTextContent(/Switch to Edit mode and change a controller parameter/);
    await user.click(saveEdits);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-workspace-content')).toBeInTheDocument();
  });

  it('turns Save parameter edits as case into a working entry once Edit mode made the copy', async () => {
    useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 1, cloneRedoDepth: 0 });
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    const saveEdits = await screen.findByTestId('topbar-menu-workspace-clone-save-as');
    expect(saveEdits).not.toHaveAttribute('aria-disabled');
    const opened: string[] = [];
    const unsubscribe = subscribePaletteDialog((key) => opened.push(key));
    await user.click(saveEdits);
    unsubscribe();
    // It asks for the dialog the Edit menu's entry opens, and the menu closes like
    // for any other item.
    expect(opened).toEqual(['save-as-custom']);
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
    });
  });

  it('does not list Save parameter edits as case when no case is open', async () => {
    MOCK_TOPOLOGY = null;
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('topbar-menu-workspace-clone-save-as')).not.toBeInTheDocument();
  });

  it('"Save" on a case it cannot write back opens the save dialog and says why', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-save'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Save system as/);
    expect(within(dialog).getByTestId('save-system-why-new-file')).toHaveTextContent(
      /ieee14\.raw is a \.raw case/,
    );
  });

  it('"Import bundle…" opens the bundle import dialog', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-import-bundle'));
    expect(await screen.findByTestId('bundle-import-dialog')).toBeInTheDocument();
  });

  it('the palette command opens Save system with the menu closed (and Ctrl/Cmd+S the same way)', async () => {
    render(withProviders(<WorkspaceMenu />));
    expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
    act(() => __requestPaletteDialog('save-system'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('save-confirm')).toBeInTheDocument();
  });

  it('the palette command opens Import bundle with the menu closed', async () => {
    render(withProviders(<WorkspaceMenu />));
    act(() => __requestPaletteDialog('import-bundle'));
    expect(await screen.findByTestId('bundle-import-dialog')).toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — dialogs load on first open', () => {
  it('mounts neither the PMU nor the profile dialog until its item is chosen', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    expect(screen.queryByTestId('pmu-placement-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-import-dialog')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('pmu-placement-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-import-dialog')).not.toBeInTheDocument();
  });

  it('"Add PMU" loads and opens the PMU placement dialog', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-add-pmu'));
    expect(await screen.findByTestId('pmu-placement-dialog')).toBeInTheDocument();
  });

  it('"Import profile" loads and opens the profile import dialog', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-workspace-import-profile'));
    expect(await screen.findByTestId('profile-import-dialog')).toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — gating', () => {
  // Unit 9 changed gating semantics: commands whose `when()` returns
  // false are HIDDEN from the menu (and the palette) entirely instead
  // of rendered as disabled items. The disabled-state UX is gone —
  // see `web/src/lib/commands.ts` and the v2.0 polish plan Unit 9.
  it('hides edit-gated items when no topology is loaded', async () => {
    MOCK_TOPOLOGY = null;
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('topbar-menu-workspace-add-element')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-add-pmu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-import-profile')).not.toBeInTheDocument();
  });

  it('hides session-scoped items when no session is present', async () => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    expect(screen.queryByTestId('topbar-menu-workspace-save-snapshot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-load-snapshot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-menu-workspace-report')).not.toBeInTheDocument();
  });
});

describe('<WorkspaceMenu /> — keyboard', () => {
  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(withProviders(<WorkspaceMenu />));
    await user.click(screen.getByTestId('topbar-menu-workspace-trigger'));
    await screen.findByTestId('topbar-menu-workspace-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-workspace-content')).not.toBeInTheDocument();
    });
  });
});
