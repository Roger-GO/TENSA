/**
 * `useRequestedRun`: the Run button of a routine starts the run a command
 * asked for, once, whether it was on screen when the command was chosen or
 * came on screen for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { useRequestedRun } from '@/lib/useRequestedRun';
import type { RunRoutine } from '@/lib/useRunReadiness';
import { useRunModeStore } from '@/store/runMode';

function Starter({
  routines,
  start,
}: {
  routines: readonly RunRoutine[];
  start: (routine: RunRoutine) => void;
}) {
  useRequestedRun(routines, start);
  return null;
}

beforeEach(() => {
  useRunModeStore.setState({ activeRoutine: 'pflow', runRequest: null });
});

describe('useRequestedRun', () => {
  it('starts the run that is asked for while it is mounted', () => {
    const start = vi.fn();
    render(<Starter routines={['pflow', 'tds']} start={start} />);
    expect(start).not.toHaveBeenCalled();
    act(() => useRunModeStore.getState().requestRun('tds'));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('tds');
    expect(useRunModeStore.getState().runRequest).toBeNull();
  });

  it('starts one that was asked for before it came on screen', () => {
    // The Analysis tab of a drawer that was at its tabs mounts after the command.
    const start = vi.fn();
    useRunModeStore.getState().requestRun('eig');
    render(<Starter routines={['eig']} start={start} />);
    expect(start).toHaveBeenCalledWith('eig');
  });

  it('leaves a request for another routine to whoever starts that one', () => {
    const [top, eig] = [vi.fn(), vi.fn()];
    render(
      <>
        <Starter routines={['pflow', 'tds']} start={top} />
        <Starter routines={['eig']} start={eig} />
      </>,
    );
    act(() => useRunModeStore.getState().requestRun('eig'));
    expect(top).not.toHaveBeenCalled();
    expect(eig).toHaveBeenCalledTimes(1);
  });

  it('starts a request once where two of them could, and once in strict mode', () => {
    const start = vi.fn();
    render(
      <StrictMode>
        <Starter routines={['cpf']} start={start} />
        <Starter routines={['cpf']} start={start} />
      </StrictMode>,
    );
    act(() => useRunModeStore.getState().requestRun('cpf'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts the same routine again when it is asked for again', () => {
    const start = vi.fn();
    render(<Starter routines={['se']} start={start} />);
    act(() => useRunModeStore.getState().requestRun('se'));
    act(() => useRunModeStore.getState().requestRun('se'));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('calls the handler of the render that is on screen', () => {
    const [old, current] = [vi.fn(), vi.fn()];
    const view = render(<Starter routines={['pflow']} start={old} />);
    view.rerender(<Starter routines={['pflow']} start={current} />);
    act(() => useRunModeStore.getState().requestRun('pflow'));
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });
});
