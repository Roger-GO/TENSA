import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { valuesCount, type LeftOffKind, type LeftOffValue } from './valuesLeftOff';

/**
 * The values of the power flow that the diagram does not draw, over its top
 * right corner.
 *
 * A value is left off where no place is clear for it (`valuesLeftOff.ts`):
 * nothing on the diagram is drawn over anything else, so on a crowded one
 * some flows, readouts and voltages go without. The button is there while
 * any does, and says how many: `12 values not shown`. It opens the list:
 * each element that is missing a value, with what the value reads, so none
 * is lost; a row brings its element into view and selects it, which shows
 * the rest of it in the Inspector.
 *
 * The component only lists: the canvas hands it the rows and acts on a
 * pick. It is left out of a PNG of the view (`data-export-ignore`), as the
 * other controls over the diagram are.
 */
export interface SldValuesLeftOffProps {
  rows: readonly LeftOffValue[];
  /** Bring the element of a row into view and select it. */
  onShow: (row: LeftOffValue) => void;
  className?: string;
}

const FOCUS =
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none';

/** What each kind of value is, for the head of its part of the list. */
const KIND_HEADING: Record<LeftOffKind, string> = {
  flow: 'Line flows',
  readout: 'P and Q of generators and loads',
  bus: 'Bus voltages and angles',
};

const KINDS: readonly LeftOffKind[] = ['flow', 'readout', 'bus'];

export function SldValuesLeftOff({ rows, onShow, className }: SldValuesLeftOffProps) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const count = valuesCount(rows.length);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sld-values-left-off"
          data-left-off-count={rows.length}
          data-export-ignore=""
          aria-label={`${count} not shown on the diagram: no clear place was found for ${rows.length === 1 ? 'it' : 'them'}. Open the list.`}
          title="Values of the power flow that have no clear place on the diagram. Open the list to read them."
          className={cn(
            // As high as the draw buttons across the pane: within the margin
            // a fitted diagram keeps to the top of its pane.
            'bg-background text-foreground border-border flex h-[22px] items-center gap-1.5',
            'rounded border px-2 text-xs leading-none font-medium shadow-sm',
            'hover:bg-muted/60',
            FOCUS,
            className,
          )}
        >
          <span>{count} not shown</span>
          <span aria-hidden="true" className="text-muted-foreground text-[10px] leading-none">
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="sld-values-left-off-list"
        data-export-ignore=""
        className="flex w-80 flex-col gap-2 p-3"
      >
        <div className="flex flex-col gap-0.5">
          <h2 className="text-foreground text-xs font-semibold">
            Not shown on the diagram: {count}
          </h2>
          <p className="text-muted-foreground text-[11px] leading-snug">
            No place that is clear of the lines, the symbols and the other labels was found for{' '}
            {rows.length === 1 ? 'this value' : 'these values'}, so the diagram leaves{' '}
            {rows.length === 1 ? 'it' : 'them'} off. Pick one to go to its element. Moving things
            apart gives a value room.
          </p>
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {KINDS.map((kind) => {
            const ofKind = rows.filter((row) => row.kind === kind);
            if (ofKind.length === 0) return null;
            return (
              <section key={kind} className="flex flex-col gap-0.5">
                <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
                  {KIND_HEADING[kind]} ({ofKind.length})
                </h3>
                <ul role="list" className="flex flex-col">
                  {ofKind.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        data-testid={`sld-values-left-off-row-${row.id}`}
                        title={`Go to ${row.name}`}
                        onClick={() => {
                          onShow(row);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-baseline justify-between gap-3 rounded border',
                          'border-transparent px-1.5 py-0.5 text-left',
                          'hover:bg-muted hover:border-border',
                          FOCUS,
                        )}
                      >
                        <span className="text-foreground min-w-0 truncate text-xs">{row.name}</span>
                        <span className="text-foreground shrink-0 font-mono text-[11px] whitespace-nowrap">
                          {row.values.join(', ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
