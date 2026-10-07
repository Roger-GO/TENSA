/**
 * The controls that arrange the diagram: Tidy diagram, the Arrange menu, and
 * the bar that shows over the diagram while several nodes are picked.
 *
 * - **Tidy diagram** routes every line and transformer afresh and moves
 *   nothing (`tidy.ts`). It is a button of its own, beside the diagram's
 *   other buttons, because it is the one command a diagram arranged by hand
 *   wants again and again. While lines are drawn through a symbol or a bar
 *   it counts them, which is how a diagram says that it wants a tidy. While
 *   a large diagram is being tidied it says so, and a Stop button beside it
 *   calls the work off.
 * - **Arrange** is a menu: Tidy and re-layout, which also moves things (the
 *   buses onto the grid, the devices back beside their bus), Snap to grid,
 *   and Align and Distribute for the nodes that are picked. With fewer than
 *   two picked it says how to pick several, which nothing else on the
 *   diagram shows.
 * - **The selection bar** is the same Align and Distribute buttons, over the
 *   diagram while two or more nodes are picked, so they are at hand where the
 *   selection was just made.
 *
 * None of them does the work: each posts a command (`SldCommand` in
 * `store/sld.ts`), which the canvas runs as it runs the same command from the
 * palette or the right-click menu, so every way in arranges, records for Undo
 * and saves in the same way.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import type { SldCommand } from '@/store/sld';
import { ALIGN_LABEL, DISTRIBUTE_LABEL, type AlignMode, type DistributeAxis } from './arrange';
import { GRID_STEP } from './tidy';

/** The commands these controls post. */
export type ArrangeCommand = Extract<
  SldCommand,
  'tidy' | 'tidy-relayout' | `align-${AlignMode}` | `distribute-${DistributeAxis}`
>;

/** What Tidy diagram does, for its tooltip and the menu. */
export const TIDY_DESCRIPTION =
  'Routes every line and transformer afresh: at right angles, clear of the buses, the devices and each other, with as few crossings as it finds. Nothing is moved.';

/**
 * What the Tidy diagram button says while lines are drawn through a symbol or
 * through the bar of a bus they are not connected to. The diagram routes a
 * line round whatever is moved onto it as it is drawn, so this shows only
 * where it found no way in the little time it takes for that: the line is
 * then drawn from bar to bar, through what stands in between, and a tidy,
 * which looks further, is what puts it right.
 */
function untidyNotice(count: number): string {
  return count === 1
    ? '1 line runs through a symbol or a bar.'
    : `${count} lines run through a symbol or a bar.`;
}

/** What Tidy and re-layout does besides. */
export const TIDY_RELAYOUT_DESCRIPTION =
  'Also moves things: lines the buses up on the grid, puts each generator, load and shunt back beside its bus, and then tidies the lines.';

/** How to pick several nodes, which Align and Distribute need. */
export const PICK_SEVERAL_HINT =
  'Pick two or more buses or devices first: hold Shift and drag a box around them, or hold Ctrl (Cmd on a Mac) and click each.';

const ALIGN_MODES: readonly AlignMode[] = ['left', 'centre', 'right', 'top', 'middle', 'bottom'];
const DISTRIBUTE_AXES: readonly DistributeAxis[] = ['horizontal', 'vertical'];

/**
 * A 16 px picture of an alignment: the line the boxes go to, and two boxes
 * on it. `currentColor`, so it follows the button's text in either theme.
 */
function AlignGlyph({ mode }: { mode: AlignMode }) {
  const horizontal = mode === 'left' || mode === 'centre' || mode === 'right';
  // Drawn for the three alignments along x; the other three are the same picture turned.
  const at = mode === 'left' || mode === 'top' ? 2 : mode === 'right' || mode === 'bottom' ? 14 : 8;
  const start = (length: number): number =>
    at === 2 ? 2 : at === 14 ? 14 - length : 8 - length / 2;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={horizontal ? undefined : '-scale-x-100 rotate-90'}
    >
      <line x1={at} y1="1" x2={at} y2="15" stroke="currentColor" strokeWidth="1" />
      <rect x={start(10)} y="3" width="10" height="4" rx="1" fill="currentColor" />
      <rect x={start(6)} y="9" width="6" height="4" rx="1" fill="currentColor" />
    </svg>
  );
}

/** The same for a distribution: three boxes with equal gaps between them. */
function DistributeGlyph({ axis }: { axis: DistributeAxis }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={axis === 'horizontal' ? undefined : 'rotate-90'}
    >
      <rect x="1" y="4" width="3" height="8" rx="1" fill="currentColor" />
      <rect x="6.5" y="4" width="3" height="8" rx="1" fill="currentColor" />
      <rect x="12" y="4" width="3" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

const ICON_BUTTON = cn(
  'text-foreground flex h-7 w-7 items-center justify-center rounded border',
  'border-border bg-background hover:bg-muted/60',
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-40',
);

interface ArrangeButtonsProps {
  /** How many nodes are picked: Distribute needs three. */
  count: number;
  disabled?: boolean;
  onCommand: (command: ArrangeCommand) => void;
}

/** The six Align buttons and the two Distribute buttons. */
export function ArrangeButtons({ count, disabled = false, onCommand }: ArrangeButtonsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="sld-arrange-buttons">
      {ALIGN_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          data-testid={`sld-align-${mode}`}
          aria-label={ALIGN_LABEL[mode]}
          title={ALIGN_LABEL[mode]}
          disabled={disabled || count < 2}
          onClick={() => onCommand(`align-${mode}`)}
          className={ICON_BUTTON}
        >
          <AlignGlyph mode={mode} />
        </button>
      ))}
      <span aria-hidden="true" className="bg-border mx-0.5 h-5 w-px" />
      {DISTRIBUTE_AXES.map((axis) => (
        <button
          key={axis}
          type="button"
          data-testid={`sld-distribute-${axis}`}
          aria-label={DISTRIBUTE_LABEL[axis]}
          title={
            count < 3
              ? `${DISTRIBUTE_LABEL[axis]} (needs three or more picked)`
              : DISTRIBUTE_LABEL[axis]
          }
          disabled={disabled || count < 3}
          onClick={() => onCommand(`distribute-${axis}`)}
          className={ICON_BUTTON}
        >
          <DistributeGlyph axis={axis} />
        </button>
      ))}
    </div>
  );
}

export interface SldArrangeControlsProps {
  /** The diagram's lock is on: nothing can be arranged until it is off again. */
  locked: boolean;
  /** A tidy of a large diagram is being worked out. */
  busy?: boolean;
  /** Call that tidy off; while it is worked out the controls offer to. */
  onCancel?: () => void;
  /**
   * How many lines and transformers are drawn through a symbol or a bar
   * (`branchesThroughSymbols`): the button counts them and says what it
   * would do about them.
   */
  untidy?: number;
  /** How many buses and devices are picked together. */
  pickedCount: number;
  snap: boolean;
  onSnapChange: (snap: boolean) => void;
  onCommand: (command: ArrangeCommand) => void;
}

/** The Tidy diagram button and the Arrange menu, for the row above the diagram. */
export function SldArrangeControls({
  locked,
  busy = false,
  onCancel,
  untidy = 0,
  pickedCount,
  snap,
  onSnapChange,
  onCommand,
}: SldArrangeControlsProps) {
  const [open, setOpen] = useState(false);
  const run = (command: ArrangeCommand) => {
    setOpen(false);
    onCommand(command);
  };
  const lockedNote = 'The diagram is locked. Unlock it with the padlock at its bottom left.';
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="sld-tidy"
        data-busy={busy}
        disabled={locked || busy}
        title={
          locked
            ? lockedNote
            : untidy > 0
              ? `${untidyNotice(untidy)} ${TIDY_DESCRIPTION}`
              : TIDY_DESCRIPTION
        }
        aria-label={untidy > 0 && !busy ? `Tidy diagram: ${untidyNotice(untidy)}` : undefined}
        onClick={() => onCommand('tidy')}
        className="h-7 shrink-0 gap-1.5 px-2"
      >
        {busy ? 'Tidying…' : 'Tidy diagram'}
        {untidy > 0 && !busy ? (
          <span
            aria-hidden="true"
            data-testid="sld-tidy-count"
            className="bg-warning text-warning-foreground rounded-full px-1.5 font-mono text-[10px] leading-4 font-semibold"
          >
            {untidy}
          </span>
        ) : null}
      </Button>
      {busy && onCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="sld-tidy-cancel"
          title="Stop tidying. Nothing is changed."
          onClick={onCancel}
          className="h-7 shrink-0 px-2"
        >
          Stop
        </Button>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="sld-arrange-trigger"
            aria-label="Arrange the diagram"
            className="h-7 shrink-0 gap-1 px-2"
          >
            <span>Arrange</span>
            <span aria-hidden="true" className="font-mono text-[10px]">
              ▾
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-3" data-testid="sld-arrange-menu">
          <div className="flex flex-col gap-3 text-xs">
            {locked ? (
              <p role="status" className="text-foreground font-medium">
                {lockedNote}
              </p>
            ) : null}
            <section className="flex flex-col gap-2">
              <button
                type="button"
                data-testid="sld-arrange-tidy"
                disabled={locked || busy}
                onClick={() => run('tidy')}
                className={cn(
                  'hover:bg-muted/60 rounded px-2 py-1.5 text-left',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <span className="text-foreground block font-medium">Tidy diagram</span>
                <span className="text-muted-foreground block leading-snug">{TIDY_DESCRIPTION}</span>
              </button>
              <button
                type="button"
                data-testid="sld-arrange-tidy-relayout"
                disabled={locked || busy}
                onClick={() => run('tidy-relayout')}
                className={cn(
                  'hover:bg-muted/60 rounded px-2 py-1.5 text-left',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <span className="text-foreground block font-medium">Tidy and re-layout</span>
                <span className="text-muted-foreground block leading-snug">
                  {TIDY_RELAYOUT_DESCRIPTION}
                </span>
              </button>
            </section>
            <label className="flex cursor-pointer items-start gap-2 px-2">
              <input
                type="checkbox"
                data-testid="sld-snap-toggle"
                checked={snap}
                onChange={(e) => onSnapChange(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-foreground block font-medium">Snap to grid</span>
                <span className="text-muted-foreground block leading-snug">
                  What you drag, or move with the arrow keys, lands on the {GRID_STEP} px grid of
                  the background dots.
                </span>
              </span>
            </label>
            <section className="flex flex-col gap-1.5 px-2">
              <span className="text-foreground font-medium">
                Align and distribute
                {pickedCount >= 2 ? ` (${pickedCount} picked)` : ''}
              </span>
              <ArrangeButtons count={pickedCount} disabled={locked} onCommand={run} />
              {pickedCount < 2 ? (
                <p
                  className="text-muted-foreground leading-snug"
                  data-testid="sld-arrange-pick-hint"
                >
                  {PICK_SEVERAL_HINT}
                </p>
              ) : null}
            </section>
            <p className="text-muted-foreground border-border border-t px-2 pt-2 leading-snug">
              Undo (Ctrl+Z, or Cmd+Z on a Mac) takes back a move, a tidy or an alignment, and Redo
              puts it back. Both are in the Edit menu.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

export interface SldSelectionBarProps {
  /** How many buses and devices are picked together; the bar shows from two. */
  count: number;
  locked: boolean;
  onCommand: (command: ArrangeCommand) => void;
}

/**
 * The bar over the diagram while several nodes are picked: how many, and the
 * Align and Distribute buttons. It says that the picked nodes move together,
 * which is the other thing a selection is for.
 */
export function SldSelectionBar({ count, locked, onCommand }: SldSelectionBarProps) {
  if (count < 2) return null;
  return (
    <div
      role="toolbar"
      aria-label="Arrange the picked elements"
      data-testid="sld-selection-bar"
      // Left out of a PNG export of the diagram, like the export button itself.
      data-export-ignore=""
      className={cn(
        'border-border bg-background/95 pointer-events-auto flex items-center gap-2 rounded-lg border',
        'px-2 py-1 text-xs shadow-md',
      )}
    >
      <span
        className="text-foreground font-medium whitespace-nowrap"
        data-testid="sld-selection-count"
        title="Drag one of them, or press the arrow keys, to move them together. Click the background to let go of them."
      >
        {count} picked
      </span>
      <ArrangeButtons count={count} disabled={locked} onCommand={onCommand} />
    </div>
  );
}
