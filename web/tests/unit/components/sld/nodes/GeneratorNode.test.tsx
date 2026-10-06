/**
 * The symbol of a generating unit (`GeneratorNode` with `GeneratingUnit.tsx`).
 *
 * A generator of one model is the device it always was. One that stands for
 * a unit of several models (`data.unit`) names the others in chips either
 * side of its glyph, has a control that draws the control chain out, and
 * shows the chain while it is drawn out. React Flow's `Handle` and `useStore`
 * need a provider, so the module is stubbed the way the other node tests do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

import { GeneratorNode } from '@/components/sld/nodes/GeneratorNode';
import { iconForModel } from '@/icons/iec60617/manifest';
import type { ChainSide } from '@/components/sld/graph';
import type { SldNodeData } from '@/components/sld/nodes/BusNode';
import type { UnitMemberInfo } from '@/lib/generatingUnits';
import { useCaseStore } from '@/store/case';
import { subscribeUnitExpanded, useSldStore } from '@/store/sld';

function member(
  kind: string,
  idx: string,
  role: UnitMemberInfo['role'],
  depth: number,
): UnitMemberInfo {
  const nodeId =
    role === 'generator' || role === 'machine' ? `generator-${idx}` : `controller-${kind}-${idx}`;
  return { kind, idx, name: idx, role, nodeId, depth };
}

/** kundur_full's shape: Slack 1 and GENROU 1 numbered alike, a governor, an exciter and its PSS. */
const KUNDUR = [
  member('Slack', '1', 'generator', 0),
  member('GENROU', '1', 'machine', 1),
  member('EXST1', '1', 'exciter', 2),
  member('IEEEST', 'PSS_1', 'pss', 3),
  member('TGOV1', '1', 'governor', 2),
];

function props(data: Partial<SldNodeData>, selected = false): Parameters<typeof GeneratorNode>[0] {
  return {
    id: 'generator-1',
    data: { idx: '1', name: 'G1', kind: 'Slack', ...data },
    selected,
    type: 'generator',
    isConnectable: true,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof GeneratorNode>[0];
}

const unitOf = (members: UnitMemberInfo[], expanded = false, side?: ChainSide) => ({
  unit: { members, expanded, ...(side ? { side } : {}) },
  symbolKind: 'GENROU',
});

function reset() {
  useCaseStore.setState({ selectedElement: null, pendingDependents: [] });
  useSldStore.getState().clearSelectedNodeId();
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe('a generator of one model', () => {
  it('is the device it always was: its glyph and its name, no chips and nothing to draw out', () => {
    render(<GeneratorNode {...props({ kind: 'PV' })} />);
    const node = screen.getByTestId('generator-node-1');
    expect(node).toHaveTextContent('G1');
    expect(node).not.toHaveAttribute('data-unit-expanded');
    expect(within(node).queryAllByRole('button')).toEqual([]);
  });
});

describe('the symbol of a generating unit', () => {
  it('names each model after its own in a chip, half on either side of the glyph', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    const node = screen.getByTestId('generator-node-1');
    const texts = (testId: string) =>
      within(screen.getByTestId(testId))
        .getAllByRole('button')
        .map((chip) => chip.textContent);
    expect(texts('unit-chips-left-1')).toEqual(['SG', 'AVR']);
    expect(texts('unit-chips-right-1')).toEqual(['PSS', 'GOV']);
    // The glyph between them is the machine's, and the name is the generator's.
    expect(node.querySelector('img')).toHaveAttribute('src', iconForModel('GENROU'));
    expect(iconForModel('GENROU')).not.toBe(iconForModel('Slack'));
    expect(node).toHaveTextContent('G1');
  });

  it('gives a chip the words for what it stands for', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    expect(screen.getByRole('button', { name: 'Machine: GENROU 1' })).toHaveTextContent('SG');
    expect(screen.getByRole('button', { name: 'Governor: TGOV1 1' })).toHaveAttribute(
      'title',
      'Governor: TGOV1 1. Click to inspect.',
    );
  });

  it('puts a single chip on the left and leaves the right empty, so the glyph stays in the middle', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR.slice(0, 2)))} />);
    expect(within(screen.getByTestId('unit-chips-left-1')).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByTestId('unit-chips-right-1')).queryAllByRole('button')).toEqual([]);
  });

  it('keeps a press on a chip from being a drag or a key press of the node', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    for (const chip of screen.getAllByTestId(/^unit-chip-/)) {
      // React Flow leaves alone what carries these.
      expect(chip).toHaveClass('nodrag', 'nopan', 'nokey');
      // Reached by the pointer; the Inspector's list is the way by the keyboard.
      expect(chip).toHaveAttribute('tabindex', '-1');
    }
  });

  it('shows a model in the Inspector on a press of its chip, and does not pass the press on', () => {
    const onNodeClick = vi.fn();
    render(
      <div onClick={onNodeClick}>
        <GeneratorNode {...props(unitOf(KUNDUR))} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('unit-chip-GENROU-1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '1',
      modelClass: 'GENROU',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-1');
    expect(useSldStore.getState().selectedOnDiagram).toBe(true);

    fireEvent.click(screen.getByTestId('unit-chip-IEEEST-PSS_1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'pss',
      modelClass: 'IEEEST',
      idx: 'PSS_1',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('controller-IEEEST-PSS_1');
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('marks the chip of the model the Inspector shows, telling the machine from the generator numbered like it', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR), true)} />);
    const marked = () =>
      screen
        .getAllByTestId(/^unit-chip-/)
        .filter((chip) => chip.getAttribute('data-selected') === 'true')
        .map((chip) => chip.textContent);
    expect(marked()).toEqual([]);

    // The symbol itself was clicked: `generator-1` is the generator, not the
    // machine that goes by the same id.
    useSldStore.getState().setSelectedNodeId('generator-1', 'diagram');
    useCaseStore.setState({
      selectedElement: { kind: 'generator', idx: '1', modelClass: 'Slack' },
    });
    cleanup();
    render(<GeneratorNode {...props(unitOf(KUNDUR), true)} />);
    expect(marked()).toEqual([]);

    cleanup();
    useCaseStore.setState({
      selectedElement: { kind: 'generator', idx: '1', modelClass: 'GENROU' },
    });
    render(<GeneratorNode {...props(unitOf(KUNDUR), true)} />);
    expect(marked()).toEqual(['SG']);
    expect(screen.getByTestId('unit-chip-GENROU-1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks the chip the diagram’s own selection names, whatever the Inspector still shows', () => {
    // The search picked the governor; the Inspector is still on the exciter.
    useCaseStore.setState({
      selectedElement: { kind: 'controller', subKind: 'exciter', modelClass: 'EXST1', idx: '1' },
    });
    useSldStore.getState().setSelectedNodeId('controller-TGOV1-1');
    render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    expect(screen.getByTestId('unit-chip-TGOV1-1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('unit-chip-EXST1-1')).not.toHaveAttribute('data-selected');
  });

  it('says how many models it has no room to name, and draws the chain out on a press there', () => {
    const many = [
      ...KUNDUR,
      member('GENCLS', 'B', 'machine', 1),
      member('TGOV1', 'GB', 'governor', 2),
    ];
    const asked = vi.fn();
    const stop = subscribeUnitExpanded(asked);
    render(<GeneratorNode {...props(unitOf(many))} />);
    // Three models and the count of the other three, two to a side.
    expect(screen.getAllByTestId(/^unit-chip-/).map((chip) => chip.textContent)).toEqual([
      'SG',
      'AVR',
      'PSS',
    ]);
    const more = screen.getByTestId('unit-more-1');
    expect(more).toHaveTextContent('+3');
    expect(more).toHaveAccessibleName('3 more models. Show the control chain.');
    fireEvent.click(more);
    expect(asked).toHaveBeenCalledWith('1', true);
    stop();
  });

  it('rings the symbol and the chip of a model that stands in the way of a delete', () => {
    useCaseStore.setState({
      pendingDependents: [{ idx: 1, name: 'TGOV1_1', kind: 'TGOV1', params: {} }],
    });
    render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    expect(screen.getByTestId('generator-node-1')).toHaveAttribute(
      'data-pending-dependent',
      'true',
    );
    expect(screen.getByTestId('unit-chip-TGOV1-1')).toHaveAttribute(
      'data-pending-dependent',
      'true',
    );
    expect(screen.getByTestId('unit-chip-EXST1-1')).not.toHaveAttribute('data-pending-dependent');
  });
});

describe('the control chain of a unit', () => {
  it('asks for the chain to be drawn out, and to be folded away, from the control at the end of the name', () => {
    const asked = vi.fn();
    const stop = subscribeUnitExpanded(asked);
    const onNodeClick = vi.fn();
    const { rerender } = render(
      <div onClick={onNodeClick}>
        <GeneratorNode {...props(unitOf(KUNDUR))} />
      </div>,
    );
    const show = screen.getByRole('button', { name: 'Show the control chain of generator G1' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveClass('nodrag', 'nokey');
    fireEvent.click(show);
    expect(asked).toHaveBeenLastCalledWith('1', true);
    // Not drawn out until the canvas says so: the layout is the canvas's to keep.
    expect(screen.queryByTestId('unit-chain-1')).not.toBeInTheDocument();

    rerender(
      <div onClick={onNodeClick}>
        <GeneratorNode {...props(unitOf(KUNDUR, true))} />
      </div>,
    );
    const hide = screen.getByRole('button', { name: 'Hide the control chain of generator G1' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(hide);
    expect(asked).toHaveBeenLastCalledWith('1', false);
    // Neither press is a click on the unit.
    expect(onNodeClick).not.toHaveBeenCalled();
    stop();
  });

  it('lists every model of the unit, each under the one it refers to', () => {
    render(<GeneratorNode {...props(unitOf(KUNDUR, true))} />);
    const chain = screen.getByRole('group', { name: 'Control chain of generator G1' });
    const rows = within(chain).getAllByRole('button');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Generator: Slack 1',
      'Machine: GENROU 1',
      'Exciter: EXST1 1',
      'PSS: IEEEST PSS_1',
      'Governor: TGOV1 1',
    ]);
    expect(rows.map((row) => row.getAttribute('data-depth'))).toEqual(['0', '1', '2', '3', '2']);
    // A row ends on the letters its chip has; the generator's own row has none.
    expect(rows[0]).toHaveTextContent(/^Slack1$/);
    expect(rows[2]).toHaveTextContent(/AVR$/);
    // The chips stay on the symbol.
    expect(screen.getAllByTestId(/^unit-chip-/)).toHaveLength(4);
  });

  it('shows a model in the Inspector on a press of its row, and marks the row', () => {
    const onNodeClick = vi.fn();
    render(
      <div onClick={onNodeClick}>
        <GeneratorNode {...props(unitOf(KUNDUR, true))} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('unit-chain-row-EXST1-1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'exciter',
      modelClass: 'EXST1',
      idx: '1',
    });
    expect(screen.getByTestId('unit-chain-row-EXST1-1')).toHaveAttribute('data-selected', 'true');
    // The generator's own row leads back to it.
    fireEvent.click(screen.getByTestId('unit-chain-row-Slack-1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '1',
      modelClass: 'Slack',
    });
    // A press between two rows is not a press on the unit either.
    fireEvent.click(screen.getByTestId('unit-chain-1'));
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('hangs off the side of the symbol away from the bus, outside the box of the node', () => {
    const { rerender } = render(<GeneratorNode {...props(unitOf(KUNDUR, true, 'above'))} />);
    let chain = screen.getByTestId('unit-chain-1');
    expect(chain).toHaveAttribute('data-side', 'above');
    // Out of the flow, so the node measures what it measured folded.
    expect(chain).toHaveClass('absolute', 'bottom-full');

    rerender(<GeneratorNode {...props(unitOf(KUNDUR, true, 'below'))} />);
    chain = screen.getByTestId('unit-chain-1');
    expect(chain).toHaveAttribute('data-side', 'below');
    expect(chain).toHaveClass('absolute', 'top-full');
  });

  it('hangs beside the symbol, against the middle of its side, where the canvas found room there', () => {
    const { rerender } = render(<GeneratorNode {...props(unitOf(KUNDUR, true, 'right'))} />);
    let chain = screen.getByTestId('unit-chain-1');
    expect(chain).toHaveAttribute('data-side', 'right');
    expect(chain).toHaveClass('absolute', 'left-full', 'top-1/2');

    rerender(<GeneratorNode {...props(unitOf(KUNDUR, true, 'left'))} />);
    chain = screen.getByTestId('unit-chain-1');
    expect(chain).toHaveAttribute('data-side', 'left');
    expect(chain).toHaveClass('absolute', 'right-full', 'top-1/2');
  });

  it('shows a plus on its control while it is folded and a minus once it is drawn out, whatever side it is on', () => {
    const mark = () =>
      screen.getByTestId('unit-toggle-1').querySelector('path')?.getAttribute('d') ?? '';
    const { rerender } = render(<GeneratorNode {...props(unitOf(KUNDUR))} />);
    const plus = mark();
    for (const side of ['above', 'below', 'left', 'right'] as const) {
      rerender(<GeneratorNode {...props(unitOf(KUNDUR, true, side))} />);
      // One stroke of the two: the upright one is gone.
      expect(plus.startsWith(mark())).toBe(true);
      expect(mark()).not.toBe(plus);
    }
  });

  it('stands clear of the P / Q readout when that hangs off the same side', () => {
    // A unit close under its bus has its readout on the far side, where the chain is.
    render(<GeneratorNode {...props({ ...unitOf(KUNDUR, true, 'below'), valueSide: 'below' })} />);
    expect(screen.getByTestId('unit-chain-1')).toHaveClass('mt-7');
    cleanup();
    render(<GeneratorNode {...props({ ...unitOf(KUNDUR, true, 'below'), valueSide: 'above' })} />);
    expect(screen.getByTestId('unit-chain-1')).toHaveClass('mt-1');
  });
});
