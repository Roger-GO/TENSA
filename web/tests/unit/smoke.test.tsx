import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { useAuthStore } from '@/store/auth';
import { useSnapshotStore } from '@/store/snapshot';

describe('App scaffold', () => {
  beforeEach(() => {
    // Unit 5 introduced an auth-paste modal that locks the app behind a
    // token entry. The smoke test asserts on the AppShell behind it, so
    // pre-seed the auth store with a synthetic token before render.
    useAuthStore.setState({ token: 'test-token-' + 'a'.repeat(53), persistFailed: false });
  });

  afterEach(() => {
    useSnapshotStore.getState().closeDialogs();
  });

  it('mounts the AppShell with the top bar landmark', () => {
    render(<App />);
    // The shell exposes its top bar as a banner landmark; presence of
    // this landmark confirms the AppShell mounted end-to-end.
    expect(screen.getByRole('banner', { name: /top bar/i })).toBeInTheDocument();
  });

  it('renders the snapshot save dialog when its store flag opens', () => {
    // Regression: SaveSnapshotDialog/LoadSnapshotDialog were mounted only
    // inside SnapshotMenu, which a v3 refactor stopped rendering. The
    // Workspace menu's "Save snapshot…" flipped saveDialogOpen but nothing
    // consumed it, so the action (and Sweep, which needs a snapshot) was a
    // silent no-op. Assert the dialog mounts at the app root.
    render(<App />);
    act(() => {
      useSnapshotStore.getState().openSaveDialog();
    });
    expect(screen.getByTestId('save-snapshot-name-input')).toBeInTheDocument();
  });
});
