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
 * The list holds every node of the diagram and, for a generator that stands
 * for a unit of several models, each of those models as well (the machine,
 * the exciter, the governor): they have no node of their own, and a pick
 * shows the symbol of their unit.
 *
 * Once open, the user types; the list narrows to the rows every word
 * typed is found in (case-insensitive): in the `idx`, the `name` or the
 * ANDES model class, or as what the row is (`exciter`, `load`, `bus`; see
 * `searchCategories.ts`). The buttons under the input narrow the list to
 * one of those categories without typing, which is how the controllers of
 * a case are browsed by someone who does not know their names. Selecting
 * a row pans the React Flow viewport to centre that node and writes the
 * node's id to the SLD store so the bus-node visual highlight follows.
 * The zoom stays as it is, unless the diagram is too small to read, in
 * which case the node is shown at full size (`locateZoom`).
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
import { SHORTCUTS } from '@/lib/shortcuts';
import { withShortcut } from '@/lib/shortcutFormatter';
import { cn } from '@/lib/cn';
import type { UnitNodeData } from './graph';
import {
  SEARCH_CATEGORIES,
  SEARCH_CATEGORY_ORDER,
  categoriesAsked,
  categoryCount,
  categoryFilterLabel,
  categoryHasWord,
  categoryOfNode,
  categoryOfRole,
  joinWords,
  searchTokens,
  type SearchCategory,
} from './searchCategories';
import { locateZoom } from './zoom';

/** Per-row payload surfaced in the list. Mirrors React Flow node shape. */
export interface SldSearchEntry {
  /**
   * React Flow node id — bus idx for buses, `${kind}-${idx}` for non-bus. For
   * a model of a generating unit, the id that model is picked by, which the
   * canvas takes to the node of the unit.
   */
  id: string;
  /** What tells two rows apart: the id, and for a model of a unit its class too. */
  key: string;
  /** Display label (the ANDES `name` field, falls back to idx). */
  name: string;
  /** ANDES idx — surfaced as a secondary label and substring-searchable. */
  idx: string;
  /** Node type (`bus`, `generator`, `load`, `shunt`, `line`), or `machine` / `controller` for a model of a unit. */
  type: string;
  /** ANDES model class (`Bus`, `PV`, `GENROU`, `EXST1`); empty when the node names none. */
  model: string;
  /** What the row is: its tag, the words it is found by and what the list is narrowed to. */
  category: SearchCategory;
  /** Where the words of a query are looked for, lower case: the idx, the name and the model class. */
  text: string;
  /** The middle of the node's box, which is what the view is centred on. */
  x: number;
  y: number;
}

export interface SldNodeSearchHandle {
  /** Programmatically open + focus the input. */
  open: () => void;
}

/** Cap on rendered rows. The full filter still runs over the whole list. */
const MAX_VISIBLE_ROWS = 50;

/** How many of `entries` are of each category; one that has none is left out. */
function countByCategory(entries: readonly SldSearchEntry[]): Map<SearchCategory, number> {
  const out = new Map<SearchCategory, number>();
  for (const entry of entries) out.set(entry.category, (out.get(entry.category) ?? 0) + 1);
  return out;
}

/** The text of an entry that a word of a query is looked for in. */
function searchText(idx: string, name: string, model: string): string {
  return `${idx} ${name} ${model}`.toLowerCase();
}

/**
 * Whether every word of a query finds `entry`: anywhere in its idx, name or
 * model class, or as a word for what it is. No words find every entry.
 */
function matches(entry: SldSearchEntry, tokens: readonly string[]): boolean {
  return tokens.every(
    (token) => entry.text.includes(token) || categoryHasWord(entry.category, token),
  );
}

/**
 * Why nothing is listed, when the words typed say what was looked for: a
 * kind of element the diagram has none of (`totals` counts what it has). A
 * case with no dynamic models at all is said to be static-only, as its badge
 * in the sidebar says; one that has some is told which, so a look for the
 * exciters of a case that has only governors ends at the governors. A look
 * for a line is told that the list has none. `null` when the words name no
 * kind, or one the diagram has.
 */
function noneOfKind(
  tokens: readonly string[],
  totals: ReadonlyMap<SearchCategory, number>,
): string | null {
  // An empty diagram has no case to speak of.
  if (totals.size === 0) return null;
  const asked = categoriesAsked(tokens);
  if (asked.length === 0 || asked.some((category) => totals.has(category))) return null;
  // A line is drawn as an edge between two buses, and the search lists nodes.
  if (asked.includes('line')) {
    return 'Lines and transformers are not in this list: click one on the diagram to select it.';
  }
  const isDynamic = (category: SearchCategory) => SEARCH_CATEGORIES[category].dynamic;
  const dynamic = SEARCH_CATEGORY_ORDER.filter((c) => isDynamic(c) && totals.has(c));
  if (dynamic.length === 0 && asked.every(isDynamic)) {
    return 'This case is static-only: it has no machines, exciters, governors or other dynamic models.';
  }
  const none = `The diagram has no ${joinWords(
    asked.map((category) => SEARCH_CATEGORIES[category].plural),
    'or',
  )}.`;
  if (dynamic.length === 0 || !asked.some(isDynamic)) return none;
  const has = dynamic.map((category) => categoryCount(category, totals.get(category) ?? 0));
  return `${none} Its dynamic models: ${joinWords(has, 'and')}.`;
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
  // The category the list is narrowed to, or null for every row.
  const [category, setCategory] = useState<SearchCategory | null>(null);
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
      const data = n.data as
        | { idx?: string; name?: string; kind?: string; unit?: UnitNodeData }
        | undefined;
      const idx = String(data?.idx ?? n.id);
      const name = data?.name ?? '';
      const model = data?.kind ?? '';
      const x = n.position.x + (n.measured?.width ?? 0) / 2;
      const y = n.position.y + (n.measured?.height ?? 0) / 2;
      out.push({
        id: n.id,
        key: n.id,
        idx,
        name,
        type: n.type ?? 'bus',
        model,
        category: categoryOfNode(n.type, data?.kind),
        text: searchText(idx, name, model),
        x,
        y,
      });
      // The models a unit's symbol names, after its own: found where the unit is.
      for (const member of data?.unit?.members.slice(1) ?? []) {
        out.push({
          id: member.nodeId,
          key: `${member.nodeId}|${member.kind}`,
          idx: member.idx,
          name: member.name,
          type: member.role === 'machine' ? 'machine' : 'controller',
          model: member.kind,
          category: categoryOfRole(member.role),
          text: searchText(member.idx, member.name, member.kind),
          x,
          y,
        });
      }
    }
    // Stable display order: one category after another (buses first, the
    // controllers last), each by idx ascending. The rows of a kind stand
    // together, so the list reads like the tables of the bottom drawer and
    // the visible 50-row cap is predictable.
    const rank = (entry: SldSearchEntry) => SEARCH_CATEGORY_ORDER.indexOf(entry.category);
    out.sort(
      (a, b) => rank(a) - rank(b) || a.idx.localeCompare(b.idx, undefined, { numeric: true }),
    );
    return out;
  }, [open, rf]);

  // How many rows the diagram has of each category, and the categories it
  // has any of: one filter button each.
  const totals = useMemo(() => countByCategory(entries), [entries]);
  const present = useMemo(() => SEARCH_CATEGORY_ORDER.filter((c) => totals.has(c)), [totals]);
  // A category kept from an earlier look at another case narrows nothing.
  const active = category !== null && present.includes(category) ? category : null;

  const tokens = useMemo(() => searchTokens(query), [query]);
  const matched = useMemo(
    () => entries.filter((entry) => matches(entry, tokens)),
    [entries, tokens],
  );
  // How many rows the words typed find in each category: the count on its button.
  const counts = useMemo(() => countByCategory(matched), [matched]);
  const filtered = useMemo(
    () => (active === null ? matched : matched.filter((entry) => entry.category === active)),
    [matched, active],
  );
  const visible = filtered.slice(0, MAX_VISIBLE_ROWS);
  const noneInCase = useMemo(
    () => (filtered.length === 0 ? noneOfKind(tokens, totals) : null),
    [filtered.length, tokens, totals],
  );

  const onPick = useCallback(
    (entry: SldSearchEntry) => {
      // Centre the viewport on the node WITHOUT changing the zoom — per
      // the plan's spec ("pans + (no-zoom) centres that node"). React
      // Flow's `setCenter` lets us pin the zoom by reading the current
      // value first; passing `zoom: undefined` would default to 1. A
      // diagram too small to read is the exception: the node searched
      // for is shown at full size, as the canvas shows any node picked
      // away from the diagram.
      const currentZoom = rf.getZoom();
      rf.setCenter(entry.x, entry.y, { zoom: locateZoom(currentZoom), duration: 250 });
      setSelectedNodeId(entry.id);
      setOpen(false);
      setQuery('');
      setCategory(null);
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
          title={withShortcut('Search nodes', SHORTCUTS.searchNodes)}
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
            placeholder="Name, idx or kind, e.g. exciter…"
            aria-label="Search SLD nodes by name, idx or kind"
            data-testid="sld-node-search-input"
            className="h-8 font-mono text-xs"
          />
          {/* What the diagram has, by kind: a press narrows the list to it. */}
          {present.length > 1 ? (
            <div
              role="group"
              aria-label="Show only"
              data-testid="sld-node-search-filters"
              className="flex flex-wrap gap-1"
            >
              <FilterButton
                id="all"
                label="All"
                count={matched.length}
                pressed={active === null}
                onPress={() => setCategory(null)}
              />
              {present.map((c) => (
                <FilterButton
                  key={c}
                  id={c}
                  label={categoryFilterLabel(c)}
                  count={counts.get(c) ?? 0}
                  pressed={active === c}
                  onPress={() => setCategory(active === c ? null : c)}
                />
              ))}
            </div>
          ) : null}
          <p role="status" className="sr-only" data-testid="sld-node-search-count">
            {filtered.length === 1 ? '1 match' : `${filtered.length} matches`}
          </p>
          <div
            className="max-h-72 min-h-0 overflow-auto"
            data-testid="sld-node-search-list"
            // A list only while it has rows: without any it holds a sentence.
            role={visible.length === 0 ? undefined : 'listbox'}
            aria-label={visible.length === 0 ? undefined : 'SLD node search results'}
          >
            {visible.length === 0 ? (
              <div
                data-testid="sld-node-search-empty"
                className="text-muted-foreground flex flex-col items-center gap-1.5 px-2 py-4 text-center text-xs"
              >
                <p>
                  {active === null
                    ? 'No nodes match'
                    : `No ${SEARCH_CATEGORIES[active].plural} match`}
                </p>
                {noneInCase !== null ? (
                  <p data-testid="sld-node-search-none-in-case">{noneInCase}</p>
                ) : active !== null && matched.length > 0 ? (
                  // The words typed find rows of another kind: one press shows them.
                  <button
                    type="button"
                    data-testid="sld-node-search-show-all"
                    onClick={() => setCategory(null)}
                    className={cn(
                      'text-foreground rounded underline underline-offset-2',
                      'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                    )}
                  >
                    {matched.length === 1
                      ? 'Show the 1 match of another kind'
                      : `Show the ${matched.length} matches of other kinds`}
                  </button>
                ) : entries.length > 0 ? (
                  <p>
                    Type part of a name, an idx or a model, or a kind such as{' '}
                    {joinWords(
                      present.slice(0, 3).map((c) => SEARCH_CATEGORIES[c].label.toLowerCase()),
                      'or',
                    )}
                    .
                  </p>
                ) : null}
              </div>
            ) : (
              <ul className="flex flex-col">
                {visible.map((entry) => (
                  <li key={entry.key}>
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
                        <RowTag entry={entry} />
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
                Showing {visible.length} of {filtered.length} matches. Type more, or pick a kind
                above, to narrow.
              </p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});

/**
 * What a row is, in the word it is also found by, and its ANDES model class
 * where that says more (`EXCITER EXDC2`, `LOAD PQ`, but `BUS`).
 */
function RowTag({ entry }: { entry: SldSearchEntry }) {
  const { label } = SEARCH_CATEGORIES[entry.category];
  const showModel = entry.model !== '' && entry.model.toLowerCase() !== label.toLowerCase();
  return (
    <span className="flex items-center gap-1 text-[10px]" data-testid="sld-node-search-tag">
      <span className="tracking-wider uppercase">{label}</span>
      {showModel ? <span>{entry.model}</span> : null}
    </span>
  );
}

/** One button of the filter: a kind of row and how many of them are found. */
function FilterButton({
  id,
  label,
  count,
  pressed,
  onPress,
}: {
  id: string;
  label: string;
  count: number;
  pressed: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={`sld-node-search-filter-${id}`}
      onClick={onPress}
      className={cn(
        'rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[11px]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        pressed
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
        // Nothing to show under it for the words typed.
        count === 0 && !pressed ? 'opacity-60' : '',
      )}
    >
      {label} <span className="text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}
