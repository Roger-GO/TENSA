/** A figure as an SVG document: plain shapes and texts, and nothing a paper cannot take. */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Figure } from '@/components/sld/figure/displayList';
import { escapeXml, figureToSvg } from '@/components/sld/figure/figureSvg';
import { opened } from '../../../helpers/diagramStates';
import { IEEE14 } from '../../../helpers/exampleCases';
import { figureOf, solved, sourceOf } from '../../../helpers/figureCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const FIGURE: Figure = {
  box: { x: -10, y: 20, width: 200, height: 100.5 },
  paper: '#ffffff',
  items: [
    {
      kind: 'path',
      of: 'line-1',
      steps: [
        { op: 'M', x: 0, y: 30 },
        { op: 'L', x: 0, y: 60.126 },
        { op: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 50, y: 60 },
        { op: 'Z' },
      ],
      stroke: { colour: '#000000', width: 1.5, dash: [2, 2], cap: 'round' },
    },
    { kind: 'rect', of: '1', x: 0, y: 30, width: 92, height: 6, fill: '#000000' },
    {
      kind: 'rect',
      of: 'load-1',
      x: 5,
      y: 40,
      width: 40,
      height: 41,
      radius: 3,
      fill: '#ffffff',
      stroke: { colour: '#000000', width: 0.75 },
    },
    { kind: 'circle', of: 'tap:1', cx: 46, cy: 33, r: 4, fill: '#000000' },
    {
      kind: 'text',
      of: 'label:1',
      text: 'BUS <1> & "Co"',
      x: 46,
      y: 50,
      anchor: 'middle',
      font: 'sans',
      size: 10,
      colour: '#000000',
      width: 61.234,
    },
    {
      kind: 'text',
      of: 'flow:line-1',
      text: '12.50 MW',
      x: 3.59,
      y: 45,
      anchor: 'start',
      font: 'serif',
      size: 9.5,
      colour: '#111827',
      width: 40,
      rotate: -90,
    },
  ],
};

describe('figureToSvg', () => {
  it('writes a document as large as the figure, one px of the diagram to a unit', () => {
    const svg = figureToSvg(FIGURE, { title: 'ieee14: single-line diagram' });
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const root = doc.documentElement;
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('width')).toBe('200');
    expect(root.getAttribute('height')).toBe('100.5');
    expect(root.getAttribute('viewBox')).toBe('-10 20 200 100.5');
    expect(doc.querySelector('title')?.textContent).toBe('ieee14: single-line diagram');
    // The paper first, under everything, over the whole figure.
    const first = root.querySelector('rect')!;
    expect(first.getAttribute('fill')).toBe('#ffffff');
    expect([first.getAttribute('x'), first.getAttribute('width')]).toEqual(['-10', '200']);
  });

  it('writes each shape with what says how it looks, in the order it is painted', () => {
    const doc = new DOMParser().parseFromString(figureToSvg(FIGURE), 'image/svg+xml');
    const drawn = [...doc.documentElement.children].filter((el) => el.tagName !== 'title');
    expect(drawn.map((el) => el.tagName)).toEqual([
      'rect',
      'path',
      'rect',
      'rect',
      'circle',
      'text',
      'text',
    ]);
    const path = drawn[1]!;
    // Two decimals at the most.
    expect(path.getAttribute('d')).toBe('M0 30L0 60.13C1 2 3 4 50 60Z');
    expect(path.getAttribute('fill')).toBe('none');
    expect(path.getAttribute('stroke')).toBe('#000000');
    expect(path.getAttribute('stroke-width')).toBe('1.5');
    expect(path.getAttribute('stroke-dasharray')).toBe('2 2');
    expect(path.getAttribute('stroke-linecap')).toBe('round');
    // A bar: filled, with no stroke and square corners.
    expect(drawn[2]!.hasAttribute('stroke')).toBe(false);
    expect(drawn[2]!.hasAttribute('rx')).toBe(false);
    expect(drawn[3]!.getAttribute('rx')).toBe('3');
    expect(drawn[4]!.getAttribute('r')).toBe('4');
  });

  it('writes a text with its font, its size, where it is hung, and how wide it is', () => {
    const doc = new DOMParser().parseFromString(figureToSvg(FIGURE), 'image/svg+xml');
    const [name, flow] = [...doc.querySelectorAll('text')];
    // Read back as it was said: the markup in a name is text.
    expect(name!.textContent).toBe('BUS <1> & "Co"');
    expect(name!.getAttribute('text-anchor')).toBe('middle');
    expect(name!.getAttribute('font-family')).toBe(
      "Helvetica, Arial, 'Liberation Sans', sans-serif",
    );
    expect(name!.getAttribute('font-size')).toBe('10');
    // As wide as the figure gave it, on a machine with none of its fonts too.
    expect(name!.getAttribute('textLength')).toBe('61.23');
    expect(name!.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs');
    expect(name!.hasAttribute('transform')).toBe(false);

    expect(flow!.hasAttribute('text-anchor')).toBe(false);
    expect(flow!.getAttribute('font-family')).toContain('Times');
    expect(flow!.getAttribute('fill')).toBe('#111827');
    expect(flow!.getAttribute('transform')).toBe('rotate(-90 3.59 45)');
  });

  it('writes nothing that is not a plain shape or a text', async () => {
    const diagram = await opened(IEEE14);
    const svg = figureToSvg(figureOf(sourceOf(diagram, solved(diagram)), { monochrome: false }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const tags = new Set([...doc.querySelectorAll('*')].map((el) => el.tagName));
    expect([...tags].sort()).toEqual(['circle', 'path', 'rect', 'svg', 'text']);
    // No script, no style sheet, no class and nothing fetched from anywhere.
    expect(svg).not.toMatch(/<script|<style|<foreignObject|<image|href=|class=|style=|url\(|var\(/);
    // Every colour is written out, and every number is one.
    expect(svg).not.toMatch(/NaN|Infinity|undefined|currentColor/);
    for (const el of doc.querySelectorAll('path, rect, circle, text')) {
      for (const name of ['fill', 'stroke']) {
        const value = el.getAttribute(name);
        if (value !== null) expect(value).toMatch(/^(none|#[0-9a-f]{6})$/);
      }
    }
    expect(doc.querySelectorAll('text').length).toBeGreaterThan(100);
  });

  it('leaves the title out when there is none', () => {
    expect(figureToSvg(FIGURE)).not.toContain('<title>');
    expect(figureToSvg(FIGURE, { title: '' })).not.toContain('<title>');
  });
});

describe('escapeXml', () => {
  it('writes out what XML reads as markup, and drops what it does not allow', () => {
    expect(escapeXml('a < b & "c" > d')).toBe('a &lt; b &amp; &quot;c&quot; &gt; d');
    expect(escapeXml('BUS\u00001\u0008\u001f')).toBe('BUS1');
    // A tab and a line break are allowed, and so is any letter.
    expect(escapeXml('a\tb\nc é 母線')).toBe('a\tb\nc é 母線');
  });
});
