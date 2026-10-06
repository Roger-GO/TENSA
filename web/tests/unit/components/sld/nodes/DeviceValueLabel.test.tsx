/**
 * Generator / load P and Q readouts on the SLD.
 *
 * `GeneratorNode` and `LoadNode` render `DeviceValueLabel`, which reads the
 * last PF result, the "Hide labels" toggle and the canvas zoom. React Flow's
 * `Handle` and `useStore` need a provider, so the module is stubbed the way
 * the other node tests do; `useStore` runs its selector against a mutable
 * zoom so a test can move the canvas across the density threshold.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// A minimal stand-in for React Flow's store: the zoom lives outside React and
// `useStore` subscribes to it, so a test can zoom a mounted node.
const view = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    zoom: 1,
    listeners,
    setZoom(next: number) {
      this.zoom = next;
      listeners.forEach((notify) => notify());
    },
  };
});

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      React.useSyncExternalStore(
        (notify) => {
          view.listeners.add(notify);
          return () => view.listeners.delete(notify);
        },
        () => selector({ transform: [0, 0, view.zoom] }),
      ),
  };
});

import { GeneratorNode } from '@/components/sld/nodes/GeneratorNode';
import { LoadNode } from '@/components/sld/nodes/LoadNode';
import type { SldNodeData } from '@/components/sld/nodes/BusNode';
import {
  DEVICE_LABEL_DENSE_COUNT,
  DEVICE_LABEL_MIN_ZOOM,
  deviceLabelsVisibleAtZoom,
  deviceValueCount,
} from '@/components/sld/labelDensity';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';

function props<T extends typeof GeneratorNode | typeof LoadNode>(
  data: Partial<SldNodeData> & { idx: string; kind: string },
): Parameters<T>[0] {
  return {
    id: `n-${data.idx}`,
    data: { name: `name-${data.idx}`, ...data },
    selected: false,
    type: 'generator',
    isConnectable: true,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<T>[0];
}

function makePflow(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    generator_outputs: {
      '2': { p: 40, q: 30.436, v: 1.03, bus: 2 },
      '1': { p: 81.43, q: -21.62, v: 1.03, bus: 1 },
    },
    load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 2 } },
    ...overrides,
  };
}

/** A converged result with more readouts than a case shows at every zoom. */
function makeDensePflow(): PflowResult {
  const loads: NonNullable<PflowResult['load_consumption']> = {};
  for (let i = 0; i <= DEVICE_LABEL_DENSE_COUNT; i += 1) {
    loads[`PQ_${i}`] = { p: 10, q: 5, bus: 1 };
  }
  return makePflow({ load_consumption: loads });
}

function setPflow(result: PflowResult | null): void {
  act(() => {
    usePflowStore.setState({ lastRun: result, isRunning: false, error: null });
  });
}

beforeEach(() => {
  view.zoom = 1;
  view.listeners.clear();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useUiStore.setState({ hideLabels: false });
});

afterEach(() => {
  cleanup();
});

describe('GeneratorNode P / Q label', () => {
  it('shows nothing before a PF run', () => {
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-2')).toBeNull();
  });

  it('shows the output of the generator after a converged PF', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(getByTestId('generator-p-2').textContent).toBe('40.0 MW');
    expect(getByTestId('generator-q-2').textContent).toBe('30.4 MVAr');
  });

  it('shows the label when the PF result arrives after the node mounted', () => {
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-2')).toBeNull();
    setPflow(makePflow());
    expect(queryByTestId('generator-values-2')).not.toBeNull();
  });

  it('shows nothing when the PF did not converge', () => {
    setPflow(makePflow({ converged: false }));
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-2')).toBeNull();
  });

  it('shows nothing for a generator with no row in the result', () => {
    setPflow(makePflow());
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '99', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-99')).toBeNull();
  });

  it('reads the static generator row for a dynamic machine (pflowIdx)', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: 'GENROU_1', kind: 'GENROU', pflowIdx: '1' })}
      />,
    );
    expect(getByTestId('generator-p-GENROU_1').textContent).toBe('81.4 MW');
    expect(getByTestId('generator-q-GENROU_1').textContent).toBe('-21.6 MVAr');
  });

  it('does not read a row under the machine idx when pflowIdx points elsewhere', () => {
    // A machine numbered like a static generator must not show that
    // generator's row unless that is the one it names in `gen`.
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: '2', kind: 'GENROU', pflowIdx: '1' })}
      />,
    );
    expect(getByTestId('generator-p-2').textContent).toBe('81.4 MW');
  });

  it('shows nothing for a node whose row another node prints (pflowIdx null)', () => {
    // A static generator whose dynamic machine is drawn too leaves the row to
    // the machine, so the injection is not printed twice.
    setPflow(makePflow());
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', pflowIdx: null })} />,
    );
    expect(queryByTestId('generator-values-2')).toBeNull();
  });

  it('is hidden by the Hide labels toggle and returns with it', () => {
    setPflow(makePflow());
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-2')).not.toBeNull();
    act(() => useUiStore.setState({ hideLabels: true }));
    expect(queryByTestId('generator-values-2')).toBeNull();
    act(() => useUiStore.setState({ hideLabels: false }));
    expect(queryByTestId('generator-values-2')).not.toBeNull();
  });

  it('hangs the label on the side of the node that faces its bus', () => {
    setPflow(makePflow());
    const below = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', valueSide: 'below' })}
      />,
    );
    expect(below.getByTestId('generator-values-2').className).toContain('top-full');
    cleanup();
    const above = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', valueSide: 'above' })}
      />,
    );
    expect(above.getByTestId('generator-values-2').className).toContain('bottom-full');
  });

  it('puts the label below a generator that has no side stamped (it sits above its bus)', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(getByTestId('generator-values-2').className).toContain('top-full');
  });

  it('is centred on the node while the connector leaves by another face', () => {
    setPflow(makePflow());
    for (const connectorFace of [undefined, 'east', 'north'] as const) {
      const { getByTestId } = render(
        <GeneratorNode
          {...props<typeof GeneratorNode>({
            idx: '2',
            kind: 'PV',
            valueSide: 'below',
            connectorFace,
          })}
        />,
      );
      const label = getByTestId('generator-values-2');
      expect(label).not.toHaveAttribute('data-beside-connector');
      expect(label.className).toContain('-translate-x-1/2');
      cleanup();
    }
  });

  it('starts beside the connector when the connector leaves by the face it hangs off', () => {
    // The connector runs from the middle of that face: a readout centred on
    // the node would sit on it.
    setPflow(makePflow());
    const below = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({
          idx: '2',
          kind: 'PV',
          valueSide: 'below',
          connectorFace: 'south',
        })}
      />,
    );
    const label = below.getByTestId('generator-values-2');
    expect(label).toHaveAttribute('data-beside-connector', 'true');
    expect(label.className).toContain('left-1/2');
    expect(label.className).toContain('ml-1');
    expect(label.className).not.toContain('-translate-x-1/2');
    cleanup();
    const above = render(
      <LoadNode
        {...props<typeof LoadNode>({
          idx: 'PQ_1',
          kind: 'PQ',
          valueSide: 'above',
          connectorFace: 'north',
        })}
      />,
    );
    expect(above.getByTestId('load-values-PQ_1')).toHaveAttribute('data-beside-connector', 'true');
  });

  it('stands on the other side of a connector that goes off to the right', () => {
    // A connector drawn at an angle from the middle of the face: beside it
    // on the right the readout would sit on the line.
    setPflow(makePflow());
    const leaning = (connectorLean: number | undefined) =>
      render(
        <GeneratorNode
          {...props<typeof GeneratorNode>({
            idx: '2',
            kind: 'PV',
            valueSide: 'below',
            connectorFace: 'south',
            connectorLean,
          })}
        />,
      ).getByTestId('generator-values-2');
    const right = leaning(1);
    expect(right).toHaveAttribute('data-beside-connector', 'left');
    expect(right.className).toContain('right-1/2');
    expect(right.className).toContain('mr-1');
    expect(right.className).not.toContain('left-1/2');
    cleanup();
    // To the left, or straight down, it stays on the right of the connector.
    for (const lean of [-1, undefined]) {
      const label = leaning(lean);
      expect(label).toHaveAttribute('data-beside-connector', 'true');
      expect(label.className).toContain('left-1/2');
      expect(label.className).not.toContain('right-1/2');
      cleanup();
    }
  });

  it('takes no notice of which way the connector goes when it leaves by another face', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({
          idx: '2',
          kind: 'PV',
          valueSide: 'below',
          connectorFace: 'east',
          connectorLean: 1,
        })}
      />,
    );
    const label = getByTestId('generator-values-2');
    expect(label).not.toHaveAttribute('data-beside-connector');
    expect(label.className).toContain('-translate-x-1/2');
  });

  it('keeps the label outside the normal flow so the node box does not grow', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    const label = getByTestId('generator-values-2');
    expect(label.className).toContain('absolute');
    expect(label.className).toContain('pointer-events-none');
    expect(getByTestId('generator-node-2').className).toContain('relative');
  });
});

describe('LoadNode P / Q label', () => {
  it('shows the consumption of the load after a converged PF', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ' })} />,
    );
    expect(getByTestId('load-p-PQ_1').textContent).toBe('21.7 MW');
    expect(getByTestId('load-q-PQ_1').textContent).toBe('12.7 MVAr');
    // A load sits below its bus by default, so the strip facing it is above.
    expect(getByTestId('load-values-PQ_1').className).toContain('bottom-full');
  });

  it('puts the label below a load that sits above its bus', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ', valueSide: 'below' })} />,
    );
    expect(getByTestId('load-values-PQ_1').className).toContain('top-full');
  });

  it('reads load_consumption, not generator_outputs', () => {
    // A generator idx must not light up a load that happens to share it.
    setPflow(makePflow());
    const { queryByTestId } = render(
      <LoadNode {...props<typeof LoadNode>({ idx: '2', kind: 'PQ' })} />,
    );
    expect(queryByTestId('load-values-2')).toBeNull();
  });

  it('is hidden by the Hide labels toggle', () => {
    setPflow(makePflow());
    useUiStore.setState({ hideLabels: true });
    const { queryByTestId } = render(
      <LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ' })} />,
    );
    expect(queryByTestId('load-values-PQ_1')).toBeNull();
  });
});

describe('zoom-level label density', () => {
  it('draws a small or medium case at every zoom', () => {
    expect(deviceLabelsVisibleAtZoom(0.5, 3)).toBe(true);
    expect(deviceLabelsVisibleAtZoom(0.5, DEVICE_LABEL_DENSE_COUNT)).toBe(true);
    expect(deviceLabelsVisibleAtZoom(2, 3)).toBe(true);
  });

  it('draws a dense case only at or above the threshold zoom', () => {
    const dense = DEVICE_LABEL_DENSE_COUNT + 1;
    expect(deviceLabelsVisibleAtZoom(0.5, dense)).toBe(false);
    expect(deviceLabelsVisibleAtZoom(DEVICE_LABEL_MIN_ZOOM - 0.01, dense)).toBe(false);
    expect(deviceLabelsVisibleAtZoom(DEVICE_LABEL_MIN_ZOOM, dense)).toBe(true);
    expect(deviceLabelsVisibleAtZoom(2, dense)).toBe(true);
  });

  it('counts the readouts a converged result can put on the diagram', () => {
    expect(deviceValueCount(null)).toBe(0);
    expect(deviceValueCount(makePflow({ converged: false }))).toBe(0);
    expect(deviceValueCount(makePflow())).toBe(3);
    expect(deviceValueCount(makePflow({ generator_outputs: undefined }))).toBe(1);
  });

  it('shows the readouts of a small case at the most zoomed-out view', () => {
    setPflow(makePflow());
    view.zoom = 0.5;
    const gen = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    const load = render(<LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ' })} />);
    expect(gen.queryByTestId('generator-values-2')).not.toBeNull();
    expect(load.queryByTestId('load-values-PQ_1')).not.toBeNull();
  });

  it('hides the generator and load labels of a dense case when the canvas is zoomed out', () => {
    setPflow(makeDensePflow());
    view.zoom = 0.5;
    const gen = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    const load = render(<LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ' })} />);
    expect(gen.queryByTestId('generator-values-2')).toBeNull();
    expect(load.queryByTestId('load-values-PQ_1')).toBeNull();
    // The name stays: only the value readout is thinned out.
    expect(gen.getByTestId('generator-node-2').textContent).toContain('name-2');
  });

  it('brings the labels of a dense case back when the canvas zooms in, and drops them again', () => {
    setPflow(makeDensePflow());
    view.zoom = 0.5;
    const { queryByTestId } = render(
      <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV' })} />,
    );
    expect(queryByTestId('generator-values-2')).toBeNull();
    act(() => view.setZoom(1));
    expect(queryByTestId('generator-values-2')).not.toBeNull();
    act(() => view.setZoom(0.55));
    expect(queryByTestId('generator-values-2')).toBeNull();
  });
});

describe('GeneratorNode reactive limit marker', () => {
  const limits = (q: number) =>
    makePflow({
      generator_outputs: { '2': { p: 40, q, v: 1.03, bus: 2, q_min: -10, q_max: 15 } },
    });
  const node = (extra: Partial<SldNodeData> = {}) => (
    <GeneratorNode {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', ...extra })} />
  );

  it('has no marker and the normal outline before a power flow or within the limits', () => {
    const { getByTestId, queryByTestId } = render(node());
    expect(queryByTestId('generator-q-marker-2')).toBeNull();
    expect(getByTestId('generator-node-2').className).toContain('border-border');
    setPflow(limits(5));
    expect(queryByTestId('generator-q-marker-2')).toBeNull();
    expect(getByTestId('generator-node-2').className).toContain('border-border');
    expect(getByTestId('generator-node-2')).not.toHaveAttribute('data-q-limit');
  });

  it('outlines a generator past its upper limit red, with a filled triangle pointing up', () => {
    setPflow(limits(30));
    const { getByTestId } = render(node());
    const gen = getByTestId('generator-node-2');
    expect(gen).toHaveAttribute('data-q-limit', 'above-max');
    expect(gen.className).toContain('border-danger');
    const marker = getByTestId('generator-q-marker-2');
    expect(marker).toHaveAttribute('data-band', 'danger');
    expect(marker).toHaveAttribute('data-side', 'high');
    expect(marker.getAttribute('aria-label')).toBe('Reactive power beyond its upper limit');
  });

  it('marks a generator past its lower limit with a triangle pointing down', () => {
    setPflow(limits(-25));
    const { getByTestId } = render(node());
    expect(getByTestId('generator-node-2')).toHaveAttribute('data-q-limit', 'below-min');
    expect(getByTestId('generator-q-marker-2')).toHaveAttribute('data-side', 'low');
  });

  it('outlines a generator on its limit amber, with an empty triangle', () => {
    setPflow(limits(15));
    const { getByTestId } = render(node());
    const gen = getByTestId('generator-node-2');
    expect(gen).toHaveAttribute('data-q-limit', 'at-max');
    expect(gen.className).toContain('border-warning');
    expect(getByTestId('generator-q-marker-2')).toHaveAttribute('data-band', 'warning');
  });

  it('keeps the marker when the labels are hidden', () => {
    useUiStore.setState({ hideLabels: true });
    setPflow(limits(30));
    const { getByTestId, queryByTestId } = render(node());
    expect(queryByTestId('generator-values-2')).toBeNull();
    expect(getByTestId('generator-q-marker-2')).toBeInTheDocument();
  });

  it('reads the row the node prints: a machine reads its static generator, a quiet node nothing', () => {
    setPflow(limits(30));
    const machine = render(node({ idx: 'GENROU_2', kind: 'GENROU', pflowIdx: '2' }));
    expect(machine.getByTestId('generator-node-GENROU_2')).toHaveAttribute(
      'data-q-limit',
      'above-max',
    );
    machine.unmount();
    const quiet = render(node({ pflowIdx: null }));
    expect(quiet.getByTestId('generator-node-2')).not.toHaveAttribute('data-q-limit');
  });
});
