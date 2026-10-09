/**
 * The count of values the diagram does not draw, over its corner: a button
 * that says how many values of the power flow have no clear place, and
 * opens the list, where each is written out and a row goes to its element.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SldValuesLeftOff } from '@/components/sld/SldValuesLeftOff';
import type { LeftOffValue } from '@/components/sld/valuesLeftOff';

const ROWS: LeftOffValue[] = [
  { id: 'line-Line_7', kind: 'flow', name: 'line Line_7', values: ['→ 25.97 MW', '87.3%'] },
  { id: 'load-PQ_4', kind: 'readout', name: 'load PQ_4', values: ['47.8 MW', '-3.9 MVAr'] },
  { id: 'generator-2', kind: 'readout', name: 'generator 2', values: ['40.0 MW', '30.4 MVAr'] },
  { id: '14', kind: 'bus', name: 'bus BUS14', values: ['1.036 pu', '-16.03°'] },
];

function renderList(rows: readonly LeftOffValue[] = ROWS) {
  const onShow = vi.fn();
  render(<SldValuesLeftOff rows={rows} onShow={onShow} />);
  return onShow;
}

afterEach(cleanup);

describe('<SldValuesLeftOff />', () => {
  it('draws nothing while every value has a place', () => {
    renderList([]);
    expect(screen.queryByTestId('sld-values-left-off')).toBeNull();
  });

  it('says how many values are not shown, in words a screen reader has too', () => {
    renderList();
    const button = screen.getByTestId('sld-values-left-off');
    expect(button).toHaveTextContent('4 values not shown');
    expect(button).toHaveAttribute('data-left-off-count', '4');
    expect(button).toHaveAccessibleName(
      '4 values not shown on the diagram: no clear place was found for them. Open the list.',
    );
    // Not part of a picture of the view.
    expect(button).toHaveAttribute('data-export-ignore');
  });

  it('counts one value as one', () => {
    renderList([ROWS[0]!]);
    const button = screen.getByTestId('sld-values-left-off');
    expect(button).toHaveTextContent('1 value not shown');
    expect(button).toHaveAccessibleName(
      '1 value not shown on the diagram: no clear place was found for it. Open the list.',
    );
  });

  it('lists every value that is left off with what it reads, by kind', async () => {
    const user = userEvent.setup();
    renderList();
    expect(screen.queryByTestId('sld-values-left-off-list')).toBeNull();
    await user.click(screen.getByTestId('sld-values-left-off'));
    const list = screen.getByTestId('sld-values-left-off-list');
    expect(list).toHaveTextContent('Not shown on the diagram: 4 values');
    expect(list).toHaveTextContent('No place that is clear of the lines');
    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      'Line flows (1)',
      'P and Q of generators and loads (2)',
      'Bus voltages and angles (1)',
    ]);
    expect(within(list).getByTestId('sld-values-left-off-row-line-Line_7')).toHaveTextContent(
      'line Line_7→ 25.97 MW, 87.3%',
    );
    expect(within(list).getByTestId('sld-values-left-off-row-load-PQ_4')).toHaveTextContent(
      'load PQ_447.8 MW, -3.9 MVAr',
    );
    expect(within(list).getByTestId('sld-values-left-off-row-14')).toHaveTextContent(
      'bus BUS141.036 pu, -16.03°',
    );
    // A kind with nothing left off has no heading.
    cleanup();
    renderList([ROWS[3]!]);
    await user.click(screen.getByTestId('sld-values-left-off'));
    expect(
      within(screen.getByTestId('sld-values-left-off-list'))
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Bus voltages and angles (1)']);
  });

  it('goes to the element of a row that is picked, and closes', async () => {
    const user = userEvent.setup();
    const onShow = renderList();
    await user.click(screen.getByTestId('sld-values-left-off'));
    const row = screen.getByTestId('sld-values-left-off-row-generator-2');
    expect(row).toHaveAttribute('title', 'Go to generator 2');
    await user.click(row);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith(ROWS[2]);
    expect(screen.queryByTestId('sld-values-left-off-list')).toBeNull();
  });

  it('is reached and opened from the keyboard', async () => {
    const user = userEvent.setup();
    const onShow = renderList();
    await user.tab();
    expect(screen.getByTestId('sld-values-left-off')).toHaveFocus();
    await user.keyboard('{Enter}');
    // The list opens with the focus on its first row.
    expect(screen.getByTestId('sld-values-left-off-row-line-Line_7')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('sld-values-left-off-row-load-PQ_4')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onShow).toHaveBeenCalledWith(ROWS[1]);
  });
});
