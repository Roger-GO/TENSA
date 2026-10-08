/**
 * The figure of the diagram, held to what it is for.
 *
 * - Nothing on it is drawn over anything else: the rule the diagram keeps
 *   (`noOverlap.test.ts`) is kept by the figure of it, on the three example
 *   cases and on the IEEE 118-bus case, as the case opens, tidied and laid
 *   out again, with and without the values of a power flow, in every font
 *   and at the largest text there is. The figure is read back as it was
 *   drawn (`figureAsDrawn`), each text as wide as its font sets it, so a
 *   label that left its room would be found on whatever it reached.
 * - It is the picture of the diagram: every line runs through the points of
 *   its route, every bar is where the picture has it, every line end on a
 *   bar has its dot, and every label is inside the box the picture keeps
 *   for it.
 * - What is chosen for it shows: black and white or colour, the width of
 *   the lines, the font and the size, each kind of label, the marks of a
 *   limit, and the part of the diagram.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `noOverlap.test.ts`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { PflowResult, TopologySummary } from '@/api/types';
import { BAR_THICKNESS, TAP_DOT_RADIUS, labelBoxAt } from '@/components/sld/connections';
import {
  FIGURE_MARGIN,
  drawFigure,
  figurePicture,
  figureScope,
  figureShowsValues,
  type FigureSource,
} from '@/components/sld/figure/drawFigure';
import {
  itemBox,
  type FigureItem,
  type PathItem,
  type TextItem,
} from '@/components/sld/figure/displayList';
import { DEFAULT_FIGURE_SETTINGS } from '@/components/sld/figure/figureSettings';
import { textWidth } from '@/components/sld/figure/fontMetrics';
import { LINE_LABEL_BOX, TRANSFORMER_LABEL_BOX } from '@/components/sld/labels';
import { describeOverlaps, findOverlaps } from '@/components/sld/overlapCheck';
import { valueLabelWidths } from '@/components/sld/valueWidths';
import { CASE118 } from '../../../helpers/case118';
import { opened, tidied, type Diagram } from '../../../helpers/diagramStates';
import { IEEE14, KUNDUR, WSCC9 } from '../../../helpers/exampleCases';
import { figureAsDrawn, figureOf, itemsOf, solved, sourceOf } from '../../../helpers/figureCases';
import { lineFlow } from '../../../helpers/lineFlow';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const EXAMPLES: readonly [string, TopologySummary][] = [
  ['IEEE 14', IEEE14],
  ['Kundur', KUNDUR],
  ['WSCC 9', WSCC9],
];

const texts = (items: readonly FigureItem[]): TextItem[] =>
  items.filter((item): item is TextItem => item.kind === 'text');
const said = (items: readonly FigureItem[]): string[] => texts(items).map((item) => item.text);
const overlapsOf = (
  source: FigureSource,
  ...rest: Parameters<typeof figureOf> extends [unknown, ...infer R] ? R : never
) => describeOverlaps(findOverlaps(figureAsDrawn(figureOf(source, ...rest), source)));

/** Whether `inner` lies in `outer`, to within `slack`. */
function within(
  inner: { x: number; y: number; width: number; height: number },
  outer: { left: number; right: number; top: number; bottom: number },
  slack = 0.01,
): boolean {
  return (
    inner.x >= outer.left - slack &&
    inner.x + inner.width <= outer.right + slack &&
    inner.y >= outer.top - slack &&
    inner.y + inner.height <= outer.bottom + slack
  );
}

describe('nothing on a figure is drawn over anything else', () => {
  for (const [name, topology] of EXAMPLES) {
    it(`${name}: as it opens, tidied and laid out again, with and without values, in every style`, async () => {
      const first = await opened(topology);
      for (const [state, diagram] of [
        ['as it opens', first],
        ['tidied', tidied(first, false)],
        ['laid out again', tidied(first, true)],
      ] as const) {
        for (const pflow of [null, solved(diagram)]) {
          const source = sourceOf(diagram, pflow);
          const where = `${state}, ${pflow === null ? 'plain' : 'with values'}`;
          expect(overlapsOf(source), where).toEqual([]);
          // The font that is widest for its size, and the largest text.
          expect(overlapsOf(source, { font: 'mono', fontSize: 12 }), `${where}, mono 12`).toEqual(
            [],
          );
          expect(overlapsOf(source, { font: 'serif', fontSize: 7 }), `${where}, serif 7`).toEqual(
            [],
          );
          // The heaviest lines, in colour, with every mark of a limit.
          expect(
            overlapsOf(source, { monochrome: false, lineWidth: 2.5, limitMarks: true }),
            `${where}, colour`,
          ).toEqual([]);
        }
      }
    });
  }

  it('IEEE 118: as it opens and tidied, with values, within the time a click may take', async () => {
    const first = await opened(CASE118);
    for (const diagram of [first, tidied(first, false)]) {
      const source = sourceOf(diagram, solved(diagram));
      const started = performance.now();
      const figure = figureOf(source, { fontSize: 12 });
      const took = performance.now() - started;
      expect(describeOverlaps(findOverlaps(figureAsDrawn(figure, source)))).toEqual([]);
      expect(figure.shown).toBeGreaterThan(118);
      // The picture and the figure of it together; a choice in the dialog
      // redraws the figure alone, which is a small part of this.
      expect(took).toBeLessThan(4_000);
    }
  }, 60_000);

  it('a part of IEEE 14, which is drawn from the same picture', async () => {
    const first = await opened(IEEE14);
    const source = sourceOf(first, solved(first));
    const only = figureScope(source.nodes, new Set(['1', '2', '5', '4']));
    expect(
      describeOverlaps(findOverlaps(figureAsDrawn(figureOf(source, {}, only), source))),
    ).toEqual([]);
  });
});

describe('a figure is the picture of the diagram', () => {
  let diagram: Diagram;
  let pflow: PflowResult;
  let source: FigureSource;
  beforeAll(async () => {
    diagram = await opened(IEEE14);
    pflow = solved(diagram);
    source = sourceOf(diagram, pflow);
  });

  it('draws every line and connector through the points of its route, and nothing through any other', () => {
    const figure = figureOf(source);
    const picture = figurePicture(source, true);
    const edgeIds = new Set(diagram.edges.map((e) => e.id));
    const drawn = figure.items.filter(
      (item): item is PathItem => item.kind === 'path' && edgeIds.has(item.of),
    );
    expect(drawn.map((item) => item.of).sort()).toEqual([...edgeIds].sort());
    for (const item of drawn) {
      const route = picture.connections.routes.get(item.of)!;
      expect(
        item.steps.map((step) => (step.op === 'Z' ? null : [step.x, step.y])),
        item.of,
      ).toEqual(route.points);
      // One line: solid, with no fill, as heavy as every other.
      expect(item.fill, item.of).toBeUndefined();
      expect(item.stroke, item.of).toEqual({ colour: '#000000', width: 1.5 });
    }
  });

  it('draws every bar where the picture has it, and a dot where each line ends on one', () => {
    const figure = figureOf(source);
    const picture = figurePicture(source, true);
    const buses = diagram.nodes.filter((n) => n.type === 'bus');
    const ends = new Set<string>();
    for (const bus of buses) {
      const bar = picture.connections.bars.get(bus.id)!;
      const [rect] = itemsOf(figure, bus.id);
      expect(rect).toMatchObject({
        kind: 'rect',
        x: bus.position.x + bar.start,
        y: bus.position.y,
        width: bar.end - bar.start,
        height: BAR_THICKNESS,
        fill: '#000000',
      });
      // A tap of the bar for each end that lands on it, and no two in one place.
      for (const tap of bar.taps) ends.add(`${bus.id}|${(bus.position.x + tap.x).toFixed(1)}`);
      const dots = itemsOf(figure, `tap:${bus.id}`);
      expect(dots.length, bus.id).toBe(new Set(bar.taps.map((tap) => tap.x)).size);
      for (const dot of dots) {
        if (dot.kind !== 'circle') throw new Error('a tap is a dot');
        expect(dot.r).toBe(TAP_DOT_RADIUS);
        expect(ends.has(`${bus.id}|${dot.cx.toFixed(1)}`), `${bus.id} at ${dot.cx}`).toBe(true);
        // On the bar: within its length, on its centre line.
        expect(dot.cx).toBeGreaterThanOrEqual(bus.position.x + bar.start - 0.01);
        expect(dot.cx).toBeLessThanOrEqual(bus.position.x + bar.end + 0.01);
        expect(dot.cy).toBeCloseTo(bus.position.y + BAR_THICKNESS / 2, 6);
      }
    }
  });

  it('sets every label inside the box the picture keeps for it', () => {
    for (const settings of [
      {},
      { font: 'mono', fontSize: 12 } as const,
      { font: 'serif' } as const,
    ]) {
      const figure = figureOf(source, settings);
      const picture = figurePicture(source, true);
      const widths = valueLabelWidths(source.nodes, source.edges, pflow);
      let labels = 0;
      for (const [id, label] of picture.busLabels) {
        for (const item of itemsOf(figure, `label:${id}`)) {
          labels += 1;
          expect(within(itemBox(item), label.box), `label of ${id}`).toBe(true);
        }
      }
      for (const [id, place] of picture.readouts) {
        for (const item of itemsOf(figure, `readout:${id}`)) {
          labels += 1;
          expect(within(itemBox(item), place.box), `readout of ${id}`).toBe(true);
        }
      }
      for (const edge of diagram.edges) {
        const at = picture.labelPlaces.get(edge.id);
        if (at === undefined) continue;
        const flow = itemsOf(figure, `flow:${edge.id}`);
        if (flow.length > 0) {
          const box = labelBoxAt(at, widths.flows.get(edge.id)!, LINE_LABEL_BOX.height);
          for (const item of flow) {
            labels += 1;
            expect(within(itemBox(item), box), `flow of ${edge.id}`).toBe(true);
          }
        }
        const symbol = itemsOf(figure, `symbol:${edge.id}`);
        if (symbol.length > 0) {
          const { width, height } = TRANSFORMER_LABEL_BOX;
          for (const item of symbol) {
            expect(within(itemBox(item), labelBoxAt(at, width, height)), edge.id).toBe(true);
          }
        }
      }
      expect(labels).toBeGreaterThan(80);
    }
  });

  it('draws every device in the box of its node: the symbol, the name and the chips', () => {
    const figure = figureOf(source, { font: 'mono', fontSize: 12 });
    const devices = diagram.nodes.filter((n) => n.type !== 'bus');
    expect(devices.length).toBeGreaterThan(15);
    for (const node of devices) {
      const box = {
        left: node.position.x,
        right: node.position.x + node.initialWidth!,
        top: node.position.y,
        bottom: node.position.y + node.initialHeight!,
      };
      const items = itemsOf(figure, node.id);
      // The outline, the symbol and the name at the least.
      expect(items.length, node.id).toBeGreaterThanOrEqual(3);
      // Half the outline's own stroke reaches past the box, and no more.
      for (const item of items) expect(within(itemBox(item), box, 0.4), node.id).toBe(true);
    }
  });

  it('keeps the same margin round what it draws, and says how much it shows', () => {
    const figure = figureOf(source);
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const item of figure.items) {
      const box = itemBox(item);
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    expect(left - figure.box.x).toBeGreaterThanOrEqual(FIGURE_MARGIN);
    expect(left - figure.box.x).toBeLessThan(FIGURE_MARGIN + 1);
    expect(figure.box.x + figure.box.width - right).toBeGreaterThanOrEqual(FIGURE_MARGIN);
    expect(figure.box.y + figure.box.height - bottom).toBeLessThan(FIGURE_MARGIN + 1);
    // 14 buses, 5 generating units, 11 loads and 2 shunts.
    expect(figure.shown).toBe(32);
    expect(figure.paper).toBe('#ffffff');
  });

  it('draws nothing that belongs to the screen: no selection, and no control of a unit', () => {
    const picked = {
      ...source,
      nodes: source.nodes.map((n) => ({
        ...n,
        selected: true,
        data: { ...n.data, sldSelected: true },
      })),
      edges: source.edges.map((e) => ({ ...e, data: { ...e.data, active: true } })),
    };
    expect(figureOf(picked).items).toEqual(figureOf(source).items);
  });
});

describe('what is chosen for a figure shows on it', () => {
  let diagram: Diagram;
  let pflow: PflowResult;
  let source: FigureSource;
  beforeAll(async () => {
    diagram = await opened(IEEE14);
    pflow = solved(diagram);
    source = sourceOf(diagram, pflow);
  });

  const colours = (items: readonly FigureItem[]): string[] => {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind === 'text') seen.add(item.colour);
      else {
        if (item.fill !== undefined) seen.add(item.fill);
        if (item.stroke !== undefined) seen.add(item.stroke.colour);
      }
    }
    return [...seen].sort();
  };

  it('is black on white unless colour is asked for, whatever the power flow found', () => {
    const overloaded: PflowResult = {
      ...pflow,
      // Past its upper limit, within 0.02 pu of it, and in the clear.
      bus_voltages: { ...pflow.bus_voltages, '3': 1.2, '4': 1.04, '10': 1.0 },
      line_flows: {
        ...pflow.line_flows,
        Line_1: lineFlow(120, 4, { from: 1, to: 2 }, { rate_a: 100, loading_pct: 120 }),
        Line_2: lineFlow(95, 4, { from: 1, to: 5 }, { rate_a: 100, loading_pct: 95 }),
      },
    };
    const found = { ...source, pflow: overloaded };
    expect(colours(figureOf(found).items)).toEqual(['#000000', '#ffffff']);
    expect(colours(figureOf(found, { limitMarks: true }).items)).toEqual(['#000000', '#ffffff']);

    const inColour = figureOf(found, { monochrome: false });
    // The bus past its limit and the line past its rating in red, the line near it in amber.
    expect(itemsOf(inColour, '3')[0]).toMatchObject({ kind: 'rect', fill: '#b91c1c' });
    expect(itemsOf(inColour, '4')[0]).toMatchObject({ kind: 'rect', fill: '#b45309' });
    expect(itemsOf(inColour, '10')[0]).toMatchObject({ kind: 'rect', fill: '#111827' });
    expect(itemsOf(inColour, 'line-Line_1')[0]).toMatchObject({ stroke: { colour: '#b91c1c' } });
    expect(itemsOf(inColour, 'line-Line_2')[0]).toMatchObject({ stroke: { colour: '#b45309' } });
    expect(itemsOf(inColour, 'line-Line_3')[0]).toMatchObject({ stroke: { colour: '#111827' } });
  });

  it('marks a limit without colour when asked: a heavier line, and a triangle by the bus', () => {
    const overloaded: PflowResult = {
      ...pflow,
      bus_voltages: { ...pflow.bus_voltages, '3': 1.2, '10': 1.0 },
      line_flows: {
        ...pflow.line_flows,
        Line_1: lineFlow(120, 4, { from: 1, to: 2 }, { rate_a: 100, loading_pct: 120 }),
        Line_2: lineFlow(95, 4, { from: 1, to: 5 }, { rate_a: 100, loading_pct: 95 }),
      },
    };
    const found = { ...source, pflow: overloaded };
    const plain = figureOf(found);
    const marked = figureOf(found, { limitMarks: true });
    const widthOf = (figure: typeof plain, id: string): number =>
      (itemsOf(figure, id)[0] as PathItem).stroke!.width;
    expect(widthOf(plain, 'line-Line_1')).toBe(1.5);
    expect(widthOf(marked, 'line-Line_1')).toBe(3);
    expect(widthOf(marked, 'line-Line_2')).toBe(2.25);
    expect(widthOf(marked, 'line-Line_3')).toBe(1.5);
    // The triangle: a closed path of three corners, filled where the limit is passed.
    const triangle = (figure: typeof plain) =>
      itemsOf(figure, 'label:3').filter(
        (item): item is PathItem => item.kind === 'path' && item.steps.length === 4,
      );
    expect(triangle(plain)).toEqual([]);
    expect(triangle(marked)).toHaveLength(1);
    expect(triangle(marked)[0]!.fill).toBe('#000000');
    // A bus in the clear gets none.
    expect(itemsOf(marked, 'label:10').filter((item) => item.kind === 'path')).toEqual([]);
    // And it stays in the room of the label.
    const label = figurePicture(found, true).busLabels.get('3')!;
    for (const item of itemsOf(marked, 'label:3'))
      expect(within(itemBox(item), label.box)).toBe(true);
  });

  it('draws the lines, the connectors and the symbols as heavy as asked, and the outlines lighter', () => {
    // Half as heavy as a line, and never too light to print.
    for (const [lineWidth, outlineWidth] of [
      [2.5, 1.25],
      [1.5, 0.75],
      [0.75, 0.5],
      [0.5, 0.5],
    ] as const) {
      const figure = figureOf(source, { lineWidth });
      expect((itemsOf(figure, 'line-Line_1')[0] as PathItem).stroke!.width).toBe(lineWidth);
      expect((itemsOf(figure, 'stub-load-PQ_1')[0] as PathItem).stroke!.width).toBe(lineWidth);
      const [outline, ...symbol] = itemsOf(figure, 'load-PQ_1');
      expect(outline).toMatchObject({ kind: 'rect', stroke: { width: outlineWidth } });
      expect((symbol[0] as PathItem).stroke).toMatchObject({ width: lineWidth, cap: 'round' });
    }
  });

  it('sets the text in the font and the size asked for, or in what its room allows', () => {
    const asked = figureOf(source, { font: 'serif', fontSize: 8 });
    expect(new Set(texts(asked.items).map((item) => item.font))).toEqual(new Set(['serif']));
    expect(asked.textSizes).toMatchObject({ bus: 8, device: 8, readout: 8, flow: 8 });
    // The chips of a unit are set smaller than the labels.
    expect(asked.textSizes.chip).toBe(6.4);

    // A label of three lines hangs in 36 px, and a readout of two stands in 22.
    const large = figureOf(source, { fontSize: 12 });
    expect(large.textSizes).toMatchObject({ bus: 10, device: 11, readout: 9.5, flow: 12 });
    for (const item of texts(itemsOf(large, 'label:1'))) expect(item.size).toBe(10);
    // With the values off, the name of a bus has the room of the whole label.
    const names = figureOf(source, { fontSize: 12, voltages: false, angles: false });
    expect(names.textSizes.bus).toBe(12);
    expect(figureOf(source, { fontSize: 16, voltages: false, angles: false }).textSizes.bus).toBe(
      16,
    );
    // And with no value on the figure at all, in the room the diagram then keeps for a name.
    const bare = figureOf(sourceOf(diagram, null), { fontSize: 16 });
    expect(bare.textSizes.bus).toBeGreaterThan(11);
    expect(bare.textSizes.bus).toBeLessThan(12);
    expect(bare.drawnKinds.sort()).toEqual(['bus', 'chip', 'device']);
  });

  it('sets a text that is too long for its room narrower, and never wider than its font makes it', () => {
    // A load renamed after its box was sized, as an edit of its name leaves
    // it until the diagram is drawn again: the name has the box of `PQ_1`.
    const renamed = {
      ...source,
      nodes: source.nodes.map((n) =>
        n.id === 'load-PQ_1' ? { ...n, data: { ...n.data, name: 'FEEDER NORTH 12' } } : n,
      ),
    };
    const node = renamed.nodes.find((n) => n.id === 'load-PQ_1')!;
    const figure = figureOf(renamed, { font: 'mono' });
    const name = texts(itemsOf(figure, 'load-PQ_1')).find(
      (item) => item.text === 'FEEDER NORTH 12',
    )!;
    // Courier would set it 90 px wide; it is drawn in the box, which is under half of that.
    expect(textWidth(name.text, 'mono', name.size)).toBe(90);
    expect(name.width).toBe(node.initialWidth! - 6);
    expect(name.width).toBeLessThan(45);
    expect(itemBox(name).x).toBeGreaterThan(node.position.x);
    expect(itemBox(name).x + itemBox(name).width).toBeLessThan(
      node.position.x + node.initialWidth!,
    );
    // No text of a figure is ever set wider than its font makes it.
    for (const item of texts(figure.items)) {
      expect(item.width).toBeLessThanOrEqual(textWidth(item.text, item.font, item.size) + 1e-9);
      expect(item.width).toBeGreaterThan(0);
    }
    expect(describeOverlaps(findOverlaps(figureAsDrawn(figure, renamed)))).toEqual([]);

    // The name of a bus needs no narrowing: its label is as wide as its name.
    const long = {
      ...source,
      nodes: source.nodes.map((n) =>
        n.id === '3' ? { ...n, data: { ...n.data, name: 'A VERY LONG NAME OF A SUBSTATION' } } : n,
      ),
    };
    const busName = texts(itemsOf(figureOf(long, { font: 'mono' }), 'label:3'))[0]!;
    expect(busName.width).toBe(textWidth(busName.text, 'mono', busName.size));
    expect(within(itemBox(busName), figurePicture(long, true).busLabels.get('3')!.box)).toBe(true);
  });

  it('shows each kind of label, or leaves it off', () => {
    const all = said(figureOf(source).items);
    const kinds = {
      busNames: /^BUS\d+$/,
      deviceNames: /^(PQ_\d+|Shunt_\d|[1-5])$/,
      chips: /^(SG|AVR|GOV)$/,
      voltages: / pu$/,
      angles: /°$/,
      flows: /^-?\d+\.\d\d MW$/,
      powers: /^-?\d+\.\d (MW|MVAr)$/,
    } as const;
    for (const [setting, pattern] of Object.entries(kinds)) {
      expect(all.filter((t) => pattern.test(t)).length, setting).toBeGreaterThan(4);
      const without = said(figureOf(source, { [setting]: false }).items);
      expect(
        without.filter((t) => pattern.test(t)),
        setting,
      ).toEqual([]);
      // And nothing else goes with it.
      for (const [other, otherPattern] of Object.entries(kinds)) {
        if (other === setting) continue;
        expect(
          without.filter((t) => otherPattern.test(t)).length,
          `${other} without ${setting}`,
        ).toBe(all.filter((t) => otherPattern.test(t)).length);
      }
    }
    expect(all.filter((t) => kinds.busNames.test(t))).toHaveLength(14);
    expect(all.filter((t) => kinds.voltages.test(t)).length).toBeLessThanOrEqual(14);
  });

  it('draws the arrow of a flow with its label, on its own line, and neither without the flows', () => {
    const figure = figureOf(source);
    const arrows = figure.items.filter((item) => item.of.startsWith('arrow:'));
    expect(arrows.length).toBeGreaterThan(10);
    const picture = figurePicture(source, true);
    const widths = valueLabelWidths(source.nodes, source.edges, pflow);
    for (const arrow of arrows) {
      const edgeId = arrow.of.slice('arrow:'.length);
      const box = itemBox(arrow);
      const middle: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
      // On a run of its own route.
      const points = picture.connections.routes.get(edgeId)!.points;
      const onRoute = points.some((point, i) => {
        if (i === 0) return false;
        const [a, b] = [points[i - 1]!, point];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t =
          ((middle[0] - a[0]) * (b[0] - a[0]) + (middle[1] - a[1]) * (b[1] - a[1])) / length ** 2;
        const off = Math.hypot(
          a[0] + t * (b[0] - a[0]) - middle[0],
          a[1] + t * (b[1] - a[1]) - middle[1],
        );
        return t >= 0 && t <= 1 && off < 1.5;
      });
      expect(onRoute, arrow.of).toBe(true);
      // Clear of its own label where that stands on the line: the patch of
      // paper under the label would otherwise take the arrow out.
      const at = picture.labelPlaces.get(edgeId);
      if (at === undefined || at.hidden === true || at.label !== undefined) continue;
      const label = labelBoxAt(at, widths.flows.get(edgeId)!, LINE_LABEL_BOX.height);
      const apart =
        box.x >= label.right ||
        box.x + box.width <= label.left ||
        box.y >= label.bottom ||
        box.y + box.height <= label.top;
      expect(apart, arrow.of).toBe(true);
    }
    const without = figureOf(source, { flows: false });
    expect(without.items.filter((item) => /^(arrow|flow):/.test(item.of))).toEqual([]);
  });

  it('counts the values that have no place on the diagram, and draws none of them', () => {
    const figure = figureOf(source);
    const picture = figurePicture(source, true);
    const compact = [...picture.busLabels].filter(([, label]) => label.compact === true);
    const dropped = [...picture.readouts].filter(([, place]) => place.spot === 'none');
    const hidden = [...picture.labelPlaces].filter(([, place]) => place.hidden === true);
    expect(figure.leftOff).toBe(compact.length + dropped.length + hidden.length);
    for (const [id] of compact) expect(texts(itemsOf(figure, `label:${id}`))).toHaveLength(1);
    for (const [id] of dropped) expect(itemsOf(figure, `readout:${id}`)).toEqual([]);
    for (const [id] of hidden) expect(itemsOf(figure, `flow:${id}`)).toEqual([]);
    // Nothing is left off a figure that asks for none of them.
    expect(
      figureOf(source, { voltages: false, angles: false, flows: false, powers: false }).leftOff,
    ).toBe(0);
    expect(figureOf(sourceOf(diagram, null)).leftOff).toBe(0);
  });

  it('shows no value of a power flow that did not converge, or before one', () => {
    for (const none of [null, { ...pflow, converged: false }]) {
      const before = { ...source, pflow: none };
      expect(figureShowsValues(before, DEFAULT_FIGURE_SETTINGS)).toBe(false);
      const words = said(figureOf(before).items);
      expect(words.filter((t) => /( pu|°| MW| MVAr)$/.test(t))).toEqual([]);
      expect(words.filter((t) => /^BUS\d+$/.test(t))).toHaveLength(14);
    }
  });

  it('reads a voltage in kV where the diagram does', () => {
    const rated = {
      ...source,
      unitMode: 'actual' as const,
      nodes: source.nodes.map((n) =>
        n.id === '1' ? { ...n, data: { ...n.data, baseKv: 69 } } : n,
      ),
    };
    const words = said(itemsOf(figureOf(rated), 'label:1'));
    expect(words.some((t) => / kV$/.test(t))).toBe(true);
    expect(words.some((t) => / pu$/.test(t))).toBe(false);
    // A bus the case rates at nothing stays in pu.
    expect(said(itemsOf(figureOf(rated), 'label:2')).some((t) => / pu$/.test(t))).toBe(true);
  });
});

describe('a figure of a part of the diagram', () => {
  it('takes the devices of the picked buses along, and the lines that run between two of them', async () => {
    const diagram = await opened(IEEE14);
    const source = sourceOf(diagram, solved(diagram));
    const only = figureScope(source.nodes, new Set(['1', '2', '5']));
    // Bus 1 has a generator; bus 2 a generator and a load; bus 5 a load.
    expect([...only].sort()).toEqual([
      '1',
      '2',
      '5',
      'generator-1',
      'generator-2',
      'load-PQ_1',
      'load-PQ_4',
    ]);

    const figure = drawFigure(source, figurePicture(source, true), DEFAULT_FIGURE_SETTINGS, only);
    expect(figure.shown).toBe(7);
    const names = said(figure.items).filter((t) => /^BUS\d+$/.test(t));
    expect(names.sort()).toEqual(['BUS1', 'BUS2', 'BUS5']);
    // Lines 1-2, 1-5 and 2-5, and the four connectors; nothing that leaves the part.
    const drawnEdges = figure.items
      .filter((item) => item.kind === 'path' && /^(line|transformer|stub)-/.test(item.of))
      .map((item) => item.of)
      .sort();
    expect(drawnEdges).toEqual([
      'line-Line_1',
      'line-Line_2',
      'line-Line_5',
      'stub-generator-1',
      'stub-generator-2',
      'stub-load-PQ_1',
      'stub-load-PQ_4',
    ]);
    // A bar has a dot for each line that is drawn to it, and none for one that is not.
    expect(itemsOf(figure, 'tap:1')).toHaveLength(3);
    const whole = figureOf(source);
    expect(itemsOf(whole, 'tap:2').length).toBeGreaterThan(itemsOf(figure, 'tap:2').length);
    // And it is as large as the part, not as the diagram.
    expect(figure.box.height).toBeLessThan(whole.box.height);
    // What is drawn of the part is drawn where it is on the whole.
    for (const id of only) expect(itemsOf(figure, id)).toEqual(itemsOf(whole, id));
  });

  it('shows the whole diagram with nothing picked out, and nothing with nothing to draw', async () => {
    const diagram = await opened(WSCC9);
    const source = sourceOf(diagram);
    expect(figureOf(source, {}, null).shown).toBe(15);
    const empty = figureOf({ ...source, nodes: [], edges: [] });
    expect(empty).toMatchObject({ items: [], shown: 0, leftOff: 0 });
    expect(empty.box).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('a generating unit and a controller on a figure', () => {
  it('draws the control chain of a unit that has it drawn out, in the box the picture gives it', async () => {
    const diagram = await opened(KUNDUR, {
      unitStates: new Map([['1', { expanded: true, bus: null }]]),
    });
    const source = sourceOf(diagram);
    const figure = figureOf(source);
    const chain = figurePicture(source, false).chains.get('generator-1')!;
    const items = itemsOf(figure, 'chain:generator-1');
    expect(items[0]).toMatchObject({
      kind: 'rect',
      x: chain.box.left,
      y: chain.box.top,
      width: chain.box.right - chain.box.left,
      height: chain.box.bottom - chain.box.top,
    });
    // A row for the generator, its machine and its governor.
    expect(said(items).filter((t) => /^(Slack|GENROU|TGOV1) 1$/.test(t))).toHaveLength(3);
    for (const item of items) expect(within(itemBox(item), chain.box, 0.4)).toBe(true);
    expect(itemsOf(figure, 'chain:generator-2')).toEqual([]);
    expect(describeOverlaps(findOverlaps(figureAsDrawn(figure, source)))).toEqual([]);
  });

  it('draws the badge of a controller that stands on its own, with its tether, unless they are left off', async () => {
    const diagram = await opened({
      ...WSCC9,
      controllers: [{ idx: 'PMU_1', name: 'PMU_1', kind: 'PMU', params: { bus: 5 } }],
    });
    const badge = diagram.nodes.find((n) => n.type === 'controller')!;
    expect(badge).toBeDefined();
    const source = sourceOf(diagram);
    const figure = figureOf(source);
    const items = itemsOf(figure, badge.id);
    expect(items[0]).toMatchObject({ kind: 'rect', x: badge.position.x, y: badge.position.y });
    expect(said(items)).toEqual(['PMU_1']);
    // The gauge of a measurement, in the badge.
    expect(items.filter((item) => item.kind === 'path').length).toBe(2);
    expect(itemsOf(figure, `tether:${badge.id}`)[0]).toMatchObject({
      kind: 'path',
      stroke: { dash: [2, 2] },
    });
    const without = figureOf(source, { chips: false });
    expect(itemsOf(without, badge.id)).toEqual([]);
    expect(itemsOf(without, `tether:${badge.id}`)).toEqual([]);
    // It is no bus and no device of the count.
    expect(figure.shown).toBe(15);
  });
});
