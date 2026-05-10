/**
 * RunLegendChip (Unit 9 of the v2.0 plan, extended in Unit 20).
 *
 * One chip per overlay run, surfaced above the TimeSeriesPlot. Shows
 * the runId-stable colour swatch, a short human-facing label (the
 * runId's leading 8 chars + tf), and a click target that toggles the
 * run in/out of the overlay set.
 *
 * Lives next to the plot rather than inside ``<TimeSeriesPlot />`` so
 * the chips can be wrapped/styled by the surrounding layout (the v2.0
 * Analyze panel mounts a horizontal chip strip; the History drawer
 * reuses the same chip in the per-row pin/unpin button).
 *
 * **Unit 20 additions:** the chip lets researchers customise their
 * runs for paper figures.
 *
 *  - **Double-click the run name** swaps to an inline ``<Input>`` for
 *    rename. Enter / blur commits, Escape cancels. Empty value clears
 *    the override and falls back to the auto-generated default. The
 *    new name lives in ``runs[runId].displayName`` (session-scoped —
 *    no localStorage persistence per the plan).
 *  - **Click the swatch** opens a Radix Popover with an 8-colour
 *    palette plus a "Custom" hex input + "Reset to default" button.
 *    Picking a colour writes ``runs[runId].colorOverride`` and the
 *    plot picks it up on the next render. Invalid hex shows an inline
 *    ``role="alert"`` error (form-validation is inline per the toast
 *    policy in ``web/AGENTS.md``, NEVER a toast).
 */
import { useEffect, useRef, useState } from 'react';
import { useRunsStore } from '@/store/runs';
import { runIdToStrokeStyle } from '@/lib/runIdToColor';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';

export interface RunLegendChipProps {
  /** Run id this chip represents. Required — chips are run-specific. */
  runId: string;
  /**
   * Optional override for the displayed label. Defaults to the
   * researcher-set ``displayName`` (Unit 20) when present, otherwise
   * ``"<run-id-prefix> · tf=<tf>s"``.
   */
  label?: string;
  /**
   * When true, the chip renders in the "pinned" visual state and
   * clicking removes the run from the overlay set. When false, the
   * chip is "unpinned" and clicking adds it. Defaults to subscribing
   * to the overlay store.
   */
  pinned?: boolean;
  /**
   * Click handler override. When omitted, the chip toggles the run in
   * the overlay store. The History drawer passes its own handler so
   * the action can also surface a toast.
   */
  onToggle?: (runId: string, willBePinned: boolean) => void;
  className?: string;
}

/** Trim a run id for display (first 8 chars). */
function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/**
 * 8-colour swatch palette for the picker (Unit 20). Mirrors the
 * single-run-mode ``PALETTE_LIGHT`` array in ``TimeSeriesPlot.tsx``
 * (first 8 hues), so a researcher who picks "the green one" in the
 * legend gets the exact same OKLCH coordinates the plot already uses
 * for its built-in variable palette. OKLCH is theme-agnostic in
 * the sense that the same coordinates render reasonably under both
 * light and dark backgrounds — they're already perceptually-uniform
 * and the chroma values are tuned to stay above the dark-mode
 * background contrast threshold.
 */
const SWATCH_PALETTE: readonly string[] = [
  'oklch(0.55 0.20 28)', // red-orange
  'oklch(0.65 0.18 75)', // amber
  'oklch(0.65 0.18 145)', // green
  'oklch(0.60 0.18 200)', // cyan
  'oklch(0.55 0.22 265)', // blue
  'oklch(0.55 0.22 320)', // magenta
  'oklch(0.50 0.13 175)', // teal
  'oklch(0.50 0.18 295)', // purple
];

/**
 * Strict 3- or 6-digit hex validator. The CSS spec also recognises
 * 4- and 8-digit forms (alpha channels), but we deliberately reject
 * those — a transparent overlay run would render an invisible plot
 * stroke, which is a footgun rather than a feature for paper
 * figures.
 */
const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isValidHex(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

/**
 * Inline rename input: double-click the chip's name to swap to an
 * editable ``<Input>``. Commit on Enter / blur, cancel on Escape,
 * select-all on focus so retyping is a single keypress.
 */
function RenameInput({
  runId,
  initialValue,
  onCommit,
  onCancel,
}: {
  runId: string;
  initialValue: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus + select-all so the researcher can immediately retype.
  // Running this once on mount via a ref is simpler than wiring up
  // ``autoFocus`` (which Radix sometimes strips for a11y) plus a
  // separate select-on-focus handler.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={setValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      data-testid={`run-legend-name-input-${runId}`}
      aria-label="Rename run"
      className="h-6 w-32 px-1.5 py-0 text-xs"
    />
  );
}

/**
 * Swatch picker popover content. Renders the 8-swatch grid + a
 * "Custom" hex input row + a "Reset to default" button. Selecting a
 * preset fires ``onPick`` and closes; the custom input shows an
 * inline error on invalid hex without closing.
 */
function SwatchPicker({
  runId,
  currentOverride,
  onPick,
  onClear,
}: {
  runId: string;
  currentOverride?: string;
  onPick: (color: string) => void;
  onClear: () => void;
}) {
  const [hexValue, setHexValue] = useState('');
  const [hexError, setHexError] = useState<string | null>(null);

  const handleHexSubmit = () => {
    if (!isValidHex(hexValue)) {
      setHexError('Enter a valid hex colour (e.g. #3366ff)');
      return;
    }
    setHexError(null);
    onPick(hexValue.trim());
  };

  return (
    <div data-testid={`run-legend-swatch-picker-${runId}`} className="flex flex-col gap-3">
      <div>
        <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">Pick a colour</div>
        <div className="grid grid-cols-4 gap-1.5">
          {SWATCH_PALETTE.map((color) => {
            const isCurrent = currentOverride === color;
            return (
              <button
                key={color}
                type="button"
                onClick={() => onPick(color)}
                data-testid={`run-legend-swatch-option-${runId}-${color}`}
                aria-label={`Set run colour to ${color}`}
                aria-pressed={isCurrent}
                className={cn(
                  'h-7 w-full rounded-[var(--radius-sm)] border transition-shadow',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  isCurrent ? 'border-foreground' : 'border-border',
                )}
                style={{ background: color }}
              />
            );
          })}
        </div>
      </div>

      <div>
        <label
          htmlFor={`run-legend-swatch-custom-${runId}`}
          className="text-muted-foreground mb-1.5 block text-[11px] font-medium"
        >
          Custom hex
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`run-legend-swatch-custom-${runId}`}
            value={hexValue}
            onChange={(next) => {
              setHexValue(next);
              if (hexError) setHexError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleHexSubmit();
              }
            }}
            placeholder="#3366ff"
            aria-invalid={hexError !== null}
            aria-describedby={hexError ? `run-legend-swatch-custom-error-${runId}` : undefined}
            data-testid={`run-legend-swatch-custom-input-${runId}`}
            className="h-7 flex-1 text-xs"
          />
          <button
            type="button"
            onClick={handleHexSubmit}
            data-testid={`run-legend-swatch-custom-apply-${runId}`}
            className={cn(
              'rounded-[var(--radius-sm)] border px-2 py-1 text-xs',
              'border-border hover:bg-muted/60',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            Apply
          </button>
        </div>
        {hexError ? (
          <div
            id={`run-legend-swatch-custom-error-${runId}`}
            data-testid={`run-legend-swatch-custom-error-${runId}`}
            role="alert"
            className="text-danger mt-1 text-[11px]"
          >
            {hexError}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onClear}
        data-testid={`run-legend-swatch-reset-${runId}`}
        disabled={!currentOverride}
        className={cn(
          'rounded-[var(--radius-sm)] border px-2 py-1 text-xs',
          'border-border hover:bg-muted/60',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        Reset to default
      </button>
    </div>
  );
}

export function RunLegendChip({ runId, label, pinned, onToggle, className }: RunLegendChipProps) {
  const overlayHas = useRunsStore((s) => s.overlayRunIds.has(runId));
  const addOverlay = useRunsStore((s) => s.addOverlayRun);
  const removeOverlay = useRunsStore((s) => s.removeOverlayRun);
  const run = useRunsStore((s) => s.runs[runId]);
  const setRunDisplayName = useRunsStore((s) => s.setRunDisplayName);
  const setRunColorOverride = useRunsStore((s) => s.setRunColorOverride);

  const [isRenaming, setIsRenaming] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isPinned = pinned ?? overlayHas;
  // Pull the per-run override (Unit 20) so the chip swatch matches the
  // plot stroke when the researcher has customised the colour.
  const colorOverride = run?.colorOverride;
  const style = runIdToStrokeStyle(runId, colorOverride);

  // Default label: ``<short> · tf=<tf>s`` so the chip is identifiable
  // even when the user has named their runs after their parameters.
  // Researcher-set ``displayName`` (Unit 20) wins when present unless
  // the caller explicitly passed a ``label`` prop (which always wins
  // — used by the History drawer).
  const defaultLabel = run ? `${shortRunId(runId)} · tf=${run.tf}s` : shortRunId(runId);
  const storeLabel = run?.displayName ?? defaultLabel;
  const displayLabel = label ?? storeLabel;

  const handleClick = () => {
    if (onToggle) {
      onToggle(runId, !isPinned);
      return;
    }
    if (isPinned) removeOverlay(runId);
    else addOverlay(runId);
  };

  // The colour swatch renders the dash pattern via repeating-linear-gradient
  // so the visual exactly matches what the uPlot stroke will look like
  // for this run. For solid (empty dash) we fall back to a flat fill.
  const swatchBg =
    style.dash.length === 0
      ? style.color
      : `repeating-linear-gradient(90deg, ${style.color} 0 ${style.dash[0]}px, transparent ${style.dash[0]}px ${(style.dash[0] ?? 0) + (style.dash[1] ?? 0)}px)`;

  const handleRenameCommit = (next: string) => {
    setRunDisplayName(runId, next);
    setIsRenaming(false);
  };

  const handlePickColor = (color: string) => {
    setRunColorOverride(runId, color);
    setPickerOpen(false);
  };

  const handleClearColor = () => {
    setRunColorOverride(runId, null);
    setPickerOpen(false);
  };

  return (
    <span
      data-testid={`run-legend-chip-${runId}`}
      data-run-id={runId}
      data-pinned={isPinned ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1.5',
        'rounded-[var(--radius-sm)] border px-2 py-1 text-xs',
        'transition-colors',
        isPinned
          ? 'border-border bg-muted text-foreground'
          : 'border-border bg-background text-muted-foreground',
        className,
      )}
    >
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              // Stop the chip's own click handler (which toggles
              // overlay pinning) from firing when the user just
              // wanted to open the colour picker.
              e.stopPropagation();
            }}
            data-testid={`run-legend-swatch-${runId}`}
            aria-label={`Change colour for ${displayLabel}`}
            className={cn(
              'inline-block h-3 w-4 rounded-sm border border-transparent',
              'hover:border-border',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
            style={{ background: swatchBg }}
          />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-3">
          <SwatchPicker
            runId={runId}
            currentOverride={colorOverride}
            onPick={handlePickColor}
            onClear={handleClearColor}
          />
        </PopoverContent>
      </Popover>

      {isRenaming ? (
        <RenameInput
          runId={runId}
          initialValue={run?.displayName ?? ''}
          onCommit={handleRenameCommit}
          onCancel={() => setIsRenaming(false)}
        />
      ) : (
        <button
          type="button"
          onClick={handleClick}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setIsRenaming(true);
          }}
          data-testid={`run-legend-name-${runId}`}
          aria-pressed={isPinned}
          aria-label={
            isPinned
              ? `Unpin ${displayLabel} from overlay (double-click to rename)`
              : `Pin ${displayLabel} to overlay (double-click to rename)`
          }
          className={cn(
            'font-mono',
            'rounded-[var(--radius-sm)] px-0.5',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            isPinned ? 'hover:bg-muted/60' : 'hover:bg-muted/40',
          )}
        >
          {displayLabel}
        </button>
      )}
    </span>
  );
}
