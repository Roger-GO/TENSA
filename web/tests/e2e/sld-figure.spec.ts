/**
 * The figure of the diagram, in a browser.
 *
 *   open IEEE 14 -> the Export menu over the diagram says in its name that a
 *   figure is in it, and lists it -> the dialog shows a figure a browser can
 *   draw, black on white -> before a power flow the values cannot be chosen:
 *   their boxes are empty, each says what it needs, and what to do stands
 *   over them -> run a power flow -> the figure has the voltages, the flows
 *   and the powers, and an arrow on every line, clear of every other line
 *   -> fitted to the dialog the figure is too small to read, the dialog
 *   says so, and shows it at its own size when asked
 *
 *   the figure is the diagram as it is drawn: every line and connector on
 *   screen runs through the same points in the figure, every device stands
 *   in the same box, and every bar has a dot where a line ends on it
 *
 *   Download SVG, PDF and PNG -> each is the file it says: an SVG that is
 *   the preview, to the character, with nothing in it but plain shapes and
 *   texts; a PDF of one page whose text can be read back; a PNG with as
 *   many pixels as the resolution asks, and that resolution written into it
 *   -> nothing was written beside the case for looking at its figure
 *
 *   in a copy: choose colour, another font and fewer labels -> they are
 *   written beside the case -> reload -> the dialog opens with them, and
 *   draws the same figure -> move a load -> the figure has it where it is
 *   now -> pick three buses -> a figure of the selection has those, their
 *   devices and the lines between them, and no other bus
 *
 * What a unit test cannot hold is held here: that a real browser draws the
 * SVG, rasterises it, and hands over the three files, and that the figure
 * is made of what is on screen and not only of what the diagram works out
 * (`drawFigure.test.ts` holds the rule that nothing on it is drawn over
 * anything else, on the sizes the diagram works its places out with).
 *
 * The choices and the move are made in a copy saved under a name of this
 * run's own, so the example cases the other specs open keep their layout.
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page, reloadWithCase } from './fixtures';
import {
  NEAR,
  dragInDiagram,
  drawing,
  layoutWritten,
  openCase,
  openCopy,
  runPowerFlow,
  settled,
} from './sldDrawing';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

const CASE_FILE = 'ieee14_full.xlsx';

test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** Open the figure the way a user does: the Export menu over the diagram, then its Figure entry. */
async function openFigure(page: Page): Promise<void> {
  await page.getByTestId('sld-canvas').getByTestId('export-menu-trigger').click();
  await page.getByTestId('export-menu-figure').click();
  await expect(page.getByTestId('sld-figure-dialog')).toBeVisible();
  await expect(page.getByTestId('sld-figure-preview')).toBeVisible();
}

async function closeFigure(page: Page): Promise<void> {
  await page.getByTestId('sld-figure-close').click();
  await expect(page.getByTestId('sld-figure-dialog')).toBeHidden();
}

/** The SVG the preview shows. */
async function previewSvg(page: Page): Promise<string> {
  const src = (await page.getByTestId('sld-figure-preview').getAttribute('src')) ?? '';
  return decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
}

interface FigureShapes {
  /** What every text of the figure says. */
  texts: string[];
  /** The points of every line, transformer and connector, each as `x,y x,y ...`. */
  lines: string[];
  /** Every rectangle with rounded corners: the outline of a device, a chip or a chain. */
  boxes: { x: number; y: number; width: number; height: number }[];
  /** The middle of every dot. */
  dots: [number, number][];
  /** The three corners of every arrow of a flow, the tip first. */
  arrows: [number, number][][];
  /** Every colour anything is drawn in. */
  colours: string[];
  /** The names of the elements of the document. */
  tags: string[];
  width: number;
  height: number;
}

/** What an SVG of a figure holds, read by the browser that would draw it. */
async function shapesOf(page: Page, svg: string): Promise<FigureShapes> {
  return await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror') !== null) throw new Error('the figure is not XML');
    const root = doc.documentElement;
    const round = (value: number): number => Math.round(value * 2) / 2;
    const lines: string[] = [];
    const arrows: [number, number][][] = [];
    for (const path of doc.querySelectorAll('path')) {
      const d = path.getAttribute('d') ?? '';
      // The arrow of a flow: three corners, closed, filled and not stroked.
      if (/^M[^MLCZ]+L[^MLCZ]+L[^MLCZ]+Z$/.test(d.trim()) && !path.hasAttribute('stroke')) {
        const at = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        arrows.push([
          [at[0]!, at[1]!],
          [at[2]!, at[3]!],
          [at[4]!, at[5]!],
        ]);
        continue;
      }
      // A conductor: straight runs, stroked and not filled, cut square at its
      // ends (the strokes of a symbol are rounded) and solid (a tether is dashed).
      if (path.getAttribute('fill') !== 'none' || /[CZ]/.test(d)) continue;
      if (path.hasAttribute('stroke-linecap') || path.hasAttribute('stroke-dasharray')) continue;
      const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const points: string[] = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        points.push(`${round(numbers[i]!)},${round(numbers[i + 1]!)}`);
      }
      lines.push(points.join(' '));
    }
    const colours = new Set<string>();
    for (const el of doc.querySelectorAll('[fill], [stroke]')) {
      for (const name of ['fill', 'stroke']) {
        const value = el.getAttribute(name);
        if (value !== null && value !== 'none') colours.add(value);
      }
    }
    return {
      texts: [...doc.querySelectorAll('text')].map((el) => el.textContent ?? ''),
      lines,
      boxes: [...doc.querySelectorAll('rect[rx]')].map((el) => ({
        x: Number(el.getAttribute('x')),
        y: Number(el.getAttribute('y')),
        width: Number(el.getAttribute('width')),
        height: Number(el.getAttribute('height')),
      })),
      dots: [...doc.querySelectorAll('circle[fill="#000000"], circle[fill="#111827"]')]
        .filter((el) => !el.hasAttribute('stroke'))
        .map((el): [number, number] => [
          Number(el.getAttribute('cx')),
          Number(el.getAttribute('cy')),
        ]),
      arrows,
      colours: [...colours].sort(),
      tags: [...new Set([...doc.querySelectorAll('*')].map((el) => el.tagName))].sort(),
      width: Number(root.getAttribute('width')),
      height: Number(root.getAttribute('height')),
    };
  }, svg);
}

/** Press a Download button of the dialog and read the file it hands over. */
async function download(
  page: Page,
  format: 'svg' | 'pdf' | 'png',
): Promise<{ name: string; bytes: Buffer }> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`sld-figure-download-${format}`).click(),
  ]);
  const name = file.suggestedFilename();
  await expect(page.getByTestId('sld-figure-status')).toContainText(`Saved ${name}`);
  return { name, bytes: readFileSync(await file.path()) };
}

/** How far `p` is from the run from `a` to `b`. */
function offRun(p: [number, number], a: [number, number], b: [number, number]): number {
  const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
  const length = ux * ux + uy * uy;
  const t =
    length === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / length));
  return Math.hypot(a[0] + t * ux - p[0], a[1] + t * uy - p[1]);
}

/** How near `p` comes to the line through `points`. */
const offLine = (p: [number, number], points: readonly [number, number][]): number =>
  Math.min(...points.slice(1).map((b, i) => offRun(p, points[i]!, b)));

/** The points an edge on screen runs through, as `shapesOf` writes those of a line. */
const onScreen = (points: readonly [number, number][]): string =>
  points.map(([x, y]) => `${Math.round(x * 2) / 2},${Math.round(y * 2) / 2}`).join(' ');

test('the figure is the diagram as it is drawn, and each file is what it says', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const layoutWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/workspace/layout') {
      layoutWrites.push(request.url());
    }
  });
  await page.goto('/');
  await openCase(page, CASE_FILE);
  await settled(page);

  // The way to it is the Export menu over the diagram, and says so before it is opened.
  const way = page.getByTestId('sld-canvas').getByTestId('export-menu-trigger');
  await expect(way).toHaveText(/Export figure/);
  await expect(way).toHaveAccessibleName(
    'Export figure: a figure of the diagram for a paper, in the publication look (SVG, PDF or PNG), or a PNG of this view',
  );
  await way.click();
  // Named as in the Export menu of the top bar, with what it is under the name.
  await expect(page.getByTestId('export-menu-figure')).toHaveText(
    'Figure for a paper…The publication look: SVG, PDF or PNG',
  );
  await page.getByTestId('export-menu-figure').click();
  const dialog = page.getByRole('dialog', { name: 'Figure for a paper' });
  await expect(dialog).toBeVisible();

  // A figure a browser can draw: the preview is a picture, as large as it says.
  const preview = page.getByTestId('sld-figure-preview');
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  const plain = await shapesOf(page, await previewSvg(page));
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(plain.width);
  expect(plain.colours).toEqual(['#000000', '#ffffff']);
  expect(plain.texts.filter((text) => /^BUS\d+$/.test(text))).toHaveLength(14);

  // Before a power flow its values cannot be chosen: each box is empty and
  // says what it needs, and what to do about it stands over them.
  for (const id of ['voltages', 'angles', 'flows', 'powers', 'limit-marks']) {
    await expect(page.getByTestId(`sld-figure-${id}`)).toBeDisabled();
    await expect(page.getByTestId(`sld-figure-${id}`)).not.toBeChecked();
    await expect(page.getByTestId(`sld-figure-${id}-unavailable`)).toHaveText(
      '(needs a power flow)',
    );
  }
  await expect(page.getByTestId('sld-figure-no-pflow')).toContainText(
    'come from a power flow, and none has run yet. Close this, press Run PF',
  );
  expect(plain.texts.some((text) => / (pu|MW|MVAr)$/.test(text))).toBe(false);
  // Nothing is picked, so there is no part to make a figure of, and it says how to pick one.
  await expect(page.getByTestId('sld-figure-part-picked')).toBeDisabled();
  await expect(page.getByTestId('sld-figure-part-hint')).toContainText('hold Shift and drag a box');

  // Esc closes it, and the focus is back where it came from.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(way).toBeFocused();

  await runPowerFlow(page);
  const drawn = await settled(page);
  await openFigure(page);
  await expect(page.getByTestId('sld-figure-voltages')).toBeEnabled();
  await expect(page.getByTestId('sld-figure-voltages')).toBeChecked();
  await expect(page.getByTestId('sld-figure-voltages-unavailable')).toHaveCount(0);
  const svg = await previewSvg(page);
  const figure = await shapesOf(page, svg);

  // Fitted to the dialog, a figure this tall is shown well under its size:
  // the dialog says at what fraction, which is what the browser drew it at,
  // and shows it at its own size when asked.
  const note = page.getByTestId('sld-figure-fit-note');
  await expect(note).toContainText('too small to read its text');
  const percent = Number(/shown at (\d+)% of its size/.exec(await note.innerText())?.[1]);
  const fitted = await preview.evaluate((img: HTMLImageElement) => {
    const box = img.getBoundingClientRect();
    return Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  });
  expect(Math.abs(fitted * 100 - percent)).toBeLessThanOrEqual(1);
  expect(percent).toBeLessThan(80);
  await page.getByTestId('sld-figure-fit-note-zoom').click();
  await expect(page.getByTestId('sld-figure-zoom-100')).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toBeHidden();
  expect(
    await preview.evaluate((img: HTMLImageElement) => img.getBoundingClientRect().width),
  ).toBeCloseTo(figure.width, 0);
  await page.getByTestId('sld-figure-zoom-fit').click();
  await expect(note).toBeVisible();
  expect(figure.texts.filter((text) => / pu$/.test(text)).length).toBeGreaterThan(10);
  expect(figure.texts.filter((text) => /^-?\d+\.\d\d MW$/.test(text)).length).toBeGreaterThan(10);
  // Five generators and eleven loads, less any the diagram has no place for.
  expect(figure.texts.filter((text) => / MVAr$/.test(text)).length).toBeGreaterThanOrEqual(14);
  // As many conductors as the diagram has: nothing of a line is drawn twice or left out.
  expect(figure.lines).toHaveLength(Object.keys(drawn.edges).length);

  // Every line, transformer and connector on screen runs through the same points in the figure.
  const edges = Object.entries(drawn.edges);
  expect(edges).toHaveLength(38);
  for (const [id, edge] of edges) {
    expect(figure.lines, `${id} is in the figure as it is on screen`).toContain(
      onScreen(edge.points),
    );
  }
  // Every line carries the arrow of its flow, on the line as it is on
  // screen and clear of every other line, transformer and connector there:
  // an arrow where two lines cross would point into the other one.
  const branches = edges.filter(([id]) => id.startsWith('line-'));
  expect(branches).toHaveLength(16);
  expect(figure.arrows).toHaveLength(branches.length);
  const carried = new Set<string>();
  for (const corners of figure.arrows) {
    const [tip, left, right] = corners as [[number, number], [number, number], [number, number]];
    const middle: [number, number] = [
      (2 * tip[0] + left[0] + right[0]) / 4,
      (2 * tip[1] + left[1] + right[1]) / 4,
    ];
    const own = branches.filter(([, edge]) => offLine(middle, edge.points) < NEAR);
    expect(own, `an arrow at ${middle[0]}, ${middle[1]} is on one line`).toHaveLength(1);
    const [ownId] = own[0]!;
    carried.add(ownId);
    for (const [id, edge] of edges) {
      if (id === ownId) continue;
      const off = Math.min(...corners.map((corner) => offLine(corner, edge.points)));
      expect(off, `the arrow of ${ownId} is clear of ${id}`).toBeGreaterThanOrEqual(6 - NEAR);
    }
  }
  expect(carried.size).toBe(branches.length);

  // Every generator, load and shunt stands in the box the browser gave it.
  const devices = Object.entries(drawn.nodes).filter(([, node]) => node.type !== 'bus');
  expect(devices).toHaveLength(18);
  for (const [id, node] of devices) {
    const there = figure.boxes.some(
      (box) =>
        Math.abs(box.x - node.x) < NEAR &&
        Math.abs(box.y - node.y) < NEAR &&
        Math.abs(box.width - node.width) < NEAR &&
        Math.abs(box.height - node.height) < NEAR,
    );
    expect(there, `${id} at ${node.x}, ${node.y}`).toBe(true);
  }
  // And every tap dot of a bar on screen is a dot of the figure.
  for (const [id, node] of Object.entries(drawn.nodes)) {
    for (const tap of node.taps ?? []) {
      const dotted = figure.dots.some(
        ([x, y]) => Math.abs(x - (node.x + tap)) < NEAR && Math.abs(y - (node.y + 3)) < NEAR,
      );
      expect(dotted, `the tap of bus ${id} at ${tap}`).toBe(true);
    }
  }
  // Plain shapes and texts, and nothing a paper cannot take.
  expect(figure.tags).toEqual(['circle', 'path', 'rect', 'svg', 'text', 'title']);
  expect(svg).not.toMatch(/<script|<style|<foreignObject|<image|href=|class=|url\(|var\(/);

  // The SVG that is saved is the one that is shown, to the character.
  const saved = await download(page, 'svg');
  expect(saved.name).toMatch(/^ieee14_full_figure_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.svg$/);
  expect(saved.bytes.toString('utf8')).toBe(svg);

  // The PDF: one page as large as the figure, with its text as text.
  const pdf = (await download(page, 'pdf')).bytes.toString('latin1');
  expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
  expect(pdf.endsWith('%%EOF\n')).toBe(true);
  expect(pdf).toContain(`/MediaBox [0 0 ${figure.width * 0.75} ${figure.height * 0.75}]`);
  expect(pdf).toContain('/BaseFont /Helvetica');
  expect(pdf).toContain('(BUS14) Tj');
  expect(pdf).toContain('(1.030 pu) Tj');
  // Its table of contents says where each object is.
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
  expect(pdf.slice(xref, xref + 5)).toBe('xref\n');
  const rows = pdf.slice(xref).split('\n').slice(3, 9);
  rows.forEach((row, i) => {
    const at = Number(row.slice(0, 10));
    expect(pdf.slice(at, at + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj`);
  });

  // The PNG: as many pixels as the resolution asks, and that resolution in
  // the file. At the resolution the dialog opens with: a choice would be
  // written beside the example case, which the other specs open as it ships.
  await expect(page.getByTestId('sld-figure-dpi')).toHaveValue('300');
  const pixels = {
    width: Math.round((figure.width * 300) / 96),
    height: Math.round((figure.height * 300) / 96),
  };
  await expect(page.getByTestId('sld-figure-png-size')).toHaveText(
    `A PNG at 300 dpi is ${pixels.width} x ${pixels.height} pixels.`,
  );
  const png = (await download(page, 'png')).bytes;
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([pixels.width, pixels.height]);
  // Right after the header: 300 dots per inch are 11811 per metre, both ways.
  expect(png.subarray(37, 41).toString('latin1')).toBe('pHYs');
  expect([png.readUInt32BE(41), png.readUInt32BE(45), png[49]]).toEqual([11811, 11811, 1]);
  // And it is a picture of the figure, not an empty sheet: it has ink on it.
  const inked = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! < 64 && data[i + 3]! > 200) dark += 1;
      return { width: bitmap.width, height: bitmap.height, dark, corner: [...data.subarray(0, 4)] };
    },
    [...png],
  );
  expect([inked.width, inked.height]).toEqual([pixels.width, pixels.height]);
  expect(inked.dark).toBeGreaterThan(80_000);
  // The paper is white, to its corner.
  expect(inked.corner).toEqual([255, 255, 255, 255]);

  await closeFigure(page);
  // Looking at the figure and saving it chose nothing, so nothing was
  // written beside the example case.
  await page.waitForTimeout(1_500);
  expect(layoutWrites).toEqual([]);
});

test('the choices come back with the case, and the figure follows a move and a selection', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openCase(page, CASE_FILE);
  const stem = `figure-${Date.now()}`;
  await openCopy(page, stem);
  await runPowerFlow(page);
  await settled(page);

  await openFigure(page);
  // Colour, in Times, without the flows: each is written beside the case.
  await Promise.all([layoutWritten(page), page.getByTestId('sld-figure-style-colour').check()]);
  await Promise.all([
    layoutWritten(page),
    page.getByTestId('sld-figure-font').selectOption('serif'),
  ]);
  await Promise.all([layoutWritten(page), page.getByTestId('sld-figure-flows').uncheck()]);
  const chosen = await previewSvg(page);
  const chosenShapes = await shapesOf(page, chosen);
  expect(chosenShapes.colours).toContain('#111827');
  expect(chosenShapes.colours).not.toContain('#000000');
  expect(chosen).toContain('Times');
  expect(chosenShapes.texts.some((text) => /^-?\d+\.\d\d MW$/.test(text))).toBe(false);
  expect(chosenShapes.texts.some((text) => / pu$/.test(text))).toBe(true);
  await closeFigure(page);

  // Reloaded: the dialog opens as it was left, and draws the same figure.
  // The page opens the case again by itself.
  await reloadWithCase(page);
  await runPowerFlow(page);
  await settled(page);
  await openFigure(page);
  await expect(page.getByTestId('sld-figure-style-colour')).toBeChecked();
  await expect(page.getByTestId('sld-figure-font')).toHaveValue('serif');
  await expect(page.getByTestId('sld-figure-flows')).not.toBeChecked();
  await expect(page.getByTestId('sld-figure-voltages')).toBeChecked();
  expect(await previewSvg(page)).toBe(chosen);
  // What was said of a file in the last visit is not said of this figure.
  await expect(page.getByTestId('sld-figure-status')).not.toContainText('Saved');
  await closeFigure(page);

  // A load moved to the side of its bus: the figure has it where it stands now.
  const before = (await drawing(page)).nodes['load-PQ_8']!;
  await dragInDiagram(page, 'load-PQ_8', 120, 0);
  const moved = await settled(page);
  const load = moved.nodes['load-PQ_8']!;
  expect(load.x).toBeGreaterThan(before.x + 60);
  await openFigure(page);
  const after = await shapesOf(page, await previewSvg(page));
  const at = (node: { x: number; y: number }) =>
    after.boxes.some((box) => Math.abs(box.x - node.x) < NEAR && Math.abs(box.y - node.y) < NEAR);
  expect(at(load)).toBe(true);
  expect(at(before)).toBe(false);
  // Its connector as it is on screen: from the middle of a face to a tap of the bar.
  expect(after.lines).toContain(onScreen(moved.edges['stub-load-PQ_8']!.points));
  await closeFigure(page);

  // Three buses picked with Ctrl held: a figure of them, their devices and the lines between them.
  for (const bus of ['1', '2', '5']) {
    await page.getByTestId(`bus-bar-${bus}`).click({ modifiers: ['ControlOrMeta'] });
  }
  await expect(page.getByTestId('sld-selection-count')).toHaveText('3 picked');
  await openFigure(page);
  const part = page.getByRole('radio', { name: 'Selection only (3 picked)' });
  await expect(part).toBeEnabled();
  await part.check();
  await expect(page.getByTestId('sld-figure-size')).toContainText('7 buses and devices');
  const selection = await shapesOf(page, await previewSvg(page));
  expect(selection.texts.filter((text) => /^BUS\d+$/.test(text)).sort()).toEqual([
    'BUS1',
    'BUS2',
    'BUS5',
  ]);
  expect(selection.texts).toEqual(expect.arrayContaining(['PQ_1', 'PQ_4']));
  // Lines 1-2, 1-5 and 2-5, and the connectors of two generators and two loads.
  expect(selection.lines).toHaveLength(7);
  for (const id of ['line-Line_1', 'line-Line_2', 'line-Line_5', 'stub-load-PQ_1']) {
    expect(selection.lines, id).toContain(onScreen(moved.edges[id]!.points));
  }
  expect(selection.height).toBeLessThan(after.height);
  const file = await download(page, 'pdf');
  expect(file.name).toMatch(/_figure-selection_.*\.pdf$/);
  expect(file.bytes.toString('latin1')).toContain('(BUS5) Tj');
  expect(file.bytes.toString('latin1')).not.toContain('(BUS3) Tj');
});
