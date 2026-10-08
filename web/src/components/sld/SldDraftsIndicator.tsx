import { useState } from 'react';
import { ElementKindGlyph } from '@/components/elements/ElementKindGlyph';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import type { DraftRow } from './drafts';

/**
 * The list of drafts, over the top right corner of the diagram.
 *
 * A draft is an element that was placed on the diagram and is not in the
 * system yet (`store/drafts.ts`). The button is there while the diagram has
 * any: it counts them and says how many still lack something, so drafts that
 * are off screen, or drawn as a dashed line between two buses, are not lost
 * sight of. It opens the list: each draft with its symbol, its name and
 * what it still lacks, in the order they were placed. A row picks its draft,
 * which brings it into view and opens its form in the Inspector, where it
 * is added to the system; the button beside a row deletes that draft, and
 * the one under the list deletes them all.
 *
 * The component only lists: the canvas hands it the rows and acts on what
 * is asked. It is left out of a PNG of the view (`data-export-ignore`).
 */
export interface SldDraftsIndicatorProps {
  rows: readonly DraftRow[];
  /** The draft that is picked, or `null`. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  className?: string;
}

const FOCUS =
  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none';

export function SldDraftsIndicator({
  rows,
  selectedId,
  onSelect,
  onDelete,
  onDeleteAll,
  className,
}: SldDraftsIndicatorProps) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const incomplete = rows.filter((row) => !row.ready).length;
  const count = `${rows.length} ${rows.length === 1 ? 'draft' : 'drafts'}`;
  const state = incomplete === 0 ? 'all ready to add' : `${incomplete} incomplete`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sld-drafts-indicator"
          data-draft-count={rows.length}
          data-incomplete-count={incomplete}
          data-export-ignore=""
          aria-label={`${count}, ${state}. Elements placed on the diagram that are not in the system yet. Open the list.`}
          title="Elements placed on the diagram that are not in the system yet"
          className={cn(
            'bg-background text-foreground flex items-center gap-1.5 rounded border px-2 py-1',
            'text-xs font-medium shadow-sm',
            incomplete === 0 ? 'border-success' : 'border-warning',
            'hover:bg-muted/60',
            FOCUS,
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-dashed',
              incomplete === 0 ? 'border-success' : 'border-warning',
            )}
          />
          <span>Drafts</span>
          <span className="font-mono">{rows.length}</span>
          <span
            className={cn(
              'rounded-[var(--radius-sm)] px-1 py-px text-[10px] leading-none font-semibold',
              incomplete === 0
                ? 'bg-success text-success-foreground'
                : 'bg-warning text-warning-foreground',
            )}
          >
            {incomplete === 0 ? 'ready' : `${incomplete} incomplete`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="sld-drafts-list"
        data-export-ignore=""
        className="flex w-80 flex-col gap-2 p-3"
      >
        <div className="flex flex-col gap-0.5">
          <h2 className="text-foreground text-xs font-semibold">Drafts: not in the system yet</h2>
          <p className="text-muted-foreground text-[11px] leading-snug">
            Kept in this browser until they are added. Pick one to fill in its parameters in the
            Inspector and add it to the system.
          </p>
        </div>
        <ul role="list" className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id} className="flex items-stretch gap-1">
              <button
                type="button"
                data-testid={`sld-drafts-row-${row.id}`}
                data-ready={row.ready ? 'true' : 'false'}
                aria-current={row.id === selectedId ? 'true' : undefined}
                onClick={() => {
                  onSelect(row.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded border px-1.5 py-1 text-left',
                  row.id === selectedId
                    ? 'bg-muted/60 border-[var(--color-ring)]'
                    : 'border-transparent',
                  'hover:bg-muted hover:border-border',
                  FOCUS,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'text-muted-foreground flex h-7 w-7 shrink-0 items-center justify-center',
                    'rounded-[var(--radius-sm)] border border-dashed',
                    row.ready ? 'border-success' : 'border-warning',
                  )}
                >
                  <ElementKindGlyph kind={row.kind} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate text-xs leading-tight font-medium">
                    {row.name}
                  </span>
                  <span
                    className={cn(
                      'text-[11px] leading-snug',
                      row.ready ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {row.ready ? row.summary : `Incomplete. ${row.summary}`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                data-testid={`sld-drafts-delete-${row.id}`}
                aria-label={`Delete draft ${row.name}`}
                title={`Delete draft ${row.name}`}
                onClick={() => onDelete(row.id)}
                className={cn(
                  'text-muted-foreground hover:text-foreground hover:bg-muted',
                  'flex w-7 shrink-0 items-center justify-center rounded text-sm leading-none',
                  FOCUS,
                )}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
        {rows.length > 1 ? (
          <button
            type="button"
            data-testid="sld-drafts-delete-all"
            onClick={() => {
              onDeleteAll();
              setOpen(false);
            }}
            className={cn(
              'border-border text-foreground self-start rounded border px-2 py-0.5 text-[11px]',
              'hover:bg-muted',
              FOCUS,
            )}
          >
            Delete all {rows.length} drafts
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
