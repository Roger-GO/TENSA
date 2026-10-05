/**
 * Tests for ``<CpfGeneratorPanel />``: what the generators did along a CPF
 * path. Covered: when the panel shows at all, the sentences about limits and
 * about a nose that is due to one, the table of held generators (with where
 * one would have left its limit), the chart's lines and which generators it
 * draws first, the chips, and the limits of the generator pointed at.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CpfGeneratorPanel,
  generatorKey,
  pickDefaultGenerators,
} from '@/components/analyze/CpfGeneratorPanel';
import { useAnalyzeStore } from '@/store/analyze';
import type { CpfGeneratorTrace, CpfLimitEvent, CpfResult } from '@/api/types';

function gen(
  model: 'PV' | 'Slack',
  idx: string,
  q: number[],
  limits: { q_min?: number | null; q_max?: number | null } = {},
): CpfGeneratorTrace {
  return { model, idx, bus: `b${idx}`, q, q_min: limits.q_min ?? -50, q_max: limits.q_max ?? 60 };
}

function held(over: Partial<CpfLimitEvent>): CpfLimitEvent {
  return {
    step: 0,
    lam: 0,
    idx: '2',
    model: 'PV',
    bus: 'b2',
    limit: 'qmax',
    at_nose: false,
    would_release_step: null,
    ...over,
  };
}

// Four steps to a nose that is where the slack runs out of reactive power.
const ENFORCED: CpfResult = {
  lambdas: [0, 0.2, 0.4, 0.5],
  voltages_per_bus: { '1': [1, 0.98, 0.95, 0.9] },
  bus_idxes: ['1'],
  nose_idx: 3,
  max_lam: 0.5,
  truncated: false,
  done_msg: 'Nose point at lambda=0.500000',
  mode: 'pv',
  direction: 'load',
  stop_at: 'nose',
  complete: true,
  q_limits_enforced: true,
  generators: [
    gen('PV', '2', [15, 15, 15, 15], { q_max: 15 }),
    gen('PV', '3', [5, 20, 30, 30], { q_max: 30 }),
    gen('Slack', '1', [-20, 30, 80, 100], { q_max: 100 }),
  ],
  limit_events: [
    held({}),
    held({ idx: '3', bus: 'b3', step: 2, lam: 0.4 }),
    held({ idx: '1', model: 'Slack', bus: 'b1', step: 3, lam: 0.5, at_nose: true }),
  ],
};

beforeEach(() => {
  useAnalyzeStore.setState({ cpfResult: null });
});

describe('<CpfGeneratorPanel />', () => {
  it('renders nothing without a result, or for one that carries no generators', () => {
    const { container, rerender } = render(<CpfGeneratorPanel />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CpfGeneratorPanel result={{ ...ENFORCED, generators: undefined }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CpfGeneratorPanel result={{ ...ENFORCED, generators: [] }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CpfGeneratorPanel result={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the analyze store when no result is passed', () => {
    useAnalyzeStore.setState({ cpfResult: ENFORCED });
    render(<CpfGeneratorPanel />);
    expect(screen.getByTestId('cpf-generators')).toHaveTextContent('3 generators');
  });

  it('says that limits were enforced, how many generators they held, and names the one the nose is due to', () => {
    render(<CpfGeneratorPanel result={ENFORCED} />);
    expect(screen.getByTestId('cpf-generators-summary')).toHaveTextContent(
      'Q limits were enforced: 1 generator held at a limit from the start, 2 more reached one along the path.',
    );
    const nose = screen.getByTestId('cpf-generators-nose');
    expect(nose).toHaveTextContent(
      'The nose is where Slack 1 (bus b1) reached Qmax, at λ = 0.5000.',
    );
    expect(nose).toHaveTextContent('a limit-induced collapse, not a smooth fold of the curve');
  });

  it('does not call a smooth nose limit-induced', () => {
    const smooth = {
      ...ENFORCED,
      limit_events: ENFORCED.limit_events!.map((e) => ({ ...e, at_nose: false })),
    };
    render(<CpfGeneratorPanel result={smooth} />);
    expect(screen.queryByTestId('cpf-generators-nose')).not.toBeInTheDocument();
  });

  it('lists the held generators with the limit and where each got there', () => {
    render(<CpfGeneratorPanel result={ENFORCED} />);
    const table = screen.getByTestId('cpf-generators-events');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByTestId('cpf-generators-event-PV-2')).toHaveTextContent(
      'PV 2b2Qmaxthe start (held by the power flow)',
    );
    expect(screen.getByTestId('cpf-generators-event-PV-3')).toHaveTextContent('λ = 0.4000');
    const slack = screen.getByTestId('cpf-generators-event-Slack-1');
    expect(slack).toHaveTextContent('λ = 0.5000, the nose');
    expect(slack).toHaveAttribute('data-at-nose', 'true');
    // No generator would have left its limit, so there is no column for it.
    expect(within(table).queryByText('Would leave the limit from')).not.toBeInTheDocument();
  });

  it('has no table when no generator is held, and says limits were not enforced', () => {
    render(
      <CpfGeneratorPanel result={{ ...ENFORCED, q_limits_enforced: false, limit_events: [] }} />,
    );
    expect(screen.queryByTestId('cpf-generators-events')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpf-generators-summary')).toHaveTextContent(
      'Q limits were not enforced: generators are free to go past them.',
    );
  });

  it('says where a held generator would have left its limit, and what that does to the curve', () => {
    const pinned: CpfResult = {
      ...ENFORCED,
      limit_events: [held({ limit: 'qmin', would_release_step: 2 }), ENFORCED.limit_events![1]!],
    };
    render(<CpfGeneratorPanel result={pinned} />);
    expect(screen.getByTestId('cpf-generators-release-caution')).toHaveTextContent(
      /^1 held generator has its voltage back across the set-point/,
    );
    expect(screen.getByText('Would leave the limit from')).toBeInTheDocument();
    // Step 2 of the path is lambda 0.4.
    expect(screen.getByTestId('cpf-generators-release-PV-2')).toHaveTextContent('λ = 0.4000');
    expect(screen.getByTestId('cpf-generators-release-PV-3')).toHaveTextContent('—');
  });

  it('draws a line per generator, on the axis of the path', () => {
    render(<CpfGeneratorPanel result={ENFORCED} />);
    for (const key of ['PV-2', 'PV-3', 'Slack-1']) {
      expect(
        screen.getByTestId(`cpf-generators-line-${key}`).getAttribute('points')!.split(' '),
      ).toHaveLength(4);
    }
    // PV 2 sits on its limit: a flat line.
    const ys = screen
      .getByTestId('cpf-generators-line-PV-2')
      .getAttribute('points')!
      .split(' ')
      .map((point) => point.split(',')[1]);
    expect(new Set(ys).size).toBe(1);
    expect(screen.getByText('Reactive power (MVAr)')).toBeInTheDocument();
  });

  it('a chip takes a generator off the chart and puts it back', async () => {
    const user = userEvent.setup();
    render(<CpfGeneratorPanel result={ENFORCED} />);
    const chip = screen.getByTestId('cpf-generators-chip-PV-3');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip);
    expect(screen.queryByTestId('cpf-generators-line-PV-3')).not.toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(screen.getByTestId('cpf-generators-line-PV-3')).toBeInTheDocument();
  });

  it('pointing at a generator names its limits and draws those within the plot', async () => {
    const user = userEvent.setup();
    render(<CpfGeneratorPanel result={ENFORCED} />);
    expect(screen.queryByTestId('cpf-generators-limits-readout')).not.toBeInTheDocument();

    await user.hover(screen.getByTestId('cpf-generators-chip-PV-3'));
    expect(screen.getByTestId('cpf-generators-limits-readout')).toHaveTextContent(
      'PV 3: Qmin -50.0, Qmax 30.0 MVAr',
    );
    // Qmax 30 lies among the curves (-20 to 100); Qmin -50 is below them all
    // and would squeeze the plot if it were drawn.
    expect(screen.getByTestId('cpf-generators-limit-qmax')).toHaveTextContent('Qmax 30.0');
    expect(screen.queryByTestId('cpf-generators-limit-qmin')).not.toBeInTheDocument();

    await user.unhover(screen.getByTestId('cpf-generators-chip-PV-3'));
    expect(screen.queryByTestId('cpf-generators-limits-readout')).not.toBeInTheDocument();
  });

  it('a generator without a limit says so', async () => {
    const user = userEvent.setup();
    const open: CpfResult = {
      ...ENFORCED,
      generators: [{ model: 'PV', idx: '9', bus: 'b9', q: [1, 2, 3, 4], q_min: null, q_max: null }],
      limit_events: [],
    };
    render(<CpfGeneratorPanel result={open} />);
    await user.hover(screen.getByTestId('cpf-generators-chip-PV-9'));
    expect(screen.getByTestId('cpf-generators-limits-readout')).toHaveTextContent(
      'PV 9: Qmin none, Qmax none MVAr',
    );
  });

  it('draws a full curve in two, the lower branch dashed, and says which events are on it', () => {
    const full: CpfResult = {
      ...ENFORCED,
      lambdas: [0, 0.3, 0.5, 0.4, 0.2, 0],
      voltages_per_bus: { '1': [1, 0.97, 0.9, 0.8, 0.7, 0.6] },
      nose_idx: 2,
      stop_at: 'full',
      generators: [gen('PV', '3', [5, 20, 28, 30, 30, 30], { q_max: 30 })],
      limit_events: [held({ idx: '3', bus: 'b3', step: 4, lam: 0.2 })],
    };
    render(<CpfGeneratorPanel result={full} />);
    const lines = screen.getByTestId('cpf-generators').querySelectorAll('polyline');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.getAttribute('points')!.split(' ')).toHaveLength(3);
    expect(lines[1]!.getAttribute('points')!.split(' ')).toHaveLength(4);
    expect(lines[1]).toHaveAttribute('stroke-dasharray');
    expect(screen.getByTestId('cpf-generators-event-PV-3')).toHaveTextContent(
      'λ = 0.2000 on the lower branch',
    );
  });

  it('a QV curve speaks of Q', () => {
    render(<CpfGeneratorPanel result={{ ...ENFORCED, mode: 'qv', direction: null }} />);
    expect(screen.getByTestId('cpf-generators-nose')).toHaveTextContent('at Q = 0.5000');
    expect(screen.getByTestId('cpf-generators-event-PV-3')).toHaveTextContent('Q = 0.4000');
    expect(screen.getByText('Q injection (pu)')).toBeInTheDocument();
  });
});

describe('pickDefaultGenerators', () => {
  const many: CpfResult = {
    ...ENFORCED,
    generators: [
      gen('PV', '2', [15, 15, 15, 15]),
      gen('PV', '3', [5, 20, 30, 30]),
      gen('PV', '4', [0, 1, 2, 3]),
      gen('PV', '5', [0, 10, 40, 90]),
      gen('Slack', '1', [-20, 30, 80, 100]),
    ],
  };

  it('takes the generators that reached a limit along the path first, then the largest swings', () => {
    // PV 3 and Slack 1 switched along the path; PV 5 moved most of the rest.
    expect(pickDefaultGenerators(many, 3)).toEqual(['PV-3', 'Slack-1', 'PV-5']);
    expect(pickDefaultGenerators(many, 8)).toEqual(['PV-3', 'Slack-1', 'PV-5', 'PV-4', 'PV-2']);
  });

  it('keys a generator by its model and idx, which PV and Slack number apart', () => {
    expect(generatorKey({ model: 'Slack', idx: '1' })).toBe('Slack-1');
    expect(generatorKey({ model: 'PV', idx: '1' })).toBe('PV-1');
  });

  it('draws only as many as it is told to at first', () => {
    render(<CpfGeneratorPanel result={many} maxVisible={2} />);
    expect(screen.getByTestId('cpf-generators').querySelectorAll('polyline')).toHaveLength(2);
    expect(screen.getByTestId('cpf-generators-chip-PV-5')).toHaveAttribute('aria-pressed', 'false');
  });
});
