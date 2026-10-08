/**
 * A figure of the diagram: the same picture the canvas draws
 * (`picture.ts`), in the style of a figure for a paper.
 *
 * `figurePicture` works the picture out from the nodes where they stand and
 * the edges with the routes kept for them, exactly as the canvas does, and
 * `drawFigure` turns it into a list of plain shapes and texts
 * (`displayList.ts`). Nothing is placed here: every line runs along its
 * route, every bar is as long as the picture has it, every symbol stands in
 * the box of its node, and every label is set inside the box the picture
 * keeps for it. So what the picture holds to (nothing on the diagram is
 * drawn over anything else) holds for the figure, and a text is held to its
 * box whatever it says: one too long for it is set narrower
 * (`fittedWidth`), and each kind of text is set no larger than the lines of
 * its box have room for.
 *
 * The one thing the picture keeps no room for is the arrow of a flow, which
 * the canvas draws at the place of the label, or half way along a line whose
 * label has none. The figure draws it last, among everything else, and only
 * where it is clear of all of it (`flowArrow.ts`): there, or at the nearest
 * place along its line that is.
 *
 * What a figure leaves out is what belongs to the screen: the selection,
 * the handles of a line that is being moved, the control that draws a chain
 * out, the highlight of a device that is being dragged. What it draws
 * otherwise is chosen (`FigureSettings`): black on white or in the colours
 * of the diagram, how heavy the lines are, the font, and which labels show.
 *
 * Pure: nothing read but the arguments.
 */
import type { PflowResult } from '@/api/types';
import type { ControllerSubKind } from '@/lib/controllers';
import { unitChipLabel, type UnitMemberInfo } from '@/lib/generatingUnits';
import { voltageDisplay, type UnitMode } from '@/lib/units';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_DOT_RADIUS,
  TRANSFORMER_SYMBOL_SIZE,
  labelBoxAt,
  routeMidpoint,
  type ConnectionEdge,
  type ConnectorStyle,
  type NodeSize,
  type Rect,
} from '../connections';
import { arrowSizeFromMw, maxAbsFlowMw } from '../edges/lineFlowArrowMath';
import { unitChips, unitMoreLabel, type UnitNodeData } from '../graph';
import { LINE_LABEL_BOX, limitMarkerBox, type LabelNode } from '../labels';
import type { LoadingBand } from '../loading';
import {
  getBusOverlayState,
  getDeviceOverlayState,
  getGeneratorLimitState,
  getLineOverlayState,
} from '../overlay';
import { pictureOf, type Picture } from '../picture';
import { qLimitMarker } from '../qLimit';
import { pflowKeyOf, valueLabelWidths } from '../valueWidths';
import type { VoltageBand, VoltageLimits, VoltageSide } from '../voltage';
import {
  boxAround,
  fittedWidth,
  itemBox,
  polyline,
  type Figure,
  type FigureColour,
  type FigureItem,
  type Stroke,
} from './displayList';
import { showsValues, type FigureSettings } from './figureSettings';
import { arrowCorners, placeArrow } from './flowArrow';
import { CAP_HEIGHT } from './fontMetrics';
import { controllerSymbol, placeSteps, symbolForModel, type FigureSymbol } from './symbols';

/** The diagram a figure is made of, as the canvas holds it. */
export interface FigureSource {
  /** The nodes where they stand, with the data the canvas built them with. */
  nodes: readonly LabelNode[];
  /** The edges, with the routes the diagram keeps for them. */
  edges: readonly ConnectionEdge[];
  /** The size each node was measured at; one without is taken at its size hint. */
  sizes?: ReadonlyMap<string, NodeSize>;
  connectorStyle?: ConnectorStyle;
  barLengths?: ReadonlyMap<string, number>;
  /** The power flow whose values the figure shows; `null` before one. */
  pflow: PflowResult | null;
  /** Whether a voltage reads in pu or in kV. */
  unitMode?: UnitMode;
}

/** The kinds of text of a figure; each is set in one size. */
export type TextKind = 'bus' | 'device' | 'readout' | 'flow' | 'chip' | 'chain';

export interface DrawnFigure extends Figure {
  /** The size each kind of text is set in: the size asked for, or what its room allows. */
  textSizes: Record<TextKind, number>;
  /**
   * How many values asked for are not shown, because the diagram has no
   * place for them that is clear of everything else: the voltage and angle
   * of a bus whose label has room for its name alone, the P and Q of a
   * device, the flow of a line. They are left off the canvas as well.
   */
  leftOff: number;
  /** How many buses and devices the figure shows. */
  shown: number;
  /** The kinds of text the figure has any of. */
  drawnKinds: TextKind[];
}

/** The room a figure keeps round what it draws. */
export const FIGURE_MARGIN = 12;

/** How far apart the lines of a label are set, as a multiple of the text size. */
const LEADING = 1.2;
/** The same for the two lines of a readout, which the diagram sets tighter. */
const READOUT_LEADING = 1.15;
/** The gap between a bar and the label that hangs under it, and the padding of a label. */
const LABEL_GAP = 4;
/** The most a text is set in, by kind, where its room is always the same. */
const SIZE_LIMIT = { device: 11, flow: 12.5, chip: 8.5, chain: 10.8 } as const;

/** The colours a figure is drawn in. */
interface Palette {
  ink: FigureColour;
  /** The second line of a label (an angle, a Q). */
  muted: FigureColour;
  paper: FigureColour;
  warning: FigureColour;
  danger: FigureColour;
}

const MONOCHROME: Palette = {
  ink: '#000000',
  muted: '#000000',
  paper: '#ffffff',
  warning: '#000000',
  danger: '#000000',
};

const COLOUR: Palette = {
  ink: '#111827',
  muted: '#4b5563',
  paper: '#ffffff',
  warning: '#b45309',
  danger: '#b91c1c',
};

/** Whether the values of `source`'s power flow are on a figure drawn with `settings`. */
export function figureShowsValues(source: FigureSource, settings: FigureSettings): boolean {
  return source.pflow?.converged === true && showsValues(settings);
}

/**
 * The picture a figure of `source` is drawn from, with the values of the
 * power flow on it or without. It is the picture the canvas draws of the
 * same diagram, made the same way.
 */
export function figurePicture(source: FigureSource, values: boolean): Picture<ConnectionEdge> {
  return pictureOf(source.nodes, source.edges, {
    sizes: source.sizes,
    connectorStyle: source.connectorStyle,
    barLengths: source.barLengths,
    values,
    labelWidths: values ? valueLabelWidths(source.nodes, source.edges, source.pflow) : undefined,
  });
}

/**
 * The nodes a figure of the picked nodes `picked` shows: those, and the
 * generators, loads and shunts of the buses among them, which a bus is not
 * drawn without.
 */
export function figureScope(nodes: readonly LabelNode[], picked: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    const parent = n.data?.parentBus;
    if (picked.has(n.id) || (typeof parent === 'string' && picked.has(parent))) out.add(n.id);
  }
  // A badge goes with what it is docked to.
  for (const n of nodes) {
    const dock = n.data?.parentNodeId;
    if (n.type === 'controller' && typeof dock === 'string' && out.has(dock)) out.add(n.id);
  }
  return out;
}

interface NodeData {
  idx?: string;
  name?: string;
  kind?: string;
  symbolKind?: string;
  unit?: UnitNodeData;
  voltageLimits?: VoltageLimits;
  baseKv?: number;
  subKind?: ControllerSubKind;
  orphan?: boolean;
  connectorDx?: number;
  connectorDy?: number;
}

interface EdgeData {
  idx?: string;
  bucket?: string;
  winding?: '2w' | '3w';
}

/**
 * Draw the figure of `source` from its `picture` (`figurePicture`, made
 * with `figureShowsValues`). `only`, when given, is the set of nodes it
 * shows (`figureScope`): a line is drawn where both its ends are among them.
 */
export function drawFigure(
  source: FigureSource,
  picture: Picture<ConnectionEdge>,
  settings: FigureSettings,
  only: ReadonlySet<string> | null = null,
): DrawnFigure {
  const palette = settings.monochrome ? MONOCHROME : COLOUR;
  const { pflow } = source;
  const values = figureShowsValues(source, settings);
  const sizes = source.sizes ?? new Map<string, NodeSize>();
  const { connections } = picture;
  const inScope = (id: string): boolean => only === null || only.has(id);
  const nodes = source.nodes.filter((n) => inScope(n.id));
  const nodeById = new Map(source.nodes.map((n) => [n.id, n]));
  const isBus = (n: LabelNode | undefined): boolean =>
    n !== undefined && (n.type ?? 'bus') === 'bus';
  const edges = picture.edges.filter((e) => inScope(e.source) && inScope(e.target));

  const line = settings.lineWidth;
  // The outline of a box is lighter than a conductor, so that the lines of
  // the network are what the eye follows.
  const outline: Stroke = { colour: palette.ink, width: Math.max(0.5, line / 2) };
  const bandColour = (band: VoltageBand | LoadingBand): FigureColour =>
    band === 'danger' ? palette.danger : band === 'warning' ? palette.warning : palette.ink;

  // ---- what each kind of text is set in -----------------------------------

  const busRows = new Map<string, { text: string; colour: FigureColour }[]>();
  const busMarks = new Map<string, { band: VoltageBand; side: VoltageSide }>();
  let leftOff = 0;
  let busLimit = Infinity;
  for (const n of nodes) {
    if (!isBus(n)) continue;
    const label = picture.busLabels.get(n.id);
    if (label === undefined) continue;
    const data = (n.data ?? {}) as NodeData;
    const overlay = getBusOverlayState(
      String(data.idx ?? n.id),
      pflow,
      false,
      data.voltageLimits,
      voltageDisplay(source.unitMode ?? 'pu', data.baseKv),
    );
    const rows: { text: string; colour: FigureColour }[] = [];
    if (settings.busNames) {
      rows.push({ text: String(data.name || data.idx || n.id), colour: palette.ink });
    }
    const voltage = values && settings.voltages ? overlay.voltage_label : null;
    const angle = values && settings.angles ? overlay.angle_label : null;
    if (label.compact === true) {
      if (voltage !== null || angle !== null) leftOff += 1;
    } else {
      if (voltage !== null) rows.push({ text: voltage, colour: palette.ink });
      if (angle !== null) rows.push({ text: angle, colour: palette.muted });
    }
    if (rows.length === 0) continue;
    busRows.set(n.id, rows);
    if (settings.limitMarks && overlay.side !== null) {
      busMarks.set(n.id, { band: overlay.band, side: overlay.side });
    }
    const height = label.box.bottom - label.box.top - LABEL_GAP;
    busLimit = Math.min(busLimit, height / rows.length / LEADING);
  }

  const readoutRows = new Map<string, { text: string; colour: FigureColour }[]>();
  let readoutLimit = Infinity;
  if (values && settings.powers) {
    for (const n of nodes) {
      if (n.type !== 'generator' && n.type !== 'load') continue;
      const overlay = getDeviceOverlayState(n.type, pflowKeyOf(n), pflow);
      const rows: { text: string; colour: FigureColour }[] = [];
      if (overlay.p_label !== null) rows.push({ text: overlay.p_label, colour: palette.ink });
      if (overlay.q_label !== null) rows.push({ text: overlay.q_label, colour: palette.muted });
      if (rows.length === 0) continue;
      const place = picture.readouts.get(n.id);
      if (place === undefined || place.spot === 'none') {
        leftOff += 1;
        continue;
      }
      readoutRows.set(n.id, rows);
      const height = place.box.bottom - place.box.top;
      readoutLimit = Math.min(readoutLimit, height / rows.length / READOUT_LEADING);
    }
  }

  const tenth = (size: number): number => Math.floor(size * 10 + 1e-6) / 10;
  const asked = settings.fontSize;
  const textSizes: Record<TextKind, number> = {
    bus: tenth(Math.min(asked, busLimit)),
    device: tenth(Math.min(asked, SIZE_LIMIT.device)),
    readout: tenth(Math.min(asked, readoutLimit)),
    flow: tenth(Math.min(asked, SIZE_LIMIT.flow)),
    chip: tenth(Math.min(asked * 0.8, SIZE_LIMIT.chip)),
    chain: tenth(Math.min(asked * 0.9, SIZE_LIMIT.chain)),
  };
  const cap = CAP_HEIGHT[settings.font];

  // ---- the layers, each painted over the ones before it --------------------

  const lines: FigureItem[] = [];
  // The points each of them runs through: what an arrow is kept clear of.
  const drawnLines: { of: string; points: readonly (readonly [number, number])[] }[] = [];
  const arrows: FigureItem[] = [];
  const bars: FigureItem[] = [];
  const dots: FigureItem[] = [];
  const symbols: FigureItem[] = [];
  const blocks: FigureItem[] = [];
  const labels: FigureItem[] = [];
  const drawnKinds = new Set<TextKind>();

  /** A text of `kind`, hung at (`x`, `y`) and held to `room`. */
  const text = (
    into: FigureItem[],
    of: string,
    kind: TextKind,
    content: string,
    x: number,
    y: number,
    anchor: 'start' | 'middle' | 'end',
    room: number,
    colour: FigureColour = palette.ink,
    rotate?: number,
  ): number => {
    const size = textSizes[kind];
    const width = fittedWidth(content, settings.font, size, room);
    drawnKinds.add(kind);
    into.push({
      kind: 'text',
      of,
      text: content,
      x,
      y,
      anchor,
      font: settings.font,
      size,
      colour,
      width,
      ...(rotate === undefined ? {} : { rotate }),
    });
    return width;
  };
  /** The baseline that puts the capitals of a text of `kind` about the level `middle`. */
  const baselineAt = (middle: number, kind: TextKind): number =>
    middle + (cap * textSizes[kind]) / 2;

  /** The shapes of `symbol`, its box `size` across with its corner at (`x`, `y`). */
  const drawSymbol = (
    into: FigureItem[],
    of: string,
    symbol: FigureSymbol,
    x: number,
    y: number,
    size: number,
    colour: FigureColour = palette.ink,
  ): void => {
    const scale = size / symbol.width;
    for (const shape of symbol.shapes) {
      into.push({
        kind: 'path',
        of,
        steps: placeSteps(shape.steps, x, y, scale),
        ...(shape.weight > 0
          ? {
              stroke: {
                colour,
                width: line * shape.weight * Math.min(1, scale * 1.4),
                cap: 'round',
              },
            }
          : {}),
        ...(shape.filled ? { fill: colour } : {}),
      });
    }
  };

  /** The triangle of a limit, in `box`: up at an upper limit, filled when past it. */
  const drawMark = (
    into: FigureItem[],
    of: string,
    box: Rect,
    band: VoltageBand,
    side: VoltageSide,
  ): void => {
    const inset = 0.75;
    const [left, right] = [box.left + inset, box.right - inset];
    const [top, bottom] = [box.top + inset, box.bottom - inset];
    const middle = (left + right) / 2;
    const points: [number, number][] =
      side === 'high'
        ? [
            [middle, top],
            [right, bottom],
            [left, bottom],
          ]
        : [
            [middle, bottom],
            [right, top],
            [left, top],
          ];
    into.push({
      kind: 'path',
      of,
      steps: [...polyline(points), { op: 'Z' }],
      stroke: { colour: palette.ink, width: 1 },
      fill: band === 'danger' ? palette.danger : palette.paper,
    });
  };

  // ---- lines, connectors and what stands on them ---------------------------

  const flowScale = pflow?.line_flows ? maxAbsFlowMw(pflow.line_flows) : undefined;
  // The room the picture gave each flow label (`figurePicture`).
  const flowWidths = values ? valueLabelWidths(source.nodes, source.edges, pflow).flows : undefined;
  const tapped = new Set<string>();
  // The arrows of the flows are placed last, among everything else that is drawn.
  const flowArrows: {
    id: string;
    points: readonly (readonly [number, number])[];
    prefer: { x: number; y: number };
    size: number;
    forward: boolean;
    label: Rect | null;
  }[] = [];
  for (const edge of edges) {
    const route = connections.routes.get(edge.id);
    if (route === undefined || route.points.length < 2) continue;
    const data = (edge.data ?? {}) as EdgeData;
    const isStub = edge.type === 'stub';
    const overlay = !isStub && data.idx !== undefined ? getLineOverlayState(data.idx, pflow) : null;
    const band: LoadingBand = overlay?.has_data ? overlay.loading_band : 'neutral';
    const heavier = settings.limitMarks
      ? band === 'danger'
        ? 2
        : band === 'warning'
          ? 1.5
          : 1
      : 1;
    lines.push({
      kind: 'path',
      of: edge.id,
      steps: polyline(route.points),
      stroke: { colour: bandColour(band), width: line * heavier },
    });
    drawnLines.push({ of: edge.id, points: route.points });
    // Where it lands on a bar, the dot of its tap.
    const ends: [string, readonly [number, number]][] = [
      [edge.source, route.points[0]!],
      [edge.target, route.points[route.points.length - 1]!],
    ];
    for (const [nodeId, [x, y]] of ends) {
      if (!isBus(nodeById.get(nodeId))) continue;
      const key = `${nodeId}|${x.toFixed(1)}|${y.toFixed(1)}`;
      if (tapped.has(key)) continue;
      tapped.add(key);
      dots.push({
        kind: 'circle',
        of: `tap:${nodeId}`,
        cx: x,
        cy: y,
        r: TAP_DOT_RADIUS,
        fill: palette.ink,
      });
    }
    if (isStub) continue;
    const at = picture.labelPlaces.get(edge.id);
    if (edge.type === 'transformer') {
      const place = at ?? routeMidpoint(route.points);
      drawTransformer(symbols, `symbol:${edge.id}`, place, data.winding === '3w', {
        colour: bandColour(band),
        width: line * heavier,
      });
      continue;
    }
    if (!values || !settings.flows || overlay === null || !overlay.has_data) continue;
    // The label, where the picture has a place for it, and the box it takes there.
    const labelled = overlay.p_label !== null && at !== undefined && at.hidden !== true;
    const labelBox = labelled
      ? labelBoxAt(at, flowWidths?.get(edge.id) ?? LINE_LABEL_BOX.width, LINE_LABEL_BOX.height)
      : null;
    if (overlay.direction !== 'neutral') {
      const magnitude = Math.abs(pflow?.line_flows?.[data.idx ?? '']?.p ?? 0);
      flowArrows.push({
        id: edge.id,
        points: route.points,
        // Where the canvas draws it: at the place of the label, or half way along.
        prefer: at ?? routeMidpoint(route.points),
        size: arrowSizeFromMw(magnitude, flowScale),
        forward: overlay.direction === 'forward',
        // A label that stands on its line stands where the arrow would: the
        // arrow is then drawn on the line right beside it.
        label: labelBox !== null && at?.label === undefined ? labelBox : null,
      });
    }
    if (overlay.p_label === null) continue;
    if (labelBox === null || at === undefined) {
      leftOff += 1;
      continue;
    }
    const box = labelBox;
    const content =
      overlay.loading_label === null
        ? overlay.p_label
        : `${overlay.p_label} ${overlay.loading_label}`;
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const turned = at.turned === true;
    const size = textSizes.flow;
    const room = (turned ? box.bottom - box.top : box.right - box.left) - 6;
    const drawn = fittedWidth(content, settings.font, size, room);
    // A label that stands on its line has the line under it: a patch of
    // paper as large as the text takes the line out from behind it.
    const [patchWidth, patchHeight] = [drawn + 4, size + 2];
    labels.push({
      kind: 'rect',
      of: `flow:${edge.id}`,
      x: cx - (turned ? patchHeight : patchWidth) / 2,
      y: cy - (turned ? patchWidth : patchHeight) / 2,
      width: turned ? patchHeight : patchWidth,
      height: turned ? patchWidth : patchHeight,
      fill: palette.paper,
    });
    if (turned) {
      text(
        labels,
        `flow:${edge.id}`,
        'flow',
        content,
        cx + (cap * size) / 2,
        cy,
        'middle',
        room,
        palette.ink,
        -90,
      );
    } else {
      text(labels, `flow:${edge.id}`, 'flow', content, cx, baselineAt(cy, 'flow'), 'middle', room);
    }
  }

  // ---- buses, devices and badges -------------------------------------------

  let shown = 0;
  for (const n of nodes) {
    const { x, y } = n.position;
    const data = (n.data ?? {}) as NodeData;
    if (isBus(n)) {
      shown += 1;
      const bar = connections.bars.get(n.id);
      const start = bar?.start ?? 0;
      const end = bar?.end ?? BAR_LENGTH;
      const { band } = getBusOverlayState(
        String(data.idx ?? n.id),
        pflow,
        false,
        data.voltageLimits,
      );
      bars.push({
        kind: 'rect',
        of: n.id,
        x: x + start,
        y,
        width: end - start,
        height: BAR_THICKNESS,
        fill: bandColour(band),
      });
      const rows = busRows.get(n.id);
      const label = picture.busLabels.get(n.id);
      if (rows === undefined || label === undefined) continue;
      drawBusLabel(n.id, rows, label.box, label.side, busMarks.get(n.id));
      continue;
    }
    const measured = sizes.get(n.id);
    const width = measured?.width ?? n.initialWidth ?? 0;
    const height = measured?.height ?? n.initialHeight ?? 0;
    if (n.type === 'controller') {
      if (settings.chips) drawController(n.id, data, x, y, width, height);
      continue;
    }
    shown += 1;
    blocks.push({
      kind: 'rect',
      of: n.id,
      x,
      y,
      width,
      height,
      radius: 3,
      fill: palette.paper,
      stroke: outline,
    });
    const cx = x + width / 2;
    drawSymbol(
      blocks,
      n.id,
      symbolForModel(String(data.symbolKind ?? data.kind ?? '')),
      cx - 12,
      y + 3,
      24,
    );
    if (settings.deviceNames) {
      // The line of the name: 9 px high, 3 px over the foot of the box.
      const name = String(data.name || data.idx || n.id);
      text(
        blocks,
        n.id,
        'device',
        name,
        cx,
        baselineAt(y + height - 7.5, 'device'),
        'middle',
        width - 6,
      );
    }
    if (data.unit !== undefined && settings.chips) drawChips(n.id, data.unit.members, cx, y + 3);
    if (settings.limitMarks && n.type === 'generator') {
      const { band, side } = qLimitMarker(getGeneratorLimitState(pflowKeyOf(n), pflow));
      const box = limitMarkerBox(n, sizes);
      if (side !== null && box !== null) drawMark(labels, `marker:${n.id}`, box, band, side);
    }
    const chain = picture.chains.get(n.id);
    if (chain !== undefined && data.unit !== undefined) {
      drawChain(n.id, data.unit.members, chain.box);
    }
    const rows = readoutRows.get(n.id);
    const place = picture.readouts.get(n.id);
    if (rows !== undefined && place !== undefined) drawReadout(n.id, rows, place.box, place.spot);
  }

  /** The two (or three) circles of a transformer, in line with the run they stand on. */
  function drawTransformer(
    into: FigureItem[],
    of: string,
    place: { x: number; y: number; angleDeg: number },
    threeWinding: boolean,
    stroke: Stroke,
  ): void {
    const turn = (place.angleDeg * Math.PI) / 180;
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    const at = (along: number, across: number): [number, number] => [
      place.x + along * cos - across * sin,
      place.y + along * sin + across * cos,
    ];
    // Well inside the room the diagram keeps for the symbol.
    const reach = TRANSFORMER_SYMBOL_SIZE / 2 - 1 - stroke.width / 2;
    const windings: { centre: [number, number]; r: number }[] = threeWinding
      ? ((r) => [
          { centre: at(-(reach - r), 0), r },
          { centre: at(reach - r - 1, -(reach - r)), r },
          { centre: at(reach - r - 1, reach - r), r },
        ])(Math.min(5, reach / 2))
      : ((r) => [
          { centre: at(-(r * 0.65), 0), r },
          { centre: at(r * 0.65, 0), r },
        ])(Math.min(6.5, reach / 1.65));
    // The line stops at the symbol: paper first, the windings over it.
    for (const { centre, r } of windings) {
      into.push({ kind: 'circle', of, cx: centre[0], cy: centre[1], r, fill: palette.paper });
    }
    for (const { centre, r } of windings) {
      into.push({ kind: 'circle', of, cx: centre[0], cy: centre[1], r, stroke });
    }
  }

  /** The lines of the label of a bus, in the box the picture keeps for it. */
  function drawBusLabel(
    id: string,
    rows: readonly { text: string; colour: FigureColour }[],
    box: Rect,
    side: string,
    mark: { band: VoltageBand; side: VoltageSide } | undefined,
  ): void {
    const size = textSizes.bus;
    const lead = size * LEADING;
    const block = rows.length * lead;
    const top =
      side === 'below'
        ? box.top + LABEL_GAP
        : side === 'above'
          ? box.bottom - block
          : (box.top + box.bottom - block) / 2;
    const anchor = side === 'east' ? 'start' : side === 'west' ? 'end' : 'middle';
    const hung =
      anchor === 'start'
        ? box.left + LABEL_GAP
        : anchor === 'end'
          ? box.right - LABEL_GAP
          : (box.left + box.right) / 2;
    const room = box.right - box.left - 2 * LABEL_GAP;
    rows.forEach((row, i) => {
      const middle = top + i * lead + lead / 2;
      // The limit mark stands after the first line, and takes its room from it.
      const marked = i === 0 && mark !== undefined;
      const markSize = Math.min(size * 0.75, 9);
      const drawn = text(
        labels,
        `label:${id}`,
        'bus',
        row.text,
        marked && anchor === 'middle'
          ? hung - (markSize + 2) / 2
          : marked && anchor === 'end'
            ? hung - markSize - 2
            : hung,
        baselineAt(middle, 'bus'),
        anchor,
        room - (marked ? markSize + 2 : 0),
        row.colour,
      );
      if (!marked) return;
      const textRight =
        anchor === 'start'
          ? hung + drawn
          : anchor === 'end'
            ? hung - markSize - 2
            : hung - (markSize + 2) / 2 + drawn / 2;
      drawMark(
        labels,
        `label:${id}`,
        {
          left: textRight + 2,
          right: textRight + 2 + markSize,
          top: middle - markSize / 2,
          bottom: middle + markSize / 2,
        },
        mark.band,
        mark.side,
      );
    });
  }

  /** The P and Q of a device, in the box the picture keeps for them. */
  function drawReadout(
    id: string,
    rows: readonly { text: string; colour: FigureColour }[],
    box: Rect,
    spot: string,
  ): void {
    const lead = textSizes.readout * READOUT_LEADING;
    const top = (box.top + box.bottom - rows.length * lead) / 2;
    // Towards the connector or the symbol it stands beside.
    const anchor =
      spot === 'right' || spot === 'east'
        ? 'start'
        : spot === 'left' || spot === 'west'
          ? 'end'
          : 'middle';
    const hung =
      anchor === 'start'
        ? box.left + LABEL_GAP
        : anchor === 'end'
          ? box.right - LABEL_GAP
          : (box.left + box.right) / 2;
    rows.forEach((row, i) => {
      text(
        labels,
        `readout:${id}`,
        'readout',
        row.text,
        hung,
        baselineAt(top + i * lead + lead / 2, 'readout'),
        anchor,
        box.right - box.left - 2 * LABEL_GAP,
        row.colour,
      );
    });
  }

  /**
   * The chips of a generating unit, a column either side of its symbol
   * (`UnitChips`): the first half of the models on the left, the rest on the
   * right. `top` is the top of the 24 px row the symbol stands in.
   */
  function drawChips(
    id: string,
    members: readonly UnitMemberInfo[],
    cx: number,
    top: number,
  ): void {
    const { chips, more } = unitChips(members);
    const texts = [...chips.map(unitChipLabel), ...(more > 0 ? [unitMoreLabel(more)] : [])];
    if (texts.length === 0) return;
    // As wide as the diagram takes the longest of them to be (`unitBoxSize`).
    const chipWidth = Math.max(...texts.map((t) => 4.8 * t.length + 6));
    const chipHeight = 11;
    const onLeft = Math.ceil(texts.length / 2);
    const columns: [string[], number][] = [
      [texts.slice(0, onLeft), cx - 12 - 3 - chipWidth],
      [texts.slice(onLeft), cx + 12 + 3],
    ];
    for (const [column, left] of columns) {
      const columnHeight = column.length * chipHeight + (column.length - 1) * 2;
      column.forEach((label, i) => {
        const chipTop = top + (24 - columnHeight) / 2 + i * (chipHeight + 2);
        blocks.push({
          kind: 'rect',
          of: id,
          x: left,
          y: chipTop,
          width: chipWidth,
          height: chipHeight,
          radius: 2,
          stroke: { ...outline, width: Math.min(outline.width, 0.75) },
        });
        text(
          blocks,
          id,
          'chip',
          label,
          left + chipWidth / 2,
          baselineAt(chipTop + chipHeight / 2, 'chip'),
          'middle',
          chipWidth - 3,
        );
      });
    }
  }

  /** The control chain of a unit, drawn out: a row per model, each set in under the one it refers to. */
  function drawChain(id: string, members: readonly UnitMemberInfo[], box: Rect): void {
    blocks.push({
      kind: 'rect',
      of: `chain:${id}`,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      radius: 3,
      fill: palette.paper,
      stroke: outline,
    });
    members.forEach((member, i) => {
      const middle = box.top + 3 + 13 * i + 6.5;
      let left = box.left + 3 + 4 + 8 * Math.max(0, Math.min(member.depth, 4) - 1);
      if (member.depth > 0) {
        // The corner that ties a model to the one over it.
        blocks.push({
          kind: 'path',
          of: `chain:${id}`,
          steps: polyline([
            [left + 1, middle - 4],
            [left + 1, middle],
            [left + 5, middle],
          ]),
          stroke: outline,
        });
        left += 5.4 + 4;
      }
      const chip = i > 0 ? unitChipLabel(member) : null;
      const right = box.right - 3 - 4;
      const chipRoom = chip === null ? 0 : 4.8 * chip.length + 8;
      text(
        blocks,
        `chain:${id}`,
        'chain',
        `${member.kind} ${member.idx}`,
        left,
        baselineAt(middle, 'chain'),
        'start',
        right - chipRoom - left,
      );
      if (chip !== null) {
        text(
          blocks,
          `chain:${id}`,
          'chip',
          chip,
          right,
          baselineAt(middle, 'chip'),
          'end',
          chipRoom - 4,
          palette.muted,
        );
      }
    });
  }

  /** The badge of a controller that stands on its own, with the tether to what it acts on. */
  function drawController(
    id: string,
    data: NodeData,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const dx = data.connectorDx ?? 0;
    const dy = data.connectorDy ?? 0;
    if (data.orphan !== true && (dx !== 0 || dy !== 0)) {
      lines.push({
        kind: 'path',
        of: `tether:${id}`,
        steps: polyline([
          [x + 6, y + 8],
          [x + dx + 12, y + dy + 8],
        ]),
        stroke: { ...outline, dash: [2, 2] },
      });
      drawnLines.push({
        of: `tether:${id}`,
        points: [
          [x + 6, y + 8],
          [x + dx + 12, y + dy + 8],
        ],
      });
    }
    blocks.push({
      kind: 'rect',
      of: id,
      x,
      y,
      width,
      height,
      radius: 2,
      fill: palette.paper,
      stroke: outline,
    });
    const glyph = Math.min(14, height - 4);
    drawSymbol(
      blocks,
      id,
      controllerSymbol(data.subKind ?? 'other'),
      x + 7,
      y + (height - glyph) / 2,
      glyph,
    );
    const left = x + 7 + glyph + 4;
    text(
      blocks,
      id,
      'device',
      String(data.idx ?? ''),
      left,
      baselineAt(y + height / 2, 'device'),
      'start',
      x + width - 6 - left,
    );
  }

  // ---- the arrows of the flows -----------------------------------------------

  // Everything else is drawn by now, and an arrow is one more thing that is
  // drawn over nothing: it stands where the canvas has it while that place
  // is clear of every other line and of the box of everything that stands
  // there, and otherwise at the nearest place on its line that is. A line
  // with no such place gets no arrow; the sign of its value still says which
  // way the power goes.
  if (flowArrows.length > 0) {
    const standing = new Map<string, Rect>();
    for (const item of [...bars, ...dots, ...symbols, ...blocks, ...labels]) {
      const box = itemBox(item);
      const known = standing.get(item.of);
      standing.set(item.of, {
        left: Math.min(known?.left ?? Infinity, box.x),
        right: Math.max(known?.right ?? -Infinity, box.x + box.width),
        top: Math.min(known?.top ?? Infinity, box.y),
        bottom: Math.max(known?.bottom ?? -Infinity, box.y + box.height),
      });
    }
    const boxes = [...standing.values()];
    for (const { id, points, prefer, size, forward, label } of flowArrows) {
      const spot = placeArrow(points, prefer, size, forward, label, {
        lines: drawnLines.filter((other) => other.of !== id).map((other) => other.points),
        boxes,
      });
      if (spot === null) continue;
      arrows.push({
        kind: 'path',
        of: `arrow:${id}`,
        steps: [...polyline(arrowCorners(spot, size, forward)), { op: 'Z' }],
        // No halo round it, as the canvas draws one: in print the halo
        // cuts a notch into the line under the tip.
        fill: palette.ink,
      });
    }
  }

  const items = [...lines, ...arrows, ...bars, ...dots, ...symbols, ...blocks, ...labels];
  const box = boxAround(items, FIGURE_MARGIN) ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    items,
    box,
    paper: palette.paper,
    textSizes,
    leftOff,
    shown,
    drawnKinds: [...drawnKinds],
  };
}
