/**
 * SldNodeSearch — popover for jump-to-node navigation.
 *
 * Unit 11 of the v2.0 polish plan. Triggered by:
 *
 *  - `meta+/` / `ctrl+/` (wired in `SldCanvas` via `useHotkeys`)
 *  - Click on the floating search-icon button (rendered alongside the
 *    React Flow Controls in the bottom-right of the canvas)
 *  - Command-palette / TopBar entries (`navigation.focusSearch`,
 *    `navigation.panToBus`) which post to `__requestOpenSldSearch`.
 *
 * Once open, the user types a substring; the list narrows to matching
 * `idx` or `name` (case-insensitive). Selecting a row pans the React
 * Flow viewport to centre that node (no zoom change) and writes the
 * node's id to the SLD store so the bus-node visual highlight follows.
 *
 * The popover does NOT scroll the inspector or write to
 * `case.selectedElement`. The inspector follows the node-click event
 * (which the canvas's `onNodeClick` handler already wires); this
 * component is purely a navigation aid.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useReactFlow } from '@xyflow/react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/Input';
import { useSldStore, subscribeOpenSldSearch } from '@/store/sld';
import { cn } from '@/lib/cn';

/** Per-row payload surfaced in the list. Mirrors React Flow node shape. */
export interface SldSearchEntry {
  /** React Flow node id — bus idx for buses, `${kind}-${idx}` for non-bus. */
  id: string;
  /** Display label (the ANDES `name` field, falls back to idx). */
  name: string;
  /** ANDES idx — surfaced as a secondary label and substring-searchable. */
  idx: string;
  /** Node type (`bus`, `generator`, `load`, `shunt`, `line`). */
  type: string;
  x: number;
  y: number;
}

export interface SldNodeSearchHandle {
  /** Programmatically open + focus the input. */
  open: () => void;
}

/** Cap on rendered rows. The full filter still runs over the whole list. */
const MAX_VISIBLE_ROWS = 50;

/**
 * Substring filter on idx + name. Case-insensitive; whitespace trimmed.
 * Returns the entries unchanged when the query is empty.
 */
function filterEntries(entries: readonly SldSearchEntry[], query: string): SldSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter((e) => e.idx.toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
}

export const SldNodeSearch = forwardRef<SldNodeSearchHandle>(function SldNodeSearch(_props, ref) {
  // We pull the live React Flow nodes via the imperative API rather
  // than threading them in as props. That keeps SldCanvas's diff to
  // the absolute minimum (one new mount line) and lets the popover
  // operate on whatever the canvas renders today, including drag
  // overrides.
  const rf = useReactFlow();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Snapshot the live node list each time the popover opens. Recomputing
  // on every keystroke would churn through React Flow's internal store
  // for no benefit — the topology can't change while the popover is
  // open in any practical scenario.
  const entries = useMemo<SldSearchEntry[]>(() => {
    if (!open) return [];
    const nodes = rf.getNodes();
    const out: SldSearchEntry[] = [];
    for (const n of nodes) {
      const data = n.data as { idx?: string; name?: string } | undefined;
      const idx = data?.idx ?? n.id;
      const name = data?.name ?? '';
      out.push({
        id: n.id,
        idx: String(idx),
        name,
        type: n.type ?? 'bus',
        x: n.position.x,
        y: n.position.y,
      });
    }
    // Stable display order: buses first, then by idx ascending. The
    // user's mental model is "list of buses with devices below" — match
    // it here so the visible 50-row cap is predictable.
    out.sort((a, b) => {
      if (a.type === 'bus' && b.type !== 'bus') return -1;
      if (a.type !== 'bus' && b.type === 'bus') return 1;
      return a.idx.localeCompare(b.idx, undefined, { numeric: true });
    });
    return out;
  }, [open, rf]);

  const filtered = useMemo(() => filterEntries(entries, query), [entries, query]);
  const visible = filtered.slice(0, MAX_VISIBLE_ROWS);

  const onPick = useCallback(
    (entry: SldSearchEntry) => {
      // Centre the viewport on the node WITHOUT changing the zoom — per
      // the plan's spec ("pans + (no-zoom) centres that node"). React
      // Flow's `setCenter` lets us pin the zoom by reading the current
      // value first; passing `zoom: undefined` would default to 1.
      const currentZoom = rf.getZoom();
      rf.setCenter(entry.x, entry.y, { zoom: currentZoom, duration: 250 });
      setSelectedNodeId(entry.id);
      setOpen(false);
      setQuery('');
    },
    [rf, setSelectedNodeId],
  );

  // Auto-focus the input on open. Radix's Popover.Content focuses
  // itself on open by default; we override to land on the input so the
  // user can type immediately.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Subscribe to the cross-component "open" channel so the command
  // palette and the keyboard shortcut can both flip us open without a
  // direct ref handoff.
  useEffect(() => {
    return subscribeOpenSldSearch(() => {
      setOpen(true);
    });
  }, []);

  // Expose a tiny imperative handle for SldCanvas's hotkey wiring (the
  // hotkey calls `.open()` rather than going through the global pub-sub
  // — saves one indirection for the common case).
  useImperativeHandle(
    ref,
    () => ({
      open: () => setOpen(true),
    }),
    [],
  );

  // Pressing Enter inside the input picks the first visible row.
  // `onKeyDown` fires inside the input regardless of `useHotkeys` so we
  // bind directly here.
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = visible[0];
        if (first) onPick(first);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    [visible, onPick],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sld-node-search-trigger"
          aria-label="Search SLD nodes"
          title="Search nodes (⌘/)"
          className={cn(
            'rounded border px-2 py-0.5 text-xs',
            'border-border bg-background text-foreground',
            'hover:bg-muted/40',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          Search…
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-80 p-2"
        data-testid="sld-node-search"
      >
        <div className="flex flex-col gap-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(next) => setQuery(next)}
            onKeyDown={onInputKeyDown}
            placeholder="Search by idx or name…"
            aria-label="Search SLD nodes by idx or name"
            data-testid="sld-node-search-input"
            className="h-8 font-mono text-xs"
          />
          <div
            className="max-h-72 min-h-0 overflow-auto"
            data-testid="sld-node-search-list"
            role="listbox"
            aria-label="SLD node search results"
          >
            {visible.length === 0 ? (
              <p
                data-testid="sld-node-search-empty"
                className="text-muted-foreground px-2 py-4 text-center text-xs"
              >
                No nodes match
              </p>
            ) : (
              <ul className="flex flex-col">
                {visible.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      onClick={() => onPick(entry)}
                      data-testid={`sld-node-search-row-${entry.idx}`}
                      data-node-type={entry.type}
                      className={cn(
                        'flex w-full items-center justify-between gap-2',
                        'rounded px-2 py-1 text-left text-xs',
                        'hover:bg-muted/50',
                        'focus-visible:bg-muted/70 focus-visible:outline-none',
                      )}
                    >
                      <span className="text-foreground truncate font-mono">
                        {entry.name || entry.idx}
                      </span>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-2 font-mono">
                        <span>{entry.idx}</span>
                        <span className="text-[10px] tracking-wider uppercase">{entry.type}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {filtered.length > visible.length ? (
              <p
                className="text-muted-foreground px-2 py-1 text-center text-[10px]"
                data-testid="sld-node-search-truncated"
              >
                Showing {visible.length} of {filtered.length} matches — refine the query to narrow.
              </p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});
