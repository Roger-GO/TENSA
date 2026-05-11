/**
 * ExportMenu — dropdown trigger that exposes CSV / PNG / MAT export
 * options for a panel (chart, table, SVG canvas).
 *
 * Design:
 *
 * - The menu's trigger is a small `Button` (variant="ghost", size="sm").
 *   The trigger lives inside a `<TooltipProvider>` so the disabled
 *   state surfaces "No data to export" without any extra wiring.
 * - The dropdown body is a Radix Popover. The format buttons are
 *   gated by the `formats` prop (CSV / PNG / MAT) so a panel that has
 *   no PNG path (e.g., ScrubControl) doesn't show the option.
 * - When the user picks a format, the menu calls one of the supplied
 *   handler props (`onExportCsv`, `onExportPng`, `onExportMat`). Each
 *   handler returns a `Blob` (or null on "nothing to export"); the
 *   menu turns the Blob into a download via `URL.createObjectURL` +
 *   anchor click + revoke.
 * - Concurrency: only one export per menu instance can run at a time.
 *   The menu shows an inline spinner (via `Button` `disabled` state +
 *   "Exporting…" label) while a handler is in flight.
 *
 * File naming: `{caseName}_{runIdPrefix}_{panel}_{timestamp}.{ext}`
 * per the v2.0 plan. The caller passes `caseName`, optional
 * `runIdPrefix` (8-char default slice of a run id), `panel` (kebab-case
 * panel name like `time-series` / `results-table` / `sld`); the menu
 * fills in `timestamp` and `ext`.
 */
import { useCallback, useState } from 'react';
import { downloadBlob } from './downloadBlob';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/** Supported export formats. The set of buttons rendered is `formats`. */
export type ExportFormat = 'csv' | 'png' | 'mat';

export interface ExportMenuProps {
  /**
   * Formats this panel supports. Pass the subset that's meaningful for
   * the panel — e.g., `['csv']` for a scrub control (no chart to
   * rasterise), `['csv', 'png']` for a chart, `['png']` for an SVG
   * canvas, `['csv', 'mat']` for the EIG state matrix.
   */
  formats: readonly ExportFormat[];
  /**
   * Disable the menu entirely. The trigger renders but is non-interactive
   * and shows the `disabledTooltip` (defaults to "No data to export").
   * Use this for empty panels.
   */
  disabled?: boolean;
  /**
   * Tooltip shown when `disabled` is true. Defaults to
   * "No data to export."
   */
  disabledTooltip?: string;
  /**
   * Tooltip shown for the MAT button specifically. Defaults to the
   * v1.5 stub message ("MAT export available after Unit 6 (EIG)") so
   * users understand why the option is present-but-not-functional.
   */
  matTooltip?: string;
  /**
   * Stable case name used in the auto-generated filename. Pass the
   * basename (no extension); the menu sanitises into a filesystem-safe
   * slug. Defaults to "case" for blank sessions.
   */
  caseName?: string;
  /**
   * Optional run id (full UUID-like string). The first 8 chars are
   * used in the filename to disambiguate runs of the same case. Pass
   * undefined for non-run-scoped panels (e.g., a Buses grid pre-PF).
   */
  runId?: string;
  /**
   * Panel slug used in the auto-generated filename. Examples:
   * `time-series`, `scrub`, `results-table-buses`, `sld`. Should be
   * kebab-case + filesystem-safe.
   */
  panel: string;
  /**
   * CSV handler. Returns a `Blob` (`text/csv`) or null/undefined to
   * signal "nothing to export" (the menu surfaces the disabled-tooltip
   * path instead). The menu does not pass any args — the caller
   * captures the panel's data in the closure.
   */
  onExportCsv?: () => Promise<Blob | null | undefined> | Blob | null | undefined;
  /**
   * PNG handler. Mirrors `onExportCsv`. Used by chart and SVG panels.
   */
  onExportPng?: () => Promise<Blob | null | undefined> | Blob | null | undefined;
  /**
   * MAT handler. Mirrors `onExportCsv`. Only supplied for the EIG
   * state matrix panel.
   */
  onExportMat?: () => Promise<Blob | null | undefined> | Blob | null | undefined;
  /** Optional class on the trigger button. */
  className?: string;
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  png: 'PNG',
  mat: 'MAT (.mat)',
};

const FORMAT_EXT: Record<ExportFormat, string> = {
  csv: 'csv',
  png: 'png',
  mat: 'mat',
};

/**
 * Sanitise a string into a filesystem-safe slug. Keeps `[A-Za-z0-9_-]`
 * verbatim, replaces everything else with `-`, collapses runs of `-`,
 * and trims leading/trailing `-`. An empty result falls back to `panel`.
 */
function slugify(s: string, fallback: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** ISO-ish timestamp suitable for filenames: `2026-05-09T13-45-22`. */
function makeTimestamp(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/**
 * Compose `{caseName}_{runIdPrefix}_{panel}_{timestamp}.{ext}` per the
 * plan. `runIdPrefix` is omitted (and the surrounding `_` collapsed)
 * when the caller didn't supply a run id.
 */
function buildFilename(args: {
  caseName: string;
  runId: string | undefined;
  panel: string;
  format: ExportFormat;
  timestamp: string;
}): string {
  const caseSlug = slugify(args.caseName, 'case');
  const panelSlug = slugify(args.panel, 'panel');
  const ext = FORMAT_EXT[args.format];
  const runPart = args.runId ? `_${slugify(args.runId.slice(0, 8), 'run')}` : '';
  return `${caseSlug}${runPart}_${panelSlug}_${args.timestamp}.${ext}`;
}

export function ExportMenu({
  formats,
  disabled = false,
  disabledTooltip = 'No data to export',
  matTooltip = 'MAT export available after Unit 6 (EIG)',
  caseName = 'case',
  runId,
  panel,
  onExportCsv,
  onExportPng,
  onExportMat,
  className,
}: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const runFormat = useCallback(
    async (format: ExportFormat) => {
      const handler = format === 'csv' ? onExportCsv : format === 'png' ? onExportPng : onExportMat;
      if (!handler) return;
      setBusy(true);
      try {
        const blob = await Promise.resolve(handler());
        if (!blob) {
          // Handler chose "nothing to export" — surface a toast.warning
          // so the user understands the click had no effect (rather
          // than puzzling over a silent menu). Per Unit 3 of the v2.0
          // polish plan: transient action results live on the global
          // toast surface, not inline.
          toast.warning(disabledTooltip);
          return;
        }
        const filename = buildFilename({
          caseName,
          runId,
          panel,
          format,
          timestamp: makeTimestamp(),
        });
        downloadBlob(blob, filename);
        toast.success(`Exported ${filename}`);
        // Close on success so the menu doesn't linger over the panel
        // post-download.
        setOpen(false);
      } catch (err) {
        // Surface as toast.error with the underlying detail in the
        // description so the user can paste it into a bug report.
        const detail = err instanceof Error ? err.message : 'unknown error';
        toast.error('Export failed; check browser settings.', {
          description: detail,
        });
      } finally {
        setBusy(false);
      }
    },
    [caseName, runId, panel, onExportCsv, onExportPng, onExportMat, disabledTooltip],
  );

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      data-testid="export-menu-trigger"
      data-busy={busy}
      className={cn('gap-1', className)}
      aria-label="Export"
    >
      {/* Inline glyph keeps the dependency footprint flat. */}
      <span aria-hidden="true" className="font-mono text-xs">
        ↓
      </span>
      <span className="text-xs">{busy ? 'Exporting…' : 'Export'}</span>
    </Button>
  );

  if (disabled) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block" data-testid="export-menu-disabled">
              {triggerButton}
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>{disabledTooltip}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-2" data-testid="export-menu" data-panel={panel}>
        <div className="flex flex-col gap-1">
          {formats.includes('csv') && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void runFormat('csv')}
              disabled={busy || !onExportCsv}
              className="justify-start"
              data-testid="export-menu-csv"
            >
              {FORMAT_LABEL.csv}
            </Button>
          )}
          {formats.includes('png') && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void runFormat('png')}
              disabled={busy || !onExportPng}
              className="justify-start"
              data-testid="export-menu-png"
            >
              {FORMAT_LABEL.png}
            </Button>
          )}
          {formats.includes('mat') && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void runFormat('mat')}
                    disabled={busy || !onExportMat}
                    className="justify-start"
                    data-testid="export-menu-mat"
                  >
                    {FORMAT_LABEL.mat}
                  </Button>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{matTooltip}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* Errors no longer surface inline here — Unit 3 of the v2.0
              polish plan routes export failures to the global toast
              surface (see `@/lib/toast`). The popover stays focused on
              format selection. */}
        </div>
      </PopoverContent>
    </Popover>
  );
}
