/**
 * ExportMenu — dropdown trigger that exposes CSV / PNG / MAT / COMTRADE
 * export options for a panel (chart, table, SVG canvas).
 *
 * Design:
 *
 * - The menu's trigger is a small `Button` (variant="ghost", size="sm").
 *   The trigger lives inside a `<TooltipProvider>` so the disabled
 *   state surfaces "No data to export" without any extra wiring.
 * - The dropdown body is a Radix Popover. The format buttons are
 *   gated by the `formats` prop (CSV / PNG / MAT / COMTRADE) so a panel
 *   that has no PNG path (e.g., ScrubControl) doesn't show the option.
 * - When the user picks a format, the menu calls one of the supplied
 *   handler props (`onExportCsv`, `onExportPng`, `onExportMat`,
 *   `onExportComtrade`). Each
 *   handler returns a `Blob` (or null on "nothing to export"); the
 *   menu turns the Blob into a download via `URL.createObjectURL` +
 *   anchor click + revoke.
 * - Concurrency: only one export per menu instance can run at a time.
 *   The menu shows an inline spinner (via `Button` `disabled` state +
 *   "Exporting…" label) while a handler is in flight.
 *
 * File naming: `{caseName}_{runIdPrefix}_{panel}_{timestamp}.{ext}`
 * (`exportFilename.ts`). The caller passes `caseName`, optional
 * `runIdPrefix` (8-char default slice of a run id), `panel` (kebab-case
 * panel name like `time-series` / `results-table` / `sld`); the menu
 * fills in `timestamp` and `ext`. A COMTRADE record is a `.zip` of two
 * files, so its name says what it is after the panel:
 * `{caseName}_{runIdPrefix}_{panel}-comtrade_{timestamp}.zip`.
 */
import { useCallback, useState } from 'react';
import { downloadBlob } from './downloadBlob';
import { buildFilename, makeTimestamp } from './exportFilename';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { NetworkError, ProblemDetailsError } from '@/api/client';
import { ExportRefusedError } from './exportError';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/** Supported export formats. The set of buttons rendered is `formats`. */
export type ExportFormat = 'csv' | 'png' | 'mat' | 'comtrade';

/** What a format's handler does: hand back the file, or nothing when there is none to make. */
type ExportHandler = () => Promise<Blob | null | undefined> | Blob | null | undefined;

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
   * Tooltip shown for the MAT button specifically. Defaults to a line
   * saying what the file holds, since "MAT" alone does not.
   */
  matTooltip?: string;
  /**
   * Tooltip shown for the COMTRADE button. Defaults to a line saying what
   * the download is, since the name alone does not say it is two files.
   */
  comtradeTooltip?: string;
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
   * `time-series`, `scrub`, `buses`, `sld`. Should be kebab-case +
   * filesystem-safe.
   */
  panel: string;
  /**
   * CSV handler. Returns a `Blob` (`text/csv`) or null/undefined to
   * signal "nothing to export" (the menu surfaces the disabled-tooltip
   * path instead). The menu does not pass any args — the caller
   * captures the panel's data in the closure.
   */
  onExportCsv?: ExportHandler;
  /**
   * PNG handler. Mirrors `onExportCsv`. Used by chart and SVG panels.
   */
  onExportPng?: ExportHandler;
  /**
   * MAT handler. Mirrors `onExportCsv`. Only supplied for the EIG
   * panel, which downloads the state matrix from the substrate.
   */
  onExportMat?: ExportHandler;
  /**
   * COMTRADE handler. Mirrors `onExportCsv`. Supplied by the panels that
   * hold a time-domain run, whose samples the substrate writes as an IEEE
   * C37.111 record; the Blob is a `.zip` of the record's two files.
   */
  onExportComtrade?: ExportHandler;
  /** Optional class on the trigger button. */
  className?: string;
  /**
   * What the trigger says and is called. Defaults to "Export"; a panel that
   * shares a screen with another menu names what it exports ("Export plot",
   * "Export run data"), since two buttons both called "Export" cannot be told
   * apart by someone who has to pick one.
   */
  label?: string;
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  png: 'PNG',
  mat: 'MAT (.mat)',
  comtrade: 'COMTRADE (.zip)',
};

/** The extension a format's file is saved under. */
const FORMAT_EXTENSION: Record<ExportFormat, string> = {
  csv: 'csv',
  png: 'png',
  mat: 'mat',
  comtrade: 'zip',
};

export function ExportMenu({
  formats,
  disabled = false,
  disabledTooltip = 'No data to export',
  matTooltip = 'MATLAB file with the state matrix (As) and the eigenvalues (mu)',
  comtradeTooltip = 'IEEE C37.111 record of the run: a .cfg and an ASCII .dat file, in one .zip',
  caseName = 'case',
  runId,
  panel,
  onExportCsv,
  onExportPng,
  onExportMat,
  onExportComtrade,
  className,
  label = 'Export',
}: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const runFormat = useCallback(
    async (format: ExportFormat) => {
      const handlers: Record<ExportFormat, ExportHandler | undefined> = {
        csv: onExportCsv,
        png: onExportPng,
        mat: onExportMat,
        comtrade: onExportComtrade,
      };
      const handler = handlers[format];
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
          // A .zip does not say what is in it, so the name does.
          panel: format === 'comtrade' ? `${panel}-comtrade` : panel,
          ext: FORMAT_EXTENSION[format],
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
        // An export the handler refused, or one the substrate refused or
        // could not be reached for, says why itself. Anything else is taken
        // for the browser's doing (a blocked download, a canvas that would
        // not rasterise).
        const explained =
          err instanceof ExportRefusedError ||
          err instanceof ProblemDetailsError ||
          err instanceof NetworkError;
        toast.error(explained ? 'Export failed' : 'Export failed; check browser settings.', {
          description: detail,
        });
      } finally {
        setBusy(false);
      }
    },
    [
      caseName,
      runId,
      panel,
      onExportCsv,
      onExportPng,
      onExportMat,
      onExportComtrade,
      disabledTooltip,
    ],
  );

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      data-testid="export-menu-trigger"
      data-busy={busy}
      // A panel that holds this menu can be rasterised as it stands; the
      // trigger is left out of the picture (see `elementToPng`).
      data-export-ignore=""
      className={cn('gap-1', className)}
      aria-label={label}
    >
      {/* Inline glyph keeps the dependency footprint flat. */}
      <span aria-hidden="true" className="font-mono text-xs">
        ↓
      </span>
      <span className="text-xs">{busy ? 'Exporting…' : label}</span>
    </Button>
  );

  if (disabled) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-block"
              data-testid="export-menu-disabled"
              data-export-ignore=""
            >
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
          {formats.includes('comtrade') && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void runFormat('comtrade')}
                    disabled={busy || !onExportComtrade}
                    className="justify-start"
                    data-testid="export-menu-comtrade"
                  >
                    {FORMAT_LABEL.comtrade}
                  </Button>
                </TooltipTrigger>
                <TooltipPortal>
                  {/* Beside the menu, so the hint does not cover the format above. */}
                  <TooltipContent side="left">{comtradeTooltip}</TooltipContent>
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
