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
import { DEVICE_LABEL_MIN_ZOOM, deviceLabelsVisibleAtZoom } from '@/components/sld/labelDensity';
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

  it('puts the label above a generator on the north face and below one on the south face', () => {
    setPflow(makePflow());
    const north = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', busSide: 'north' })}
      />,
    );
    expect(north.getByTestId('generator-values-2').className).toContain('bottom-full');
    cleanup();
    const south = render(
      <GeneratorNode
        {...props<typeof GeneratorNode>({ idx: '2', kind: 'PV', busSide: 'south' })}
      />,
    );
    expect(south.getByTestId('generator-values-2').className).toContain('top-full');
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
      <LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ', busSide: 'south' })} />,
    );
    expect(getByTestId('load-p-PQ_1').textContent).toBe('21.7 MW');
    expect(getByTestId('load-q-PQ_1').textContent).toBe('12.7 MVAr');
    expect(getByTestId('load-values-PQ_1').className).toContain('top-full');
  });

  it('puts the label above a load that hangs off the north face', () => {
    setPflow(makePflow());
    const { getByTestId } = render(
      <LoadNode {...props<typeof LoadNode>({ idx: 'PQ_1', kind: 'PQ', busSide: 'north' })} />,
    );
    expect(getByTestId('load-values-PQ_1').className).toContain('bottom-full');
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
  it('draws the labels only at or above the threshold zoom', () => {
    expect(deviceLabelsVisibleAtZoom(0.5)).toBe(false);
    expect(deviceLabelsVisibleAtZoom(DEVICE_LABEL_MIN_ZOOM - 0.01)).toBe(false);
    expect(deviceLabelsVisibleAtZoom(DEVICE_LABEL_MIN_ZOOM)).toBe(true);
    expect(deviceLabelsVisibleAtZoom(1)).toBe(true);
    expect(deviceLabelsVisibleAtZoom(2)).toBe(true);
  });

  it('hides the generator and load labels when the canvas is zoomed out', () => {
    setPflow(makePflow());
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

  it('brings the labels back when the canvas zooms in, and drops them again', () => {
    setPflow(makePflow());
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
