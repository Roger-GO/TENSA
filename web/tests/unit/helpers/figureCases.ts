/**
 * What the tests of the figure share: a power flow result for a diagram of
 * the example cases, the figure of a diagram as the dialog draws it, and
 * the figure read back the way the overlap checker reads a diagram.
 *
 * The result is made up (no solver runs in a unit test) but shaped as the
 * server sends it: a voltage and an angle for every bus, a flow for every
 * line and transformer, and a row for every generator and load the diagram
 * prints one for, with values as long as real ones are.
 */
import type { PflowResult } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import {
  drawFigure,
  figurePicture,
  figureShowsValues,
  type DrawnFigure,
  type FigureSource,
} from '@/components/sld/figure/drawFigure';
import { itemBox, type FigureItem } from '@/components/sld/figure/displayList';
import {
  DEFAULT_FIGURE_SETTINGS,
  type FigureSettings,
} from '@/components/sld/figure/figureSettings';
import type { LabelNode } from '@/components/sld/labels';
import type { DrawnBar, DrawnBox, DrawnDiagram, DrawnLine } from '@/components/sld/overlapCheck';
import { pflowKeyOf } from '@/components/sld/valueWidths';
import type { Diagram } from './diagramStates';
import { lineFlow } from './lineFlow';

/** A converged power flow of `diagram`, with a value for everything it draws one for. */
export function solved(diagram: Diagram): PflowResult {
  const bus_voltages: Record<string, number> = {};
  const bus_angles: Record<string, number> = {};
  const generator_outputs: NonNullable<PflowResult['generator_outputs']> = {};
  const load_consumption: NonNullable<PflowResult['load_consumption']> = {};
  const line_flows: NonNullable<PflowResult['line_flows']> = {};
  let i = 0;
  for (const n of diagram.nodes as LabelNode[]) {
    i += 1;
    const idx = String(n.data?.idx ?? n.id);
    if ((n.type ?? 'bus') === 'bus') {
      bus_voltages[idx] = 1.06 - 0.004 * i;
      bus_angles[idx] = -0.021 * i;
      continue;
    }
    const key = pflowKeyOf(n);
    if (key === null) continue;
    const bus = String(n.data?.parentBus ?? '');
    if (n.type === 'generator') {
      generator_outputs[key] = { p: 232.4 - 7.3 * i, q: -16.9 + 3.1 * i, v: 1.04, bus };
    } else if (n.type === 'load') {
      load_consumption[key] = { p: 21.7 + 1.9 * i, q: 12.7 - 0.6 * i, bus };
    }
  }
  for (const e of diagram.edges) {
    const data = e.data as { idx?: string; bucket?: string } | undefined;
    if (data?.idx === undefined || e.type === 'stub') continue;
    i += 1;
    line_flows[data.idx] = lineFlow(i % 3 === 0 ? -(41.2 + i) : 156.9 - 2.3 * i, 3.1 * (i % 5), {
      from: e.source,
      to: e.target,
    });
  }
  return {
    run_id: 'figure',
    converged: true,
    iterations: 4,
    mismatch: 1e-9,
    bus_voltages,
    bus_angles,
    line_flows,
    generator_outputs,
    load_consumption,
  };
}

/** `diagram` as the canvas hands it to the figure, with `pflow` shown on it. */
export function sourceOf(diagram: Diagram, pflow: PflowResult | null = null): FigureSource {
  return {
    nodes: diagram.nodes as LabelNode[],
    edges: diagram.edges as ConnectionEdge[],
    barLengths: diagram.barLengths,
    pflow,
  };
}

/** The figure of `source`, drawn with `settings` over the defaults. */
export function figureOf(
  source: FigureSource,
  settings: Partial<FigureSettings> = {},
  only: ReadonlySet<string> | null = null,
): DrawnFigure {
  const all = { ...DEFAULT_FIGURE_SETTINGS, ...settings };
  return drawFigure(source, figurePicture(source, figureShowsValues(source, all)), all, only);
}

/** The items of `figure` that draw `of`. */
export function itemsOf(figure: DrawnFigure, of: string): FigureItem[] {
  return figure.items.filter((item) => item.of === of);
}

/**
 * `figure` as the overlap checker reads a diagram: every line and connector
 * with the points it is drawn through, every bar, and a box round each group
 * of things drawn for one element (a symbol with its name and chips, a
 * label, a readout, a flow label, the symbol of a transformer, the arrow of
 * a flow), as large as what was really drawn. So a text that left its room,
 * or a symbol drawn out of its box, is found on whatever it reaches, and an
 * arrow on any line but its own, on a bar, on a symbol or on a label.
 */
export function figureAsDrawn(figure: DrawnFigure, source: FigureSource): DrawnDiagram {
  const nodeIds = new Map(source.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(source.edges.map((e) => [e.id, e]));
  const lines: DrawnLine[] = [];
  const bars: DrawnBar[] = [];
  const grouped = new Map<string, FigureItem[]>();
  for (const item of figure.items) {
    const edge = edgeById.get(item.of);
    if (edge !== undefined && item.kind === 'path') {
      const points = item.steps.flatMap((s): [number, number][] =>
        s.op === 'M' || s.op === 'L' ? [[s.x, s.y]] : [],
      );
      lines.push({ id: edge.id, points, from: edge.source, to: edge.target });
      continue;
    }
    const node = nodeIds.get(item.of);
    if (node !== undefined && (node.type ?? 'bus') === 'bus' && item.kind === 'rect') {
      bars.push({
        id: node.id,
        left: item.x,
        right: item.x + item.width,
        y: item.y + item.height / 2,
      });
      continue;
    }
    // The dot of a tap is part of its bar, and the tether of a badge is no box.
    if (/^(tap|tether):/.test(item.of)) continue;
    grouped.set(item.of, [...(grouped.get(item.of) ?? []), item]);
  }
  const boxes: DrawnBox[] = [];
  for (const [of, items] of grouped) {
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const item of items) {
      const box = itemBox(item);
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    const [part, id] = of.includes(':') ? (of.split(/:(.*)/) as [string, string]) : ['', of];
    const kind: DrawnBox['kind'] =
      part === 'label' || part === 'flow'
        ? 'label'
        : part === 'readout'
          ? 'readout'
          : part === 'chain'
            ? 'block'
            : 'symbol';
    boxes.push({
      id: part === '' ? id : of,
      kind,
      box: { left, right, top, bottom },
      ...(part === '' ? {} : { of: [id] }),
    });
  }
  return { lines, bars, boxes };
}
