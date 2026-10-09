/**
 * The dialog of the figure: what it shows of the figure, what it says of
 * it, and what it hands the browser to save.
 *
 * It is given a diagram of an example case as the canvas would give it
 * (`figureCases.ts`). That a choice reaches the layout, and the ways the
 * dialog is opened, are held from the canvas in `SldCanvasFigure.test.tsx`.
 *
 * jsdom draws no picture, so the step that rasterises a PNG is stood in
 * for; how many pixels it asks for, and what it writes into the file, are
 * held in `figure/figurePng.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ElkNode } from 'elkjs/lib/elk-api';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const svgToPng =
  vi.fn<(svg: string, width: number, height: number, dpi: number) => Promise<Blob>>();
vi.mock('@/components/sld/figure/figurePng', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/figure/figurePng')>(
    '@/components/sld/figure/figurePng',
  );
  return {
    ...actual,
    svgToPng: (svg: string, width: number, height: number, dpi: number) =>
      svgToPng(svg, width, height, dpi),
  };
});

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { SldFigureDialog } from '@/components/sld/SldFigureDialog';
import type { FigureSource } from '@/components/sld/figure/drawFigure';
import {
  DEFAULT_FIGURE_SETTINGS,
  type FigureSettings,
} from '@/components/sld/figure/figureSettings';
import { CASE118 } from '../../helpers/case118';
import { opened } from '../../helpers/diagramStates';
import { captureDownloads, readBlob, type DownloadCapture } from '../../helpers/downloads';
import { IEEE14 } from '../../helpers/exampleCases';
import { solved, sourceOf } from '../../helpers/figureCases';

let plain: FigureSource;
let solvedCase: FigureSource;
let large: FigureSource;
let downloads: DownloadCapture;

beforeAll(async () => {
  const diagram = await opened(IEEE14);
  plain = sourceOf(diagram);
  solvedCase = sourceOf(diagram, solved(diagram));
  const hundred = await opened(CASE118);
  large = sourceOf(hundred, solved(hundred));
}, 60_000);

beforeEach(() => {
  downloads = captureDownloads();
  svgToPng.mockReset();
  svgToPng.mockResolvedValue(
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  );
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  downloads.restore();
});

interface HarnessProps {
  source: FigureSource | null;
  picked?: ReadonlySet<string> | null;
  initial?: Partial<FigureSettings>;
  onChange?: (next: FigureSettings) => void;
}

/** The dialog with the settings held as the canvas holds them, and a button that opens it. */
function Harness({ source, picked = null, initial = {}, onChange }: HarnessProps) {
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState<FigureSettings>({
    ...DEFAULT_FIGURE_SETTINGS,
    ...initial,
  });
  return (
    <div data-testid="sld-canvas">
      <button type="button" data-testid="export-menu-trigger" onClick={() => setOpen(true)}>
        Export
      </button>
      <SldFigureDialog
        open={open}
        onOpenChange={setOpen}
        source={source}
        picked={picked}
        settings={settings}
        onSettingsChange={(next) => {
          setSettings(next);
          onChange?.(next);
        }}
        caseName="ieee14_full"
      />
    </div>
  );
}

function previewSvg(): string {
  const src = screen.getByTestId('sld-figure-preview').getAttribute('src') ?? '';
  expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  return decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length));
}

const said = (): string[] =>
  [...new DOMParser().parseFromString(previewSvg(), 'image/svg+xml').querySelectorAll('text')].map(
    (el) => el.textContent ?? '',
  );

describe('<SldFigureDialog /> shows the figure it saves', () => {
  it('names itself and says what it is for', () => {
    render(<Harness source={solvedCase} />);
    // Named for what a user looks for, and said outright: this is that look.
    const dialog = screen.getByRole('dialog', { name: 'Figure for a paper' });
    expect(dialog).toHaveAccessibleDescription(
      /^This is the publication look of the diagram.*no selection, no handles and no screen colours.*save it as SVG, PDF or PNG/,
    );
  });

  it('shows the figure, and says how large it is and how much of the diagram is on it', () => {
    render(<Harness source={solvedCase} />);
    const preview = screen.getByTestId('sld-figure-preview');
    expect(preview).toHaveAccessibleName(
      'Preview of the figure: 32 buses and devices, black and white',
    );
    const doc = new DOMParser().parseFromString(previewSvg(), 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const [width, height] = [Number(preview.dataset.width), Number(preview.dataset.height)];
    expect(doc.documentElement.getAttribute('width')).toBe(String(width));
    // In inches at full size, 96 px of the diagram to the inch, and in px.
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent(
      `${(width / 96).toFixed(1)} x ${(height / 96).toFixed(1)} in at full size (${width} x ${height} px of the diagram), text 6 to 7.5 pt, 32 buses and devices`,
    );
    expect(said()).toEqual(expect.arrayContaining(['BUS1', 'PQ_1', 'GOV']));
    expect(said().some((text) => / pu$/.test(text))).toBe(true);
  });

  it('says how large the text is in print at full size, in points, for every size chosen', async () => {
    const user = userEvent.setup();
    render(<Harness source={plain} />);
    // The names at 10 px and the chips of the generators at 8: 7.5 and 6 pt.
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('text 6 to 7.5 pt,');
    await user.selectOptions(screen.getByTestId('sld-figure-font-size'), '8');
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('text 4.8 to 6 pt,');
    // One size on the figure is said as one.
    await user.click(screen.getByTestId('sld-figure-chips'));
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('text 6 pt,');
    await user.click(screen.getByTestId('sld-figure-bus-names'));
    await user.click(screen.getByTestId('sld-figure-device-names'));
    expect(screen.getByTestId('sld-figure-size')).toHaveTextContent('no text,');
  });

  it('redraws at once for every choice, and hands each to the canvas to keep', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness source={solvedCase} onChange={onChange} />);

    await user.click(screen.getByTestId('sld-figure-voltages'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FIGURE_SETTINGS, voltages: false });
    expect(said().some((text) => / pu$/.test(text))).toBe(false);
    expect(said().some((text) => /°$/.test(text))).toBe(true);

    await user.click(screen.getByTestId('sld-figure-style-colour'));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_FIGURE_SETTINGS,
      voltages: false,
      monochrome: false,
    });
    expect(previewSvg()).toContain('#111827');
    expect(screen.getByTestId('sld-figure-preview')).toHaveAccessibleName(/in colour$/);

    await user.selectOptions(screen.getByTestId('sld-figure-line-width'), '2.5');
    expect(previewSvg()).toContain('stroke-width="2.5"');
    await user.selectOptions(screen.getByTestId('sld-figure-font'), 'serif');
    expect(previewSvg()).toContain('Times');
    expect(previewSvg()).not.toContain('Helvetica');
    await user.selectOptions(screen.getByTestId('sld-figure-font-size'), '8');
    expect(previewSvg()).toContain('font-size="8"');
    expect(previewSvg()).not.toContain('font-size="10"');
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_FIGURE_SETTINGS,
      voltages: false,
      monochrome: false,
      lineWidth: 2.5,
      font: 'serif',
      fontSize: 8,
    });
  });

  it('labels every choice, so that each can be found by what it is called', () => {
    render(<Harness source={solvedCase} picked={new Set(['1', '2'])} />);
    for (const name of [
      'Bus names',
      'Names of generators, loads and shunts',
      /^Controllers/,
      'Voltages',
      'Angles',
      /^Line flows/,
      'P and Q of generators and loads',
      /^Limit marks/,
    ]) {
      expect(screen.getByRole('checkbox', { name })).toBeEnabled();
    }
    expect(screen.getByRole('radio', { name: 'Black and white (print)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Colour' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Whole diagram' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Selection only (2 picked)' })).toBeEnabled();
    for (const name of ['Line width', 'Font', 'Text size', 'PNG resolution']) {
      expect(screen.getByRole('combobox', { name })).toBeEnabled();
    }
    for (const name of [
      'Download SVG',
      'Download PDF',
      'Download PNG',
      'Close',
      'Reset to defaults',
    ]) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('says which texts are set smaller than asked, and why, and nothing while none is', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    // At the size it opens with, nothing is a whole px under what was asked.
    expect(screen.queryByTestId('sld-figure-size-note')).toBeNull();

    await user.selectOptions(screen.getByTestId('sld-figure-font-size'), '12');

    expect(screen.getByTestId('sld-figure-size-note')).toHaveTextContent(
      'Set smaller than 12 px, so that nothing is drawn over anything else: the labels of the buses (10 px), the names of the devices (11 px), the P and Q of the devices (9.5 px). That is the room the diagram keeps for them.',
    );
    // With the values off, the name of a bus has the room of its whole label.
    await user.click(screen.getByTestId('sld-figure-voltages'));
    await user.click(screen.getByTestId('sld-figure-angles'));
    await user.click(screen.getByTestId('sld-figure-powers'));
    expect(screen.getByTestId('sld-figure-size-note')).toHaveTextContent(
      'Set smaller than 12 px, so that nothing is drawn over anything else: the names of the devices (11 px).',
    );
  });

  it('says how many values the diagram has no place for, where there are any', () => {
    const { unmount } = render(<Harness source={large} />);
    const note = screen.getByTestId('sld-figure-left-off');
    expect(note).toHaveTextContent(
      /^\d+ values have no place on the diagram that is clear of everything else, and are left off, as on the diagram itself\. Moving things apart there, or Tidy diagram, gives them room\.$/,
    );
    unmount();
    render(<Harness source={plain} />);
    expect(screen.queryByTestId('sld-figure-left-off')).toBeNull();
  });

  it('shows the figure fitted to its pane, or at its own size, or at twice that', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    const preview = screen.getByTestId('sld-figure-preview');
    const width = Number(preview.dataset.width);
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
    expect(preview.className).toContain('max-w-full');

    await user.click(screen.getByRole('button', { name: '200%' }));
    expect(screen.getByRole('button', { name: '200%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'false');
    expect(preview).toHaveStyle({ width: `${2 * width}px` });
    await user.click(screen.getByRole('button', { name: '100%' }));
    expect(preview).toHaveStyle({ width: `${width}px` });
  });

  it('says when the fitted figure is too small to read, and shows it at its own size when asked', async () => {
    const user = userEvent.setup();
    // jsdom lays nothing out: the pane of the preview is given a size here.
    const paneSize = { width: 0, height: 0 };
    const sized = (side: 'width' | 'height') => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'sld-figure-preview-pane' ? paneSize[side] : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized('width'));
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized('height'));
    try {
      // A pane with no size yet says nothing.
      const first = render(<Harness source={solvedCase} />);
      expect(screen.queryByTestId('sld-figure-fit-note')).toBeNull();
      first.unmount();

      // A short pane: the figure is fitted to its height, 8 px in from each edge.
      Object.assign(paneSize, { width: 900, height: 316 });
      const short = render(<Harness source={solvedCase} />);
      const height = Number(screen.getByTestId('sld-figure-preview').dataset.height);
      const percent = Math.round((300 / height) * 100);
      expect(percent).toBeLessThan(40);
      expect(screen.getByTestId('sld-figure-fit-note')).toHaveTextContent(
        `Fitted to this window the figure is shown at ${percent}% of its size, too small to read its text.`,
      );
      await user.click(screen.getByRole('button', { name: 'Show at 100%' }));
      expect(screen.getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('sld-figure-fit-note')).toBeNull();
      // Fitted again, it says so again.
      await user.click(screen.getByRole('button', { name: 'Fit' }));
      expect(screen.getByTestId('sld-figure-fit-note')).toBeInTheDocument();
      short.unmount();

      // A pane the figure fits into at its own size: nothing to say.
      Object.assign(paneSize, { width: 4000, height: 4000 });
      render(<Harness source={solvedCase} />);
      expect(screen.queryByTestId('sld-figure-fit-note')).toBeNull();
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it('shows what a power flow gives as not chosen before one has run, and says beside each what it needs', () => {
    const onChange = vi.fn();
    const before = render(<Harness source={plain} onChange={onChange} />);
    for (const id of ['voltages', 'angles', 'flows', 'powers', 'limit-marks']) {
      const box = screen.getByTestId(`sld-figure-${id}`);
      expect(box, id).toBeDisabled();
      // Empty, though the settings have it chosen: it is not on the figure.
      expect(box, id).not.toBeChecked();
      expect(screen.getByTestId(`sld-figure-${id}-unavailable`)).toHaveTextContent(
        '(needs a power flow)',
      );
    }
    for (const id of ['bus-names', 'device-names', 'chips']) {
      expect(screen.getByTestId(`sld-figure-${id}`)).toBeEnabled();
      expect(screen.getByTestId(`sld-figure-${id}`)).toBeChecked();
      expect(screen.queryByTestId(`sld-figure-${id}-unavailable`)).toBeNull();
    }
    // Showing them empty chooses nothing.
    expect(onChange).not.toHaveBeenCalled();
    before.unmount();

    // With a power flow they are what was chosen for them, and say nothing more.
    render(<Harness source={solvedCase} initial={{ angles: false }} />);
    for (const [id, chosen] of [
      ['voltages', true],
      ['angles', false],
      ['flows', true],
      ['powers', true],
      ['limit-marks', false],
    ] as const) {
      const box = screen.getByTestId(`sld-figure-${id}`);
      expect(box, id).toBeEnabled();
      expect((box as HTMLInputElement).checked, id).toBe(chosen);
      expect(screen.queryByTestId(`sld-figure-${id}-unavailable`)).toBeNull();
    }
  });

  it('says so, and offers nothing to save, when the diagram has nothing on it', () => {
    render(<Harness source={{ nodes: [], edges: [], pflow: null }} />);
    expect(screen.getByTestId('sld-figure-empty')).toHaveTextContent(
      'Nothing to draw: the diagram has no buses yet.',
    );
    expect(screen.queryByTestId('sld-figure-preview')).toBeNull();
    for (const format of ['svg', 'pdf', 'png']) {
      expect(screen.getByTestId(`sld-figure-download-${format}`)).toBeDisabled();
    }
    cleanup();
    // And while the canvas has no diagram to hand over.
    render(<Harness source={null} />);
    expect(screen.getByTestId('sld-figure-empty')).toBeVisible();
  });
});

describe('<SldFigureDialog /> saves the figure', () => {
  it('saves the SVG it shows, named for the case, and says that it did', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    // Before anything is saved: what the three are, where the result will be said.
    const status = screen.getByTestId('sld-figure-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/SVG and PDF are vector.*PNG is pixels/);
    const shown = previewSvg();

    await user.click(screen.getByRole('button', { name: 'Download SVG' }));

    await waitFor(() => expect(downloads.filenames).toHaveLength(1));
    const filename = downloads.filenames[0]!;
    expect(filename).toMatch(/^ieee14_full_figure_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.svg$/);
    expect(downloads.blobs[0]!.type).toBe('image/svg+xml;charset=utf-8');
    expect(await readBlob(downloads.blobs[0]!)).toBe(shown);
    const preview = screen.getByTestId('sld-figure-preview');
    const inches = `${(Number(preview.dataset.width) / 96).toFixed(1)} x ${(Number(preview.dataset.height) / 96).toFixed(1)} in, vector`;
    expect(status).toHaveTextContent(`Saved ${filename} (${inches}).`);
    expect(toastSuccess).toHaveBeenCalledWith(`Saved ${filename}`);
  });

  it('saves a PDF of the same figure: one page, with its text as text', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloads.filenames).toHaveLength(1));
    expect(downloads.filenames[0]).toMatch(/^ieee14_full_figure_.*\.pdf$/);
    expect(downloads.blobs[0]!.type).toBe('application/pdf');
    const pdf = await readBlob(downloads.blobs[0]!);
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('/BaseFont /Helvetica');
    expect(pdf).toContain('(BUS1) Tj');
    expect(pdf).toContain('/Title (ieee14_full: single-line diagram)');
    // As large as the figure shown: three quarters of a point to the px.
    const preview = screen.getByTestId('sld-figure-preview');
    const [width, height] = [Number(preview.dataset.width), Number(preview.dataset.height)];
    expect(pdf).toContain(`/MediaBox [0 0 ${width * 0.75} ${height * 0.75}]`);
  });

  it('rasterises a PNG of the SVG it shows at the resolution chosen, and says how many pixels that is', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    const preview = screen.getByTestId('sld-figure-preview');
    const [width, height] = [Number(preview.dataset.width), Number(preview.dataset.height)];
    const pixels = (dpi: number): string =>
      `${Math.round((width * dpi) / 96)} x ${Math.round((height * dpi) / 96)}`;
    expect(screen.getByTestId('sld-figure-dpi')).toHaveValue('300');
    expect(screen.getByTestId('sld-figure-png-size')).toHaveTextContent(
      `A PNG at 300 dpi is ${pixels(300)} pixels.`,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'PNG resolution' }), '600');
    expect(screen.getByTestId('sld-figure-png-size')).toHaveTextContent(
      `A PNG at 600 dpi is ${pixels(600)} pixels.`,
    );
    await user.click(screen.getByRole('button', { name: 'Download PNG' }));

    await waitFor(() => expect(downloads.filenames).toHaveLength(1));
    expect(svgToPng).toHaveBeenCalledTimes(1);
    expect(svgToPng).toHaveBeenCalledWith(previewSvg(), width, height, 600);
    expect(downloads.filenames[0]).toMatch(/^ieee14_full_figure_.*\.png$/);
    expect(downloads.blobs[0]!.type).toBe('image/png');
    expect(screen.getByTestId('sld-figure-status')).toHaveTextContent(
      `Saved ${downloads.filenames[0]} (${pixels(600)} pixels at 600 dpi).`,
    );
  });

  it('offers the resolutions with what each is for', () => {
    render(<Harness source={solvedCase} />);
    const options = within(screen.getByTestId('sld-figure-dpi')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '96 dpi (screen)',
      '150 dpi',
      '300 dpi (print)',
      '600 dpi (line art)',
    ]);
  });

  it('does not offer a PNG larger than a browser can draw, says why, and still offers the vector files', async () => {
    const user = userEvent.setup();
    render(<Harness source={large} />);
    await user.selectOptions(screen.getByTestId('sld-figure-dpi'), '600');

    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeDisabled();
    expect(screen.getByTestId('sld-figure-png-size')).toHaveTextContent(
      /^PNG: \d+ x \d+ pixels is more than a browser can draw\. Choose a lower resolution, or save the figure as SVG or PDF, which have no pixels\.$/,
    );
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();

    await user.selectOptions(screen.getByTestId('sld-figure-dpi'), '96');
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
  });

  it('says what went wrong when the browser gives no picture, and that nothing was saved', async () => {
    svgToPng.mockRejectedValue(new Error('The browser could not write the figure as a PNG.'));
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    await user.click(screen.getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith('The figure could not be saved', {
      description: 'The browser could not write the figure as a PNG.',
    });
    expect(downloads.filenames).toEqual([]);
    expect(screen.getByTestId('sld-figure-status')).not.toHaveTextContent(/Saved/);
    // And it can be tried again.
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
  });

  it('names the file of a part of the diagram as one', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} picked={new Set(['1', '2', '5'])} />);
    await user.click(screen.getByRole('radio', { name: 'Selection only (3 picked)' }));
    expect(
      said()
        .filter((text) => /^BUS\d+$/.test(text))
        .sort(),
    ).toEqual(['BUS1', 'BUS2', 'BUS5']);
    await user.click(screen.getByRole('button', { name: 'Download SVG' }));
    await waitFor(() => expect(downloads.filenames).toHaveLength(1));
    expect(downloads.filenames[0]).toMatch(/^ieee14_full_figure-selection_.*\.svg$/);
  });

  it('no longer says a file was saved once the figure is another, or the dialog is opened again', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    await user.click(screen.getByRole('button', { name: 'Download SVG' }));
    await waitFor(() =>
      expect(screen.getByTestId('sld-figure-status')).toHaveTextContent(/^Saved /),
    );

    // Another figure than the one that was saved.
    await user.click(screen.getByTestId('sld-figure-angles'));
    expect(screen.getByTestId('sld-figure-status')).not.toHaveTextContent(/Saved/);

    await user.click(screen.getByRole('button', { name: 'Download SVG' }));
    await waitFor(() =>
      expect(screen.getByTestId('sld-figure-status')).toHaveTextContent(/^Saved /),
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('sld-figure-status')).not.toHaveTextContent(/Saved/);
  });
});

describe('<SldFigureDialog /> and the keyboard', () => {
  it('gives the focus back to the export menu over the diagram when it closes', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('export-menu-trigger')).toHaveFocus();
  });

  it('gives it back to what opened it, where that is still on the page', async () => {
    const user = userEvent.setup();
    render(<Harness source={solvedCase} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const opener = screen.getByTestId('export-menu-trigger');
    opener.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });
});
