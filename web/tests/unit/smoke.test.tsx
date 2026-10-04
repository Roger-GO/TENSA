import { render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSnapshotStore } from '@/store/snapshot';
import { parseWorkspacePath } from '@/api/types';

describe('App scaffold', () => {
  afterEach(() => {
    useSnapshotStore.getState().closeDialogs();
    useCaseStore.getState().clearCase();
    useCaseStore.getState().setLoadingPath(null);
    usePflowStore.getState().clearPflow();
  });

  it('mounts the AppShell with the top bar landmark', () => {
    render(<App />);
    // The shell exposes its top bar as a banner landmark; presence of
    // this landmark confirms the AppShell mounted end-to-end.
    expect(screen.getByRole('banner', { name: /top bar/i })).toBeInTheDocument();
  });

  it('wires the cross-slice store cascade: another case drops the previous case PF result', () => {
    // Regression: nothing in the app imported the store entrypoint that wires
    // the cascade, so it never ran. Loading a second case left the first
    // case's PF and EIG results in place, enabling Run EIG on a case that had
    // never had a power flow. Importing ``App`` has to be enough to wire it.
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath('a.xlsx'), addfiles: [] });
    usePflowStore.getState().setLastRun({
      run_id: 'pf-1',
      converged: true,
      iterations: 3,
      mismatch: 1e-8,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
      generator_outputs: {},
      load_consumption: {},
    });
    useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath('b.xlsx'), addfiles: [] });
    expect(usePflowStore.getState().lastRun).toBeNull();
  });

  it('says a case is loading, rather than "No case loaded", while its load runs', () => {
    useCaseStore.getState().setLoadingPath(parseWorkspacePath('wscc9.xlsx'));
    render(<App />);
    expect(screen.getAllByText(/Loading wscc9\.xlsx/).length).toBeGreaterThan(0);
    expect(screen.queryByText('No case loaded')).not.toBeInTheDocument();
  });

  it('renders the snapshot save dialog when its store flag opens', async () => {
    // Regression: SaveSnapshotDialog/LoadSnapshotDialog were mounted only
    // inside SnapshotMenu, which a v3 refactor stopped rendering. The
    // Workspace menu's "Save snapshot…" flipped saveDialogOpen but nothing
    // consumed it, so the action (and Sweep, which needs a snapshot) was a
    // silent no-op. Assert the dialog mounts at the app root.
    render(<App />);
    act(() => {
      useSnapshotStore.getState().openSaveDialog();
    });
    // The dialog is a lazily loaded chunk, fetched when the flag first opens.
    expect(await screen.findByTestId('save-snapshot-name-input')).toBeInTheDocument();
  });
});
