/**
 * The run-mode slice: which routine was chosen last, and the run a command
 * asked for until the Run button of that routine has taken it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useRunModeStore } from '@/store/runMode';

beforeEach(() => {
  useRunModeStore.setState({ activeRoutine: 'pflow', runRequest: null });
});

describe('a run that was asked for', () => {
  it('is handed to the one that starts that routine, once', () => {
    const { requestRun, takeRunRequest } = useRunModeStore.getState();
    requestRun('eig');
    // The top bar starts PF and TDS: the request is not its to take.
    expect(takeRunRequest(['pflow', 'tds'])).toBeNull();
    expect(useRunModeStore.getState().runRequest).toEqual({ routine: 'eig' });
    expect(takeRunRequest(['eig'])).toBe('eig');
    expect(useRunModeStore.getState().runRequest).toBeNull();
    // Answered: a second taker finds nothing.
    expect(takeRunRequest(['eig'])).toBeNull();
  });

  it('is a request of its own each time, also for the same routine', () => {
    const { requestRun } = useRunModeStore.getState();
    requestRun('pflow');
    const first = useRunModeStore.getState().runRequest;
    requestRun('pflow');
    const second = useRunModeStore.getState().runRequest;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('leaves the routine that is ticked alone', () => {
    useRunModeStore.getState().setActiveRoutine('cpf');
    useRunModeStore.getState().requestRun('pflow');
    expect(useRunModeStore.getState().activeRoutine).toBe('cpf');
  });
});
