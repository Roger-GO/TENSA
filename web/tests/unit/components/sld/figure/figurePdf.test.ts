/** A figure as a PDF: one page, vector, with text that is text. */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Figure } from '@/components/sld/figure/displayList';
import { PT_PER_PX, figureToPdf, pdfString } from '@/components/sld/figure/figurePdf';
import { opened } from '../../../helpers/diagramStates';
import { IEEE14 } from '../../../helpers/exampleCases';
import { figureOf, solved, sourceOf } from '../../../helpers/figureCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const FIGURE: Figure = {
  box: { x: -10, y: 20, width: 200, height: 100 },
  paper: '#ffffff',
  items: [
    {
      kind: 'path',
      of: 'line-1',
      steps: [
        { op: 'M', x: 0, y: 30 },
        { op: 'L', x: 0, y: 60 },
      ],
      stroke: { colour: '#b91c1c', width: 1.5 },
    },
    { kind: 'rect', of: '1', x: 0, y: 30, width: 92, height: 6, fill: '#000000' },
    { kind: 'circle', of: 'tap:1', cx: 46, cy: 33, r: 4, fill: '#000000' },
    {
      kind: 'text',
      of: 'label:1',
      text: 'BUS1',
      x: 46,
      y: 50,
      anchor: 'middle',
      font: 'sans',
      size: 10,
      colour: '#000000',
      // What Helvetica makes of it: 667 + 722 + 667 + 556 thousandths of 10.
      width: 26.12,
    },
  ],
};

/** The objects of a PDF by number, read through its cross-reference table. */
function objectsOf(pdf: string): Map<number, string> {
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  expect(pdf.slice(start, start + 5)).toBe('xref\n');
  const [, count] = /^xref\n0 (\d+)\n/.exec(pdf.slice(start))!;
  const rows = pdf
    .slice(start)
    .split('\n')
    .slice(2, 2 + Number(count));
  expect(rows[0]).toBe('0000000000 65535 f ');
  const out = new Map<number, string>();
  rows.slice(1).forEach((row, i) => {
    expect(row).toMatch(/^\d{10} 00000 n $/);
    const at = Number(row.slice(0, 10));
    // The table says where each object begins.
    expect(pdf.slice(at, at + `${i + 1} 0 obj\n`.length)).toBe(`${i + 1} 0 obj\n`);
    out.set(i + 1, pdf.slice(at, pdf.indexOf('endobj', at)));
  });
  return out;
}

describe('figureToPdf', () => {
  it('writes one page as large as the figure, three quarters of a point to a px', () => {
    const pdf = figureToPdf(FIGURE, { title: 'ieee14: single-line diagram' });
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    const objects = objectsOf(pdf);
    expect(objects.get(1)).toContain('/Type /Catalog /Pages 2 0 R');
    expect(objects.get(2)).toContain('/Kids [3 0 R] /Count 1');
    expect(PT_PER_PX).toBe(0.75);
    expect(objects.get(3)).toContain('/MediaBox [0 0 150 75]');
    expect(objects.get(3)).toContain('/Contents 4 0 R');
    expect(pdf).toMatch(/trailer\n<< \/Size 7 \/Root 1 0 R \/Info 6 0 R >>/);
    expect(objects.get(6)).toContain('/Title (ieee14: single-line diagram)');
  });

  it('says how long its content is, to the character', () => {
    const content = objectsOf(figureToPdf(FIGURE)).get(4)!;
    const [, length] = /<< \/Length (\d+) >>\nstream\n/.exec(content)!;
    const stream = content.slice(
      content.indexOf('stream\n') + 7,
      content.lastIndexOf('\nendstream'),
    );
    expect(stream.length).toBe(Number(length));
  });

  it('is ASCII throughout, so that a length in characters is a length in bytes', async () => {
    const diagram = await opened(IEEE14);
    const named = sourceOf(diagram, solved(diagram));
    const pdf = figureToPdf(
      figureOf({
        ...named,
        nodes: named.nodes.map((n) =>
          n.id === '1' ? { ...n, data: { ...n.data, name: 'Zürich 母線' } } : n,
        ),
      }),
    );
    // eslint-disable-next-line no-control-regex
    expect(pdf).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(new TextEncoder().encode(pdf).length).toBe(pdf.length);
    objectsOf(pdf);
    // The u with its dots as its WinAnsi code; what WinAnsi has no letter for as a question mark.
    expect(pdf).toContain('(Z\\374rich ??) Tj');
    // An angle keeps its degree sign.
    expect(pdf).toMatch(/\(-?\d+\.\d\d\\260\) Tj/);
  });

  it('draws with y down, and turns the letters upright again', () => {
    const stream = objectsOf(figureToPdf(FIGURE)).get(4)!;
    // The corner of the figure, -10, 20, is the top left of the page: 0, 75 pt.
    expect(stream).toContain('0.75 0 0 -0.75 7.5 90 cm');
    // The paper, over the whole figure.
    expect(stream).toContain('1 1 1 rg\n-10 20 200 100 re f');
    // A line: its colour, its width, solid, then the path and the stroke.
    expect(stream).toContain('0.725 0.11 0.11 RG\n1.5 w\n0 J\n[] 0 d\n0 30 m\n0 60 l\nS');
    // A bar is filled and not stroked.
    expect(stream).toContain('0 0 0 rg\n0 30 m\n92 30 l\n92 36 l\n0 36 l\nh\nf');
    // The text: Helvetica at 10, upright, begun half its width left of where it is hung.
    expect(stream).toContain(
      'BT\n0 0 0 rg\n/F1 10 Tf\n100 Tz\n1 0 0 -1 32.94 50 Tm\n(BUS1) Tj\nET',
    );
  });

  it('names each font it sets text in, and no other', () => {
    const both: Figure = {
      ...FIGURE,
      items: [
        ...FIGURE.items,
        {
          ...FIGURE.items[3]!,
          kind: 'text',
          font: 'serif',
          anchor: 'end',
        } as Figure['items'][number],
        {
          ...FIGURE.items[3]!,
          kind: 'text',
          font: 'mono',
          anchor: 'start',
        } as Figure['items'][number],
      ],
    };
    const objects = objectsOf(figureToPdf(both));
    expect(objects.get(3)).toContain('/Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >>');
    expect(objects.get(5)).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(objects.get(6)).toContain('/BaseFont /Times-Roman');
    expect(objects.get(7)).toContain('/BaseFont /Courier');
    // One font for a figure set in one.
    expect(objectsOf(figureToPdf(FIGURE)).size).toBe(6);
    // And none for a figure with no text on it.
    const bare = objectsOf(figureToPdf({ ...FIGURE, items: FIGURE.items.slice(0, 3) }));
    expect(bare.get(3)).toContain('/Font <<  >>');
  });

  it('sets a text narrower where the figure gave it less room than its font takes', () => {
    const squeezed: Figure = {
      ...FIGURE,
      items: [{ ...FIGURE.items[3]!, anchor: 'start', width: 13.06 } as Figure['items'][number]],
    };
    const stream = objectsOf(figureToPdf(squeezed)).get(4)!;
    expect(stream).toContain('/F1 10 Tf\n50 Tz\n1 0 0 -1 46 50 Tm');
  });

  it('turns a text about the point it is hung at', () => {
    const turned: Figure = {
      ...FIGURE,
      items: [{ ...FIGURE.items[3]!, rotate: -90 } as Figure['items'][number]],
    };
    // Reading from the bottom up: begun half its width under the point.
    expect(objectsOf(figureToPdf(turned)).get(4)).toContain('0 -1 -1 0 46 63.06 Tm');
  });
});

describe('pdfString', () => {
  it('writes a text in WinAnsi, in ASCII', () => {
    expect(pdfString('40.0 MW')).toBe('(40.0 MW)');
    expect(pdfString('a (b) \\ c')).toBe('(a \\(b\\) \\\\ c)');
    expect(pdfString('-7.25°')).toBe('(-7.25\\260)');
    expect(pdfString('Île € “x” – y')).toBe('(\\316le \\200 \\223x\\224 \\226 y)');
    // A minus sign as the hyphen, and what the encoding has no letter for as a question mark.
    expect(pdfString('−5 母 →')).toBe('(-5 ? ?)');
    expect(pdfString('a\tb')).toBe('(a\\011b)');
  });
});
