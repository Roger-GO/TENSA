/**
 * <HistoryRunRow /> tests.
 *
 * Drives the real runs store; asserts on the row's metadata, action
 * buttons, and store side effects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HistoryRunRow } from '@/components/history/HistoryRunRow';
import { useRunsStore } from '@/store/runs';
import { useHistoryStore } from '@/store/history';
import type { RunRecord } from '@/store/runs';

function seedRun(runId: string, tf = 5, scenario?: string): RunRecord {
  useRunsStore.getState().startRun({
    runId,
    tf,
    columnNames: ['Bus_1_v'],
    ...(scenario === undefined ? {} : { scenario }),
  });
  return useRunsStore.getState().runs[runId]!;
}

describe('HistoryRunRow', () => {
  beforeEach(() => {
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      overlayRunIds: new Set(),
      runCount: 0,
    });
    useHistoryStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the run label, state badge, tf, and timestamp', () => {
    const run = seedRun('abcdef1234567890', 5, 'fault bus 7');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    const row = screen.getByTestId('history-run-row-abcdef1234567890');
    expect(row).toHaveAttribute('data-run-id', 'abcdef1234567890');
    expect(screen.getByTestId('history-run-row-state-abcdef1234567890')).toHaveTextContent(
      'starting',
    );
    expect(screen.getByTestId('history-run-row-label-abcdef1234567890')).toHaveTextContent(
      'TDS #1 - fault bus 7',
    );
    expect(row).toHaveTextContent('tf=5s');
  });

  it('keeps the run id off the row, and on hover', () => {
    const run = seedRun('abcdef1234567890');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    expect(screen.getByTestId('history-run-row-abcdef1234567890')).not.toHaveTextContent(
      'abcdef12',
    );
    expect(screen.getByTestId('history-run-row-label-abcdef1234567890')).toHaveAttribute(
      'title',
      'Run id abcdef1234567890',
    );
  });

  it('shows the name the researcher gave the run', () => {
    seedRun('r1');
    useRunsStore.getState().setRunDisplayName('r1', 'Baseline');
    const run = useRunsStore.getState().runs.r1!;
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('Baseline');
  });

  it('flags the active run with the active badge', () => {
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive isOverlayPinned={false} />);
    expect(screen.getByTestId('history-run-row-active-badge-r1')).toBeInTheDocument();
    expect(screen.getByTestId('history-run-row-r1')).toHaveAttribute('data-active', 'true');
  });

  it('renders the Pin button when not pinned; clicking adds to overlay', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    const btn = screen.getByTestId('history-run-row-pin-r1');
    expect(btn).toHaveTextContent('Pin');
    await user.click(btn);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(true);
  });

  it('renders the Unpin button when pinned; clicking removes from overlay', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    useRunsStore.getState().addOverlayRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned />);
    const btn = screen.getByTestId('history-run-row-pin-r1');
    expect(btn).toHaveTextContent('Unpin');
    await user.click(btn);
    expect(useRunsStore.getState().overlayRunIds.has('r1')).toBe(false);
  });

  it('Reset button drops the run from the runs map', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} />);
    await user.click(screen.getByTestId('history-run-row-reset-r1'));
    expect(useRunsStore.getState().runs.r1).toBeUndefined();
  });

  it('fires onTogglePin callback after store mutation', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    const onTogglePin = vi.fn();
    render(
      <HistoryRunRow
        run={run}
        isActive={false}
        isOverlayPinned={false}
        onTogglePin={onTogglePin}
      />,
    );
    await user.click(screen.getByTestId('history-run-row-pin-r1'));
    expect(onTogglePin).toHaveBeenCalledWith('r1', true);
  });

  it('fires onReset callback after the run is dropped', async () => {
    const user = userEvent.setup();
    const run = seedRun('r1');
    const onReset = vi.fn();
    render(<HistoryRunRow run={run} isActive={false} isOverlayPinned={false} onReset={onReset} />);
    await user.click(screen.getByTestId('history-run-row-reset-r1'));
    expect(onReset).toHaveBeenCalledWith('r1');
  });

  describe('renaming', () => {
    /** The row as the drawer renders it: given the run as the store holds it now. */
    function LiveRow({ runId, onRename }: { runId: string; onRename?: () => void }) {
      const run = useRunsStore((s) => s.runs[runId]);
      if (run === undefined) return null;
      return (
        <HistoryRunRow
          run={run}
          isActive={false}
          isOverlayPinned={false}
          {...(onRename === undefined ? {} : { onRename })}
        />
      );
    }

    it('has a visible Rename button that names its run, and opens the name field', async () => {
      const user = userEvent.setup();
      seedRun('r1', 5, 'fault bus 7');
      render(<LiveRow runId="r1" />);
      expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
      const pencil = screen.getByRole('button', { name: 'Rename TDS #1 - fault bus 7' });
      expect(pencil).toBe(screen.getByTestId('history-run-row-rename-r1'));
      expect(pencil).toBeVisible();
      await user.click(pencil);
      const input = screen.getByTestId('history-run-row-name-input-r1');
      expect(document.activeElement).toBe(input);
      expect(useHistoryStore.getState().renamingRunId).toBe('r1');
    });

    it('opens the name field on a double-click of the label', async () => {
      const user = userEvent.setup();
      seedRun('r1');
      render(<LiveRow runId="r1" />);
      await user.dblClick(screen.getByTestId('history-run-row-label-r1'));
      expect(screen.getByTestId('history-run-row-name-input-r1')).toBeInTheDocument();
    });

    it('opens the field when the history store asks for it, as the Rename run command does', () => {
      seedRun('r1');
      seedRun('r2');
      useHistoryStore.getState().startRenaming('r2');
      render(
        <>
          <LiveRow runId="r1" />
          <LiveRow runId="r2" />
        </>,
      );
      expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
      expect(screen.getByTestId('history-run-row-name-input-r2')).toBeInTheDocument();
    });

    it('shows the default label as the placeholder and says how to finish', async () => {
      const user = userEvent.setup();
      seedRun('r1', 5, 'fault bus 7');
      render(<LiveRow runId="r1" />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      const input = screen.getByTestId('history-run-row-name-input-r1');
      expect(input).toHaveValue('');
      expect(input).toHaveAttribute('placeholder', 'TDS #1 - fault bus 7');
      expect(screen.getByTestId('history-run-row-rename-hint-r1')).toHaveTextContent(
        'Enter saves, Esc cancels. Leave it empty to go back to TDS #1 - fault bus 7.',
      );
    });

    it('starts from the name the run already has', async () => {
      const user = userEvent.setup();
      seedRun('r1');
      useRunsStore.getState().setRunDisplayName('r1', 'Baseline');
      render(<LiveRow runId="r1" />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      expect(screen.getByTestId('history-run-row-name-input-r1')).toHaveValue('Baseline');
    });

    it('Enter saves the name, shows it on the row, and reports it', async () => {
      const user = userEvent.setup();
      seedRun('r1', 5, 'fault bus 7');
      const onRename = vi.fn();
      render(<LiveRow runId="r1" onRename={onRename} />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      await user.type(
        screen.getByTestId('history-run-row-name-input-r1'),
        'Baseline no fault{Enter}',
      );
      expect(useRunsStore.getState().runs.r1!.displayName).toBe('Baseline no fault');
      expect(onRename).toHaveBeenCalledWith('r1', 'Baseline no fault');
      expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
      expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('Baseline no fault');
      expect(useHistoryStore.getState().renamingRunId).toBeNull();
      // The pencil now names the run by its new name.
      expect(screen.getByTestId('history-run-row-rename-r1')).toHaveAccessibleName(
        'Rename Baseline no fault',
      );
    });

    it('clicking away saves the name', async () => {
      const user = userEvent.setup();
      seedRun('r1');
      render(
        <>
          <LiveRow runId="r1" />
          <button type="button">elsewhere</button>
        </>,
      );
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      await user.type(screen.getByTestId('history-run-row-name-input-r1'), 'Kept');
      await user.click(screen.getByRole('button', { name: 'elsewhere' }));
      expect(useRunsStore.getState().runs.r1!.displayName).toBe('Kept');
    });

    it('Escape drops what was typed', async () => {
      const user = userEvent.setup();
      seedRun('r1');
      const onRename = vi.fn();
      render(<LiveRow runId="r1" onRename={onRename} />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      await user.type(screen.getByTestId('history-run-row-name-input-r1'), 'Dropped{Escape}');
      expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
      expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent('TDS #1');
    });

    it('an empty name puts the default label back and reports the name as cleared', async () => {
      const user = userEvent.setup();
      seedRun('r1', 5, 'fault bus 7');
      useRunsStore.getState().setRunDisplayName('r1', 'Old name');
      const onRename = vi.fn();
      render(<LiveRow runId="r1" onRename={onRename} />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      await user.clear(screen.getByTestId('history-run-row-name-input-r1'));
      await user.keyboard('{Enter}');
      expect(useRunsStore.getState().runs.r1!.displayName).toBeUndefined();
      expect(onRename).toHaveBeenCalledWith('r1', undefined);
      expect(screen.getByTestId('history-run-row-label-r1')).toHaveTextContent(
        'TDS #1 - fault bus 7',
      );
    });

    it('saving a name that did not change is not reported as a rename', async () => {
      const user = userEvent.setup();
      seedRun('r1');
      const onRename = vi.fn();
      render(<LiveRow runId="r1" onRename={onRename} />);
      await user.click(screen.getByTestId('history-run-row-rename-r1'));
      await user.keyboard('{Enter}');
      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId('history-run-row-name-input-r1')).toBeNull();
    });
  });
});
