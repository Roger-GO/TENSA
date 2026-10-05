/**
 * Tests for ``<CpfDirectionEditor />``: the two tables of a custom CPF
 * direction. The component is controlled, so the tests hold its value in a
 * small harness and read what a change hands back.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CpfDirectionEditor, baseValueDirection } from '@/components/analyze/CpfDirectionEditor';
import { EMPTY_CUSTOM_DIRECTION, type CustomDirection } from '@/lib/cpfOptions';

const LOADS = [
  { idx: 'PQ_1', name: 'Load A', bus: '4', p: 21.7, q: 12.7 },
  { idx: 'PQ_2', name: 'PQ_2', bus: '5', p: 50, q: 0 },
];
const GENERATORS = [{ idx: '2', name: 'G2', bus: '2', p: 40 }];

let latest: CustomDirection = EMPTY_CUSTOM_DIRECTION;

function Harness({
  loads = LOADS,
  generators = GENERATORS,
}: {
  loads?: typeof LOADS;
  generators?: typeof GENERATORS;
}) {
  const [value, setValue] = useState<CustomDirection>(EMPTY_CUSTOM_DIRECTION);
  latest = value;
  return (
    <CpfDirectionEditor loads={loads} generators={generators} value={value} onChange={setValue} />
  );
}

describe('<CpfDirectionEditor />', () => {
  it('lists each load and generator with its bus and solved power', () => {
    render(<Harness />);
    const editor = screen.getByTestId('cpf-direction-editor');
    const loadRow = within(editor).getByRole('row', { name: /PQ_1/ });
    expect(loadRow).toHaveTextContent('Load A');
    expect(loadRow).toHaveTextContent('21.7');
    expect(loadRow).toHaveTextContent('12.7');
    // A name that only repeats the idx is not printed twice.
    expect(within(editor).getByRole('row', { name: /PQ_2/ }).textContent).toMatch(/^PQ_25/);
    expect(within(editor).getByRole('row', { name: /G2/ })).toHaveTextContent('40.0');
    // Each field says what it is to a screen reader.
    expect(screen.getByLabelText('Active power added to load PQ_1, MW')).toBeInTheDocument();
    expect(screen.getByLabelText('Reactive power added to load PQ_1, MVAr')).toBeInTheDocument();
    expect(screen.getByLabelText('Active power added to generator 2, MW')).toBeInTheDocument();
  });

  it('keeps what is typed per device', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('cpf-direction-load-PQ_1-p'), '10');
    await user.type(screen.getByTestId('cpf-direction-load-PQ_1-q'), '-2');
    await user.type(screen.getByTestId('cpf-direction-gen-2-p'), '7.5');
    expect(latest).toEqual({
      loads: { PQ_1: { p: '10', q: '-2' } },
      generators: { '2': { p: '7.5', q: '' } },
    });
  });

  it('marks a field that is not a number', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByTestId('cpf-direction-load-PQ_1-p');
    expect(field).not.toHaveAttribute('aria-invalid');
    await user.type(field, '1x');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('fills every device with its own power, and clears', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('cpf-direction-fill'));
    expect(screen.getByTestId('cpf-direction-load-PQ_1-p')).toHaveValue('21.7');
    expect(screen.getByTestId('cpf-direction-load-PQ_1-q')).toHaveValue('12.7');
    // A zero is left blank: the device does not move in that quantity.
    expect(screen.getByTestId('cpf-direction-load-PQ_2-q')).toHaveValue('');
    expect(screen.getByTestId('cpf-direction-gen-2-p')).toHaveValue('40');

    await user.click(screen.getByTestId('cpf-direction-clear'));
    expect(screen.getByTestId('cpf-direction-load-PQ_1-p')).toHaveValue('');
    expect(latest).toEqual(EMPTY_CUSTOM_DIRECTION);
  });

  it('cannot fill from base values that are not there', () => {
    render(
      <Harness
        loads={[{ idx: 'PQ_1', name: 'Load A', bus: '4', p: null, q: null } as never]}
        generators={[]}
      />,
    );
    expect(screen.getByTestId('cpf-direction-fill')).toBeDisabled();
    expect(screen.getByTestId('cpf-direction-editor')).toHaveTextContent(
      'The case has no PV generator.',
    );
  });

  it('baseValueDirection is the proportional direction as drafts', () => {
    expect(baseValueDirection(LOADS, GENERATORS)).toEqual({
      loads: { PQ_1: { p: '21.7', q: '12.7' }, PQ_2: { p: '50', q: '' } },
      generators: { '2': { p: '40', q: '' } },
    });
  });
});
