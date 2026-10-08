/**
 * The symbols of the diagram as shapes a figure can draw.
 *
 * On the screen a symbol is an SVG file shown as an image
 * (`icons/iec60617`, picked by `iconForModel`), and the glyph of a
 * controller is an inline SVG (`ControllerGlyph`). A figure draws the same
 * files and the same parts as shapes of its own, so that it can set their
 * colour and how heavy their stroke is, and write them into a PDF. Reading
 * the files, and not a second copy of what is in them, keeps one symbol set:
 * an icon that is redrawn is redrawn in the figure too.
 *
 * Pure: nothing read but the arguments and the icon files.
 */
import busUrl from '@/icons/iec60617/bus.svg?url';
import busSvg from '@/icons/iec60617/bus.svg?raw';
import lineUrl from '@/icons/iec60617/line.svg?url';
import lineSvg from '@/icons/iec60617/line.svg?raw';
import transformer2wUrl from '@/icons/iec60617/transformer-2w.svg?url';
import transformer2wSvg from '@/icons/iec60617/transformer-2w.svg?raw';
import transformer3wUrl from '@/icons/iec60617/transformer-3w.svg?url';
import transformer3wSvg from '@/icons/iec60617/transformer-3w.svg?raw';
import generatorUrl from '@/icons/iec60617/generator.svg?url';
import generatorSvg from '@/icons/iec60617/generator.svg?raw';
import generatorSyngenUrl from '@/icons/iec60617/generator-syngen.svg?url';
import generatorSyngenSvg from '@/icons/iec60617/generator-syngen.svg?raw';
import loadUrl from '@/icons/iec60617/load.svg?url';
import loadSvg from '@/icons/iec60617/load.svg?raw';
import shuntCapUrl from '@/icons/iec60617/shunt-cap.svg?url';
import shuntCapSvg from '@/icons/iec60617/shunt-cap.svg?raw';
import shuntReactorUrl from '@/icons/iec60617/shunt-reactor.svg?url';
import shuntReactorSvg from '@/icons/iec60617/shunt-reactor.svg?raw';
import groundUrl from '@/icons/iec60617/ground.svg?url';
import groundSvg from '@/icons/iec60617/ground.svg?raw';
import { iconForModel } from '@/icons/iec60617/manifest';
import type { ControllerSubKind } from '@/lib/controllers';
import { CONTROLLER_GLYPH_BOX, CONTROLLER_GLYPH_PARTS } from '../nodes/controllerGlyphShapes';
import type { PathStep } from './displayList';
import { circleSteps, parsePathData, roundedRectSteps } from './pathData';

/** One shape of a symbol, in the coordinates of the symbol's own box. */
export interface SymbolShape {
  steps: PathStep[];
  /** How heavy its stroke is against the stroke of the symbol: 1 for most; 0 for a shape that has none. */
  weight: number;
  /** Whether it is filled in the colour of the stroke. */
  filled: boolean;
}

/** A symbol: its shapes, and the box they are drawn in. */
export interface FigureSymbol {
  width: number;
  height: number;
  shapes: SymbolShape[];
}

/** The attributes of one tag, by name. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  for (let match = pattern.exec(tag); match !== null; match = pattern.exec(tag)) {
    out.set(match[1]!, match[2]!);
  }
  return out;
}

/** The shapes of an SVG of the icon set. Throws on an element it cannot draw. */
export function parseSymbol(svg: string): FigureSymbol {
  const root = attributes(/<svg\b[^>]*>/.exec(svg)?.[0] ?? '');
  const [, , width = 24, height = 24] = (root.get('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const baseStroke = Number(root.get('stroke-width') ?? 1);
  const shapes: SymbolShape[] = [];
  const pattern = /<(\w+)\b([^>]*?)\/?>/g;
  for (let match = pattern.exec(svg); match !== null; match = pattern.exec(svg)) {
    const [, name, rest] = match;
    if (name === 'svg') continue;
    const attr = attributes(rest!);
    const number = (key: string): number => Number(attr.get(key) ?? 0);
    let steps: PathStep[];
    switch (name) {
      case 'line':
        steps = [
          { op: 'M', x: number('x1'), y: number('y1') },
          { op: 'L', x: number('x2'), y: number('y2') },
        ];
        break;
      case 'circle':
        steps = circleSteps(number('cx'), number('cy'), number('r'));
        break;
      case 'rect':
        steps = roundedRectSteps(
          number('x'),
          number('y'),
          number('width'),
          number('height'),
          number('rx'),
        );
        break;
      case 'path':
        steps = parsePathData(attr.get('d') ?? '');
        break;
      default:
        throw new Error(`symbol element <${name}> is not supported`);
    }
    const stroked = (attr.get('stroke') ?? root.get('stroke') ?? 'none') !== 'none';
    const ownStroke = Number(attr.get('stroke-width') ?? baseStroke);
    shapes.push({
      steps,
      weight: stroked ? ownStroke / baseStroke : 0,
      filled: (attr.get('fill') ?? root.get('fill') ?? 'none') !== 'none',
    });
  }
  return { width, height, shapes };
}

/** The file behind each address the manifest gives. */
const FILE_BY_URL = new Map<string, string>([
  [busUrl, busSvg],
  [lineUrl, lineSvg],
  [transformer2wUrl, transformer2wSvg],
  [transformer3wUrl, transformer3wSvg],
  [generatorUrl, generatorSvg],
  [generatorSyngenUrl, generatorSyngenSvg],
  [loadUrl, loadSvg],
  [shuntCapUrl, shuntCapSvg],
  [shuntReactorUrl, shuntReactorSvg],
  [groundUrl, groundSvg],
]);

const parsed = new Map<string, FigureSymbol>();

/** The symbol the diagram draws for the ANDES model `model` (`iconForModel`). */
export function symbolForModel(model: string): FigureSymbol {
  const url = iconForModel(model);
  let symbol = parsed.get(url);
  if (symbol === undefined) {
    symbol = parseSymbol(FILE_BY_URL.get(url) ?? busSvg);
    parsed.set(url, symbol);
  }
  return symbol;
}

const glyphs = new Map<ControllerSubKind, FigureSymbol>();

/** The glyph of a controller of the sub-kind `subKind` (`ControllerGlyph`). */
export function controllerSymbol(subKind: ControllerSubKind): FigureSymbol {
  let symbol = glyphs.get(subKind);
  if (symbol === undefined) {
    const shapes = CONTROLLER_GLYPH_PARTS[subKind].map((part): SymbolShape => {
      const steps =
        'd' in part
          ? parsePathData(part.d)
          : 'circle' in part
            ? circleSteps(part.circle.cx, part.circle.cy, part.circle.r)
            : roundedRectSteps(
                part.rect.x,
                part.rect.y,
                part.rect.width,
                part.rect.height,
                part.rect.rx,
              );
      return { steps, weight: 1, filled: false };
    });
    symbol = { width: CONTROLLER_GLYPH_BOX.size, height: CONTROLLER_GLYPH_BOX.size, shapes };
    glyphs.set(subKind, symbol);
  }
  return symbol;
}

/** `steps` scaled by `scale` and moved so that the origin of the symbol is at (`x`, `y`). */
export function placeSteps(
  steps: readonly PathStep[],
  x: number,
  y: number,
  scale: number,
): PathStep[] {
  return steps.map((step): PathStep => {
    switch (step.op) {
      case 'Z':
        return step;
      case 'C':
        return {
          op: 'C',
          x1: x + scale * step.x1,
          y1: y + scale * step.y1,
          x2: x + scale * step.x2,
          y2: y + scale * step.y2,
          x: x + scale * step.x,
          y: y + scale * step.y,
        };
      default:
        return { op: step.op, x: x + scale * step.x, y: y + scale * step.y };
    }
  });
}
