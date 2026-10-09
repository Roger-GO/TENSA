/**
 * Tests for ``<CpfQLimitsSwitch />``: the "Enforce generator Q limits" box of
 * the two CPF forms. It is the power-flow options' own switch, so what is
 * checked here is that the box and that store are one thing, and that the box
 * says, before the run is refused, when the last power flow left generators
 * past a limit and offers to solve it again with the limits on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const runPflow = vi.fn();
vi.mock('@/lib/usePflowRunAction', () => ({ usePflowRunAction: () => runPflow }));

import {
  CpfQLimitsSwitch,
  generatorsPastLimits,
  namedGenerators,
} from '@/components/analyze/CpfQLimitsSwitch';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import type { PflowResult, TopologySummary } from '@/api/types';

function pflow(outputs: Record<string, { q: number; q_min: number | null; q_max: number | null }>) {
  return {
    run_id: 'pf-1',
    converged: true,
    generator_outputs: Object.fromEntries(
      Object.entries(outputs).map(([idx, row]) => [idx, { p: 10, v: 1, bus: idx, ...row }]),
    ),
  } as unknown as PflowResult;
}

// IEEE 14 as the plain power flow leaves it: two generators over their Qmax.
const PAST = pflow({
  '1': { q: -21.6, q_min: -50, q_max: 100 },
  '2': { q: 30.4, q_min: -40, q_max: 15 },
  '3': { q: 12.6, q_min: -10, q_max: 15 },
  '4': { q: 21.0, q_min: -6, q_max: 10 },
});
// The same case solved with the limits on: both sit on their Qmax.
const HELD = pflow({
  '2': { q: 15, q_min: -40, q_max: 15 },
  '4': { q: 10, q_min: -6, q_max: 10 },
});

// The generators of IEEE 14, as the case names them and where each is.
const CASE = {
  state: 'committed',
  buses: [],
  generators: [
    { idx: 1, name: '1', kind: 'Slack', params: { bus: 1 } },
    { idx: 2, name: '2', kind: 'PV', params: { bus: 2 } },
    { idx: 3, name: '3', kind: 'PV', params: { bus: 3 } },
    { idx: 4, name: '4', kind: 'PV', params: { bus: 6 } },
    // The machine on generator 2 goes by another idx and is no static generator.
    { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 2, gen: 2 } },
  ],
} as unknown as TopologySummary;

beforeEach(() => {
  runPflow.mockReset();
  usePflowOptionsStore.getState().resetForNewCase();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useCaseStore.setState({ topology: null });
});

describe('namedGenerators', () => {
  it('names each generator as the table of a curve does: model, idx and bus', () => {
    expect(namedGenerators(['2', '4'], CASE)).toBe('PV 2 (bus 2), PV 4 (bus 6)');
    expect(namedGenerators(['1'], CASE)).toBe('Slack 1 (bus 1)');
  });

  it('goes by the idx alone for a generator the case does not list', () => {
    expect(namedGenerators(['2', '9'], CASE)).toBe('PV 2 (bus 2), 9');
    expect(namedGenerators(['2'], null)).toBe('2');
  });
});

describe('generatorsPastLimits', () => {
  it('names the generators past a limit, and not those on one', () => {
    expect(generatorsPastLimits(PAST)).toEqual(['2', '4']);
    expect(generatorsPastLimits(HELD)).toEqual([]);
  });

  it('has nothing to say without a converged power flow or its generator rows', () => {
    expect(generatorsPastLimits(null)).toEqual([]);
    expect(generatorsPastLimits({ ...PAST, converged: false } as PflowResult)).toEqual([]);
    // The operating point read back after a time-domain run has no rows.
    expect(
      generatorsPastLimits({ converged: true, generator_outputs: {} } as unknown as PflowResult),
    ).toEqual([]);
  });

  it('counts a generator below its Qmin', () => {
    expect(generatorsPastLimits(pflow({ '7': { q: -12, q_min: -10, q_max: 10 } }))).toEqual(['7']);
  });
});

describe('<CpfQLimitsSwitch />', () => {
  it('is the power-flow options switch: ticking it sets that option, and it shows that option', async () => {
    const user = userEvent.setup();
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    const box = screen.getByTestId('cpf-config-enforce-q-limits');
    expect(box).not.toBeChecked();
    expect(screen.getByLabelText(/Enforce generator Q limits/)).toBe(box);

    await user.click(box);
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(true);
    expect(box).toBeChecked();

    await user.click(box);
    // Sent as false from here on, not left to the case.
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(false);
  });

  it('follows the option when it is set elsewhere', () => {
    usePflowOptionsStore.getState().setOptions({ enforceQLimits: true });
    render(<CpfQLimitsSwitch idPrefix="cpf-qv" />);
    expect(screen.getByTestId('cpf-qv-enforce-q-limits')).toBeChecked();
  });

  it('shows a case that turns limits on itself as ticked, and says so', async () => {
    const user = userEvent.setup();
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    expect(screen.getByTestId('cpf-config-enforce-q-limits')).toBeChecked();
    expect(screen.getByTestId('cpf-config-enforce-q-limits-case-note')).toHaveTextContent(
      'The case itself turns this on. Untick it to run without.',
    );
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
    expect(screen.getByTestId('cpf-config-enforce-q-limits-case-note')).toHaveTextContent(
      'Runs go without it while this is unticked.',
    );
  });

  it('says nothing about the power flow while the box is unticked', () => {
    usePflowStore.setState({ lastRun: PAST });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    expect(screen.queryByTestId('cpf-config-q-limits-pflow-note')).not.toBeInTheDocument();
  });

  it('once ticked, names the generators the last power flow left past a limit and runs it again', async () => {
    const user = userEvent.setup();
    usePflowStore.setState({ lastRun: PAST });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));

    const note = screen.getByTestId('cpf-config-q-limits-pflow-note');
    expect(note).toHaveTextContent('The last power flow left generators 2, 4 past a Q limit.');
    expect(note).toHaveTextContent('the power flow has to be run again with the limits on first.');
    expect(screen.getByTestId('cpf-config-q-limits-run-pflow')).toHaveTextContent(
      'Run power flow with Q limits',
    );

    await user.click(screen.getByTestId('cpf-config-q-limits-run-pflow'));
    expect(runPflow).toHaveBeenCalledTimes(1);
    // The run it starts reads the option this box has just set.
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(true);
  });

  it('names the generators as the table under the curve names them', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ topology: CASE });
    usePflowStore.setState({ lastRun: PAST });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
    expect(screen.getByTestId('cpf-config-q-limits-pflow-note')).toHaveTextContent(
      'The last power flow left generators PV 2 (bus 2), PV 4 (bus 6) past a Q limit.',
    );
  });

  describe('with a run of the curve to go on to', () => {
    const thenRun = { label: 'Run CPF (runs the power flow with Q limits first)', run: vi.fn() };
    const press = async () => {
      const user = userEvent.setup();
      usePflowStore.setState({ lastRun: PAST });
      render(<CpfQLimitsSwitch idPrefix="cpf-config" thenRun={thenRun} />);
      await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
      await user.click(screen.getByTestId('cpf-config-q-limits-run-pflow'));
    };
    // What the power flow the button started does to the store.
    const powerFlow = (result: PflowResult | null) => {
      act(() => usePflowStore.setState({ isRunning: true }));
      act(() =>
        usePflowStore.setState(
          result === null ? { isRunning: false } : { lastRun: result, isRunning: false },
        ),
      );
    };

    beforeEach(() => thenRun.run.mockReset());

    it('says that one press does both, and runs the curve once the power flow holds the limits', async () => {
      await press();
      expect(runPflow).toHaveBeenCalledTimes(1);
      expect(thenRun.run).not.toHaveBeenCalled();
      powerFlow(HELD);
      expect(thenRun.run).toHaveBeenCalledTimes(1);
      // Only that once: a later power flow is not followed by a curve.
      powerFlow(pflow({ '2': { q: 15, q_min: -40, q_max: 15 } }));
      expect(thenRun.run).toHaveBeenCalledTimes(1);
    });

    it('names the button and the note for both steps', async () => {
      usePflowStore.setState({ lastRun: PAST });
      const user = userEvent.setup();
      render(<CpfQLimitsSwitch idPrefix="cpf-config" thenRun={thenRun} />);
      await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
      expect(screen.getByTestId('cpf-config-q-limits-run-pflow')).toHaveTextContent(
        'Run CPF (runs the power flow with Q limits first)',
      );
      expect(screen.getByTestId('cpf-config-q-limits-pflow-note')).toHaveTextContent(
        'with the limits on first: the button does both.',
      );
    });

    it('does not run the curve after a power flow that failed', async () => {
      await press();
      powerFlow(null);
      expect(thenRun.run).not.toHaveBeenCalled();
      // Nor after one that was started some other way later on.
      powerFlow(HELD);
      expect(thenRun.run).not.toHaveBeenCalled();
    });

    it('does not run the curve from a power flow that still leaves a generator past a limit', async () => {
      await press();
      powerFlow({ ...PAST, run_id: 'pf-2' } as PflowResult);
      expect(thenRun.run).not.toHaveBeenCalled();
    });
  });

  it('has no note for a power flow that holds its generators on their limits', async () => {
    const user = userEvent.setup();
    usePflowStore.setState({ lastRun: HELD });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
    expect(screen.queryByTestId('cpf-config-q-limits-pflow-note')).not.toBeInTheDocument();
  });

  it('counts the rest when many generators are past a limit', async () => {
    const user = userEvent.setup();
    const many = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [String(i + 1), { q: 50, q_min: -10, q_max: 10 }]),
    );
    usePflowStore.setState({ lastRun: pflow(many) });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
    expect(screen.getByTestId('cpf-config-q-limits-pflow-note')).toHaveTextContent(
      'generators 1, 2, 3, 4 and 3 more past a Q limit',
    );
  });

  it('holds the button while a power flow is running', async () => {
    const user = userEvent.setup();
    usePflowStore.setState({ lastRun: PAST, isRunning: true });
    render(<CpfQLimitsSwitch idPrefix="cpf-config" />);
    await user.click(screen.getByTestId('cpf-config-enforce-q-limits'));
    expect(screen.getByTestId('cpf-config-q-limits-run-pflow')).toBeDisabled();
  });
});
