/**
 * The figure of the diagram: a drawing of it in the style of a figure for a
 * paper, with what it shows chosen here and saved as SVG, PDF or PNG.
 *
 * The dialog shows the figure itself. The preview is the SVG that Download
 * SVG writes, the PDF is made from the same list of shapes, and the PNG is
 * that SVG rasterised, so what is seen is what is saved. Every choice
 * redraws it at once.
 *
 * The figure is made from the diagram as it is arranged when the dialog
 * opens (`figure/drawFigure.ts`): the lines along their routes, the symbols
 * where they stand, the labels in the places the diagram keeps for them.
 * What belongs to the screen is not on it: the selection, the handles of a
 * line that is being moved, the minimap, the colours of the theme.
 *
 * The choices are settings of the diagram of this case. The canvas keeps
 * them with its layout (`onSettingsChange`), so they come back with the
 * case, on this machine or with a bundle on another.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { downloadBlob } from '@/components/export/downloadBlob';
import { buildFilename, makeTimestamp } from '@/components/export/exportFilename';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import {
  drawFigure,
  figurePicture,
  figureScope,
  figureShowsValues,
  type FigureSource,
  type TextKind,
} from './figure/drawFigure';
import { figureToPdf } from './figure/figurePdf';
import { PX_PER_INCH, pngRefusal, pngSize, svgToPng } from './figure/figurePng';
import {
  DEFAULT_FIGURE_SETTINGS,
  FIGURE_DPIS,
  FIGURE_FONTS,
  FIGURE_FONT_LABEL,
  FIGURE_FONT_SIZES,
  FIGURE_LINE_WIDTHS,
  type FigureFont,
  type FigureFormat,
  type FigureSettings,
} from './figure/figureSettings';
import { figureToSvg } from './figure/figureSvg';

export interface SldFigureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The diagram as it is drawn now; `null` while there is none to draw. */
  source: FigureSource | null;
  /** The buses and devices picked together on the diagram, when there are two or more. */
  picked: ReadonlySet<string> | null;
  settings: FigureSettings;
  onSettingsChange: (next: FigureSettings) => void;
  /** The name of the case, which the files are named after. */
  caseName: string;
}

/**
 * The control over the diagram that leads to this dialog: the diagram's own
 * export menu (`SldCanvas`). Found by its test ids and not handed in: the
 * canvas loads this module only when a figure is first asked for.
 */
const WAY_IN = '[data-testid="sld-canvas"] [data-testid="export-menu-trigger"]';

/** What each kind of text is called where the dialog says it is set smaller than asked. */
const TEXT_KIND_LABEL: Record<TextKind, string> = {
  bus: 'the labels of the buses',
  device: 'the names of the devices',
  readout: 'the P and Q of the devices',
  flow: 'the flows of the lines',
  chip: 'the chips of the controllers',
  chain: 'the control chains',
};

/** The kinds whose size the text size sets directly; the others are set smaller by design. */
const MAIN_TEXT_KINDS: readonly TextKind[] = ['bus', 'device', 'readout', 'flow'];

/**
 * How much smaller than asked a kind of text is set before the dialog says
 * so. The P and Q of a device stand in two lines of 11 px, so they are half
 * a px under the default size, which nobody needs telling.
 */
const SIZE_NOTE_FROM = 1;

const DPI_HINT: Record<number, string> = { 96: 'screen', 300: 'print', 600: 'line art' };

/** Why a value of the power flow cannot be chosen before one has run: said beside each of them. */
const NEEDS_PFLOW = 'needs a power flow';

/** A text shown smaller than this many px on the screen is too small to read. */
const READABLE_PX = 6;

/** The padding of the pane the preview is fitted into, either side. */
const PANE_PADDING = 8;

const ZOOMS = [
  { value: 'fit', label: 'Fit' },
  { value: '100', label: '100%' },
  { value: '200', label: '200%' },
] as const;
type Zoom = (typeof ZOOMS)[number]['value'];

const FORMAT_LABEL: Record<FigureFormat, string> = { svg: 'SVG', pdf: 'PDF', png: 'PNG' };

const FORMAT_HINT: Record<FigureFormat, string> = {
  svg: 'Vector: plain shapes and text, which a browser draws and a vector editor can change.',
  pdf: 'Vector, with text that can be selected; pdfLaTeX places it with \\includegraphics. It names Helvetica, Times or Courier and does not embed them.',
  png: 'Pixels, at the resolution chosen. For a word processor or a slide.',
};

const FIELD_CLASS = cn(
  'border-input bg-background text-foreground h-7 rounded-[var(--radius-md)] border px-1.5 text-xs',
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

const CHECK_CLASS = cn(
  'border-border mt-0.5 h-3.5 w-3.5 shrink-0 rounded border',
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
);

interface ChoiceProps {
  testId: string;
  label: string;
  hint?: string;
  checked: boolean;
  /**
   * Why it cannot be chosen now, in a few words; absent while it can. It
   * stands beside the label, and the box is drawn empty: what cannot be
   * chosen is not on the figure, whatever was chosen for it before.
   */
  unavailable?: string;
  onChange: (checked: boolean) => void;
}

/** One thing a figure shows or leaves off. */
function Show({ testId, label, hint, checked, unavailable, onChange }: ChoiceProps) {
  const disabled = unavailable !== undefined;
  const dimmed = disabled ? 'opacity-60' : undefined;
  return (
    <label
      className={cn('flex items-start gap-2', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
    >
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={cn(CHECK_CLASS, dimmed)}
      />
      <span className="flex flex-col">
        <span>
          <span className={cn('text-foreground', dimmed)}>{label}</span>
          {disabled ? (
            <span className="text-muted-foreground" data-testid={`${testId}-unavailable`}>
              {' '}
              ({unavailable})
            </span>
          ) : null}
        </span>
        {hint !== undefined ? (
          <span className={cn('text-muted-foreground leading-snug', dimmed)}>{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-foreground mb-1 text-xs font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

/** `12 px` as `12`, `9.5 px` as `9.5`. */
const px = (value: number): string => String(Math.round(value * 10) / 10);

/** A size in px of the diagram as points, of which an inch has 72: `10` as `7.5`. */
const points = (value: number): string => px((value * 72) / PX_PER_INCH);

/** A length of the diagram in inches, to one decimal. */
const inches = (value: number): string => (value / PX_PER_INCH).toFixed(1);

export function SldFigureDialog({
  open,
  onOpenChange,
  source,
  picked,
  settings,
  onSettingsChange,
  caseName,
}: SldFigureDialogProps) {
  const [part, setPart] = useState<'all' | 'picked'>('all');
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [busy, setBusy] = useState<FigureFormat | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The dialog stays mounted while it is closed, so what it said of the last
  // file would still be there when it opens again, over another figure.
  const [wasOpen, setWasOpen] = useState(open);
  // What had the focus when the dialog was opened, to give it back on close.
  // The dialog is opened from a state of the canvas and not by a trigger of
  // its own, so nothing else knows where the focus came from.
  const [opener, setOpener] = useState<Element | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSaved(null);
      setOpener(typeof document === 'undefined' ? null : document.activeElement);
    }
  }
  // The pane the preview stands in, and its size: how small the figure is
  // shown when it is fitted into it is worked out from the two.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (pane === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => {
      const [width, height] = [pane.clientWidth, pane.clientHeight];
      setRoom((was) =>
        was !== null && was.width === width && was.height === height ? was : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);
  const styleName = useId();
  const partName = useId();
  const lineWidthId = useId();
  const fontId = useId();
  const fontSizeId = useId();
  const dpiId = useId();

  // A selection that is gone (the dialog was opened again with nothing
  // picked) leaves the whole diagram.
  const showPicked = part === 'picked' && picked !== null;
  const values = source !== null && figureShowsValues(source, settings);
  // The picture is the costly part, and only whether the values of the
  // power flow are on it changes it; every other choice redraws from it.
  const picture = useMemo(
    () => (source === null ? null : figurePicture(source, values)),
    [source, values],
  );
  const figure = useMemo(() => {
    if (source === null || picture === null) return null;
    const only = showPicked && picked !== null ? figureScope(source.nodes, picked) : null;
    return drawFigure(source, picture, settings, only);
  }, [source, picture, settings, showPicked, picked]);
  const title = `${caseName}: single-line diagram`;
  const svg = useMemo(
    () => (figure === null ? null : figureToSvg(figure, { title })),
    [figure, title],
  );
  const previewSrc = useMemo(
    () => (svg === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
    [svg],
  );

  const change = (patch: Partial<FigureSettings>): void => {
    setSaved(null);
    onSettingsChange({ ...settings, ...patch });
  };

  const hasPflow = source?.pflow?.converged === true;
  const empty = figure === null || figure.shown === 0;
  const width = figure?.box.width ?? 0;
  const height = figure?.box.height ?? 0;
  const pixels = pngSize(width, height, settings.dpi);
  const pngBlocked = empty ? null : pngRefusal(pixels);
  // How large the text prints at full size, in points: what is left of it
  // when the figure is placed at the width of a column is what a reader of
  // the paper has to make out.
  const drawnSizes = figure === null ? [] : figure.drawnKinds.map((kind) => figure.textSizes[kind]);
  const textInPoints =
    drawnSizes.length === 0
      ? 'no text'
      : Math.min(...drawnSizes) === Math.max(...drawnSizes)
        ? `text ${points(Math.max(...drawnSizes))} pt`
        : `text ${points(Math.min(...drawnSizes))} to ${points(Math.max(...drawnSizes))} pt`;
  // Fitted to its pane a tall figure is shown at a fraction of its size,
  // and its text with it: under `READABLE_PX` the preview says so, and how
  // to read it. The figure is never shown larger than it is.
  const fitScale =
    room === null || empty || room.width === 0 || room.height === 0
      ? null
      : Math.min(
          1,
          (room.width - 2 * PANE_PADDING) / width,
          (room.height - 2 * PANE_PADDING) / height,
        );
  const tooSmallToRead =
    zoom === 'fit' &&
    fitScale !== null &&
    fitScale > 0 &&
    drawnSizes.length > 0 &&
    Math.min(...drawnSizes) * fitScale < READABLE_PX;
  const smaller =
    figure === null
      ? []
      : MAIN_TEXT_KINDS.filter(
          (kind) =>
            figure.drawnKinds.includes(kind) &&
            settings.fontSize - figure.textSizes[kind] >= SIZE_NOTE_FROM,
        );

  const save = async (format: FigureFormat): Promise<void> => {
    if (figure === null || svg === null) return;
    setBusy(format);
    setSaved(null);
    try {
      const blob =
        format === 'svg'
          ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
          : format === 'pdf'
            ? new Blob([figureToPdf(figure, { title })], { type: 'application/pdf' })
            : await svgToPng(svg, width, height, settings.dpi);
      const filename = buildFilename({
        caseName,
        runId: undefined,
        panel: showPicked ? 'figure-selection' : 'figure',
        ext: format,
        timestamp: makeTimestamp(),
      });
      downloadBlob(blob, filename);
      const what =
        format === 'png'
          ? `${pixels.width} x ${pixels.height} pixels at ${settings.dpi} dpi`
          : `${inches(width)} x ${inches(height)} in, vector`;
      setSaved(`Saved ${filename} (${what}).`);
      toast.success(`Saved ${filename}`);
    } catch (err) {
      toast.error('The figure could not be saved', {
        description: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        widthClassName="max-w-[min(72rem,calc(100vw-2rem))]"
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-3 p-4"
        data-testid="sld-figure-dialog"
        onCloseAutoFocus={(event) => {
          // Back to what opened it. An item of a menu or of the command
          // palette is gone by now: the export menu over the diagram, which
          // leads to the same dialog, takes the focus in its place.
          const from =
            opener instanceof HTMLElement && opener.isConnected && opener !== document.body
              ? opener
              : document.querySelector<HTMLElement>(WAY_IN);
          if (from === null) return;
          event.preventDefault();
          from.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Figure for a paper</DialogTitle>
          <DialogDescription>
            This is the publication look of the diagram: as it is arranged now, drawn for print,
            with no selection, no handles and no screen colours. Choose what it shows, then save it
            as SVG, PDF or PNG.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          {/* The figure itself. */}
          <div className="flex min-h-48 min-w-0 flex-1 flex-col gap-1.5">
            <div
              ref={setPane}
              className="border-border min-h-0 flex-1 overflow-auto rounded-[var(--radius-md)] border bg-white p-2"
              data-testid="sld-figure-preview-pane"
            >
              {previewSrc === null || empty ? (
                <p
                  className="p-4 text-sm text-neutral-600"
                  role="status"
                  data-testid="sld-figure-empty"
                >
                  Nothing to draw: the diagram has no buses yet.
                </p>
              ) : (
                <img
                  src={previewSrc}
                  alt={`Preview of the figure: ${figure.shown} buses and devices, ${
                    settings.monochrome ? 'black and white' : 'in colour'
                  }`}
                  data-testid="sld-figure-preview"
                  data-width={width}
                  data-height={height}
                  className={cn(
                    'mx-auto block',
                    zoom === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none',
                  )}
                  style={
                    zoom === 'fit'
                      ? { width, height: 'auto' }
                      : { width: (width * Number(zoom)) / 100 }
                  }
                />
              )}
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
              <span data-testid="sld-figure-size">
                {empty
                  ? ''
                  : `${inches(width)} x ${inches(height)} in at full size (${width} x ${height} px of the diagram), ${textInPoints}, ${figure.shown} buses and devices`}
              </span>
              <span className="flex items-center gap-1" role="group" aria-label="Preview zoom">
                <span>Preview</span>
                {ZOOMS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`sld-figure-zoom-${value}`}
                    aria-pressed={zoom === value}
                    onClick={() => setZoom(value)}
                    className={cn(
                      'border-border rounded border px-1.5 py-0.5',
                      'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                      zoom === value
                        ? 'bg-primary/10 text-foreground'
                        : 'hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
            {tooSmallToRead && fitScale !== null ? (
              <div className="text-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug">
                <p role="status" data-testid="sld-figure-fit-note">
                  Fitted to this window the figure is shown at {Math.round(fitScale * 100)}% of its
                  size, too small to read its text.
                </p>
                <button
                  type="button"
                  data-testid="sld-figure-fit-note-zoom"
                  onClick={() => setZoom('100')}
                  className={cn(
                    'border-border hover:bg-muted/60 rounded border px-1.5 py-0.5',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  )}
                >
                  Show at 100%
                </button>
              </div>
            ) : null}
          </div>

          {/* What it shows, and how. */}
          <div
            className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto pr-1 text-xs md:w-80"
            data-testid="sld-figure-options"
          >
            <Section title="Style">
              <div className="flex gap-4">
                {(
                  [
                    [true, 'Black and white (print)', 'sld-figure-style-mono'],
                    [false, 'Colour', 'sld-figure-style-colour'],
                  ] as const
                ).map(([mono, label, testId]) => (
                  <label key={testId} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name={styleName}
                      data-testid={testId}
                      checked={settings.monochrome === mono}
                      onChange={() => change({ monochrome: mono })}
                    />
                    <span className="text-foreground">{label}</span>
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground leading-snug">
                {settings.monochrome
                  ? 'Everything in black on white, with nothing told by colour.'
                  : 'A bus or a line near or past a limit is drawn in amber or red.'}
              </p>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                <label htmlFor={lineWidthId} className="text-foreground">
                  Line width
                </label>
                <select
                  id={lineWidthId}
                  data-testid="sld-figure-line-width"
                  value={String(settings.lineWidth)}
                  onChange={(e) => change({ lineWidth: Number(e.target.value) })}
                  className={FIELD_CLASS}
                >
                  {[...new Set([...FIGURE_LINE_WIDTHS, settings.lineWidth])]
                    .sort((a, b) => a - b)
                    .map((value) => (
                      <option key={value} value={String(value)}>
                        {px(value)} px
                      </option>
                    ))}
                </select>
                <label htmlFor={fontId} className="text-foreground">
                  Font
                </label>
                <select
                  id={fontId}
                  data-testid="sld-figure-font"
                  value={settings.font}
                  onChange={(e) => change({ font: e.target.value as FigureFont })}
                  className={FIELD_CLASS}
                >
                  {FIGURE_FONTS.map((font) => (
                    <option key={font} value={font}>
                      {FIGURE_FONT_LABEL[font]}
                    </option>
                  ))}
                </select>
                <label htmlFor={fontSizeId} className="text-foreground">
                  Text size
                </label>
                <select
                  id={fontSizeId}
                  data-testid="sld-figure-font-size"
                  value={String(settings.fontSize)}
                  onChange={(e) => change({ fontSize: Number(e.target.value) })}
                  className={FIELD_CLASS}
                >
                  {[...new Set([...FIGURE_FONT_SIZES, settings.fontSize])]
                    .sort((a, b) => a - b)
                    .map((value) => (
                      <option key={value} value={String(value)}>
                        {px(value)} px
                      </option>
                    ))}
                </select>
              </div>
              {smaller.length > 0 && figure !== null ? (
                <p
                  className="text-muted-foreground leading-snug"
                  role="status"
                  data-testid="sld-figure-size-note"
                >
                  Set smaller than {px(settings.fontSize)} px, so that nothing is drawn over
                  anything else:{' '}
                  {smaller
                    .map((kind) => `${TEXT_KIND_LABEL[kind]} (${px(figure.textSizes[kind])} px)`)
                    .join(', ')}
                  . That is the room the diagram keeps for them.
                </p>
              ) : null}
            </Section>

            <Section title="Show">
              <Show
                testId="sld-figure-bus-names"
                label="Bus names"
                checked={settings.busNames}
                onChange={(busNames) => change({ busNames })}
              />
              <Show
                testId="sld-figure-device-names"
                label="Names of generators, loads and shunts"
                checked={settings.deviceNames}
                onChange={(deviceNames) => change({ deviceNames })}
              />
              <Show
                testId="sld-figure-chips"
                label="Controllers"
                hint="The chips on a generator (SG, AVR, GOV, PSS) and the badges of other controllers."
                checked={settings.chips}
                onChange={(chips) => change({ chips })}
              />
              {/* What a power flow gives. Before one, what to do about it
                  stands over them, where the first of them is, and each
                  says beside its name what it is waiting for. */}
              <p
                className={cn(
                  'mt-1 leading-snug',
                  hasPflow ? 'text-foreground font-medium' : 'text-foreground',
                )}
                data-testid={hasPflow ? 'sld-figure-pflow-heading' : 'sld-figure-no-pflow'}
              >
                {hasPflow
                  ? 'From the power flow'
                  : 'The five below come from a power flow, and none has run yet. Close this, press Run PF, and open the figure again to choose them.'}
              </p>
              <Show
                testId="sld-figure-voltages"
                label="Voltages"
                checked={settings.voltages}
                unavailable={hasPflow ? undefined : NEEDS_PFLOW}
                onChange={(voltages) => change({ voltages })}
              />
              <Show
                testId="sld-figure-angles"
                label="Angles"
                checked={settings.angles}
                unavailable={hasPflow ? undefined : NEEDS_PFLOW}
                onChange={(angles) => change({ angles })}
              />
              <Show
                testId="sld-figure-flows"
                label="Line flows"
                hint="The MW of each line, with an arrow the way it flows."
                checked={settings.flows}
                unavailable={hasPflow ? undefined : NEEDS_PFLOW}
                onChange={(flows) => change({ flows })}
              />
              <Show
                testId="sld-figure-powers"
                label="P and Q of generators and loads"
                checked={settings.powers}
                unavailable={hasPflow ? undefined : NEEDS_PFLOW}
                onChange={(powers) => change({ powers })}
              />
              <Show
                testId="sld-figure-limit-marks"
                label="Limit marks"
                hint="A triangle at a bus or generator on a limit, and a heavier line near its rating."
                checked={settings.limitMarks}
                unavailable={hasPflow ? undefined : NEEDS_PFLOW}
                onChange={(limitMarks) => change({ limitMarks })}
              />
              {figure !== null && figure.leftOff > 0 ? (
                <p
                  className="text-muted-foreground leading-snug"
                  role="status"
                  data-testid="sld-figure-left-off"
                >
                  {figure.leftOff === 1 ? '1 value has' : `${figure.leftOff} values have`} no place
                  on the diagram that is clear of everything else, and{' '}
                  {figure.leftOff === 1 ? 'is' : 'are'} left off, as on the diagram itself. Moving
                  things apart there, or Tidy diagram, gives them room.
                </p>
              ) : null}
            </Section>

            <Section title="Part of the diagram">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name={partName}
                  data-testid="sld-figure-part-all"
                  checked={!showPicked}
                  onChange={() => {
                    setSaved(null);
                    setPart('all');
                  }}
                />
                <span className="text-foreground">Whole diagram</span>
              </label>
              <label
                className={cn(
                  'flex items-center gap-1.5',
                  picked === null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                )}
              >
                <input
                  type="radio"
                  name={partName}
                  data-testid="sld-figure-part-picked"
                  checked={showPicked}
                  disabled={picked === null}
                  onChange={() => {
                    setSaved(null);
                    setPart('picked');
                  }}
                />
                <span className="text-foreground">
                  Selection only{picked !== null ? ` (${picked.size} picked)` : ''}
                </span>
              </label>
              <p className="text-muted-foreground leading-snug" data-testid="sld-figure-part-hint">
                {picked === null
                  ? 'Nothing is selected. To make a figure of a part, close this, hold Shift and drag a box round the part on the diagram (or hold Ctrl and click each bus), then open the figure again.'
                  : 'The picked buses with their generators, loads and shunts, and the lines that run between two of them.'}
              </p>
            </Section>

            <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <p className="text-muted-foreground leading-snug">
                These choices are kept with the layout of the case.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="sld-figure-reset"
                onClick={() => {
                  setSaved(null);
                  onSettingsChange({ ...DEFAULT_FIGURE_SETTINGS });
                }}
              >
                Reset to defaults
              </Button>
            </div>
          </div>
        </div>
        {/* Saving is under the figure and the choices, always in view: the
            choices scroll in a short window, and what they are for must not
            scroll away with them. */}
        <div
          className="border-border flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-t pt-3"
          data-testid="sld-figure-save"
        >
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5 text-xs">
            <p
              className={cn(
                'leading-snug',
                saved !== null ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
              role="status"
              aria-live="polite"
              data-testid="sld-figure-status"
            >
              {saved ??
                'SVG and PDF are vector: sharp at any size, and PDF is what LaTeX takes. PNG is pixels, at the resolution chosen. The file goes to your downloads folder.'}
            </p>
            <p className="text-muted-foreground leading-snug" data-testid="sld-figure-png-size">
              {empty
                ? ''
                : pngBlocked !== null
                  ? `PNG: ${pngBlocked}`
                  : `A PNG at ${settings.dpi} dpi is ${pixels.width} x ${pixels.height} pixels.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor={dpiId} className="text-foreground">
              PNG resolution
            </label>
            <select
              id={dpiId}
              data-testid="sld-figure-dpi"
              value={String(settings.dpi)}
              onChange={(e) => change({ dpi: Number(e.target.value) })}
              className={FIELD_CLASS}
            >
              {[...new Set([...FIGURE_DPIS, settings.dpi])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={String(value)}>
                    {value} dpi{DPI_HINT[value] !== undefined ? ` (${DPI_HINT[value]})` : ''}
                  </option>
                ))}
            </select>
            {(['svg', 'pdf', 'png'] as const).map((format) => (
              <Button
                key={format}
                type="button"
                size="sm"
                variant="primary"
                data-testid={`sld-figure-download-${format}`}
                title={FORMAT_HINT[format]}
                disabled={empty || busy !== null || (format === 'png' && pngBlocked !== null)}
                onClick={() => void save(format)}
              >
                {busy === format ? 'Saving…' : `Download ${FORMAT_LABEL[format]}`}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="sld-figure-close"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
