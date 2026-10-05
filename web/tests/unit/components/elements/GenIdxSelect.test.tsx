/**
 * GenIdxSelect: dropdown of the static generators for ElementForm `gen_idx`
 * fields. Each option says which bus the generator is on and what already
 * takes it over, since the device being added has to share that bus and a
 * generator is not shared by default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GenIdxSelect } from '@/components/elements/GenIdxSelect';
import type { TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function topology(generators: TopologySummary['generators']): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators,
    loads: [],
    shunts: [],
  };
}

beforeEach(() => {
  MOCK_TOPOLOGY = null;
});

describe('<GenIdxSelect />', () => {
  it('says to add a static generator first when the case has none', () => {
    MOCK_TOPOLOGY = topology([{ idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: {} }]);
    render(<GenIdxSelect value="" onChange={() => {}} />);
    expect(screen.getByTestId('gen-idx-select')).toBeDisabled();
    expect(screen.getByText('Add a PV or Slack generator first.')).toBeInTheDocument();
  });

  it('lists the static generators with their bus and what already uses them', () => {
    MOCK_TOPOLOGY = topology([
      { idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } },
      { idx: 'PV_B', name: 'PV_B', kind: 'PV', params: { bus: 7 } },
      { idx: 1, name: 'G1', kind: 'Slack', params: { bus: 1 } },
      { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 2, gen: 2 } },
    ]);
    render(<GenIdxSelect value="" onChange={() => {}} />);
    const options = Array.from(screen.getByTestId('gen-idx-select').querySelectorAll('option'));
    expect(options.map((o) => [o.value, o.text])).toEqual([
      ['', 'Pick a generator…'],
      ['2', 'PV-2 — G2 (bus 2, used by GENROU_2)'],
      ['PV_B', 'PV-PV_B — PV_B (bus 7)'],
      ['1', 'Slack-1 — G1 (bus 1)'],
    ]);
  });

  it('names a generator alone when the topology gives no bus for it', () => {
    MOCK_TOPOLOGY = topology([{ idx: 9, name: 'G9', kind: 'PV' }]);
    render(<GenIdxSelect value="" onChange={() => {}} />);
    const options = Array.from(screen.getByTestId('gen-idx-select').querySelectorAll('option'));
    expect(options[1]?.text).toBe('PV-9 — G9');
  });

  it('fires onChange with the idx of the generator that was picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    MOCK_TOPOLOGY = topology([{ idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } }]);
    render(<GenIdxSelect value="" onChange={onChange} id="gen" aria-describedby="gen-help" />);
    const select = screen.getByTestId('gen-idx-select');
    expect(select).toHaveAttribute('aria-describedby', 'gen-help');
    await user.selectOptions(select, '2');
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('marks the select as refused when the form says so, and not otherwise', () => {
    MOCK_TOPOLOGY = topology([{ idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } }]);
    const view = render(<GenIdxSelect value="" onChange={() => {}} />);
    expect(screen.getByTestId('gen-idx-select')).not.toHaveAttribute('aria-invalid');

    view.rerender(<GenIdxSelect value="" aria-invalid onChange={() => {}} />);
    const select = screen.getByTestId('gen-idx-select');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveClass('border-danger');
    expect(select).not.toHaveClass('border-border');
  });
});
