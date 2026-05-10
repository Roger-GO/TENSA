import { useMemo } from 'react';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import { usePlotStore, parseColumnName, groupLabel } from '@/store/plot';
import type { ParsedSeries, VarGroup } from '@/store/plot';
import { RunLegendChip } from './RunLegendChip';
import { cn } from '@/lib/cn';

/**
 * Tree multi-select for state variables on the active run.
 *
 * Hierarchy:
 *   group (e.g., "Bus voltages")
 *     element (e.g., "BUS5")
 *       series (e.g., "Bus_5_v")
 *
 * Each level has a checkbox:
 *   - Leaf checkbox: toggles a single series in the plot store.
 *   - Element checkbox: toggles all series under the element.
 *   - Group checkbox: toggles all series under the group.
 * Element / group checkboxes show a partial-checked (indeterminate)
 * state when only some children are selected.
 *
 * Filter input narrows the visible tree by substring match against
 * each series name. Empty filter = show everything.
 *
 * Reads the active run + the run's column metadata from the runs
 * store; reads selection + filter + expanded state from the plot
 * store.
 *
 * Sort order: elements within a group are sorted by their numeric
 * idx when parseable, falling back to lexicographic. Series within an
 * element are sorted by their stable column-list order in the run.
 */
export interface VariableTreePickerProps {
  /** Override active run id (mostly for tests). */
  runId?: string;
  className?: string;
}

interface ElementBucket {
  elementIdx: string;
  series: ParsedSeries[];
}

interface GroupBucket {
  group: VarGroup;
  elements: ElementBucket[];
  /** Total leaf series count across elements (used for the header counter). */
  totalSeries: number;
}

/**
 * Sort ``a`` before ``b`` if both parse as numbers; otherwise fall
 * back to ``localeCompare``. ``BUS5`` and ``5`` both sort numerically;
 * ``GENROU_1`` falls through to lexicographic.
 */
function compareElementIdx(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/**
 * Build the tree from a list of runs, taking the **union** of their
 * column names. The per-run availability is tracked in
 * ``availability``: ``Map<columnName, Set<runId>>`` so the per-run
 * filter row can grey out columns absent from a given run.
 *
 * In single-run mode (one run in the list), this collapses to the
 * legacy behaviour: ``buildTree(run.columnNames, filter)``.
 */
function buildUnionTree(
  runs: readonly RunRecord[],
  filter: string,
): { tree: GroupBucket[]; availability: ReadonlyMap<string, ReadonlySet<string>> } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const availability = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const name of run.columnNames) {
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
      let set = availability.get(name);
      if (!set) {
        set = new Set<string>();
        availability.set(name, set);
      }
      set.add(run.runId);
    }
  }
  return { tree: buildTree(ordered, filter), availability };
}

/**
 * Build the tree from a run's column list. Filters out columns that
 * don't parse as a known group. Filtering by substring is applied at
 * the leaf level; elements / groups with zero matching leaves are
 * dropped from the result.
 */
function buildTree(columnNames: readonly string[], filter: string): GroupBucket[] {
  const lc = filter.trim().toLowerCase();
  const groupMap = new Map<VarGroup, Map<string, ParsedSeries[]>>();
  for (const name of columnNames) {
    const parsed = parseColumnName(name);
    if (!parsed) continue;
    if (lc.length > 0 && !name.toLowerCase().includes(lc)) continue;
    let elementMap = groupMap.get(parsed.group);
    if (!elementMap) {
      elementMap = new Map();
      groupMap.set(parsed.group, elementMap);
    }
    const list = elementMap.get(parsed.elementIdx);
    if (list) list.push(parsed);
    else elementMap.set(parsed.elementIdx, [parsed]);
  }

  const groupOrder: VarGroup[] = ['bus_v', 'gen_state', 'line_flow'];
  const out: GroupBucket[] = [];
  for (const g of groupOrder) {
    const elementMap = groupMap.get(g);
    if (!elementMap) continue;
    const elements: ElementBucket[] = [];
    let total = 0;
    const sortedKeys = Array.from(elementMap.keys()).sort(compareElementIdx);
    for (const elementIdx of sortedKeys) {
      const series = elementMap.get(elementIdx)!;
      total += series.length;
      elements.push({ elementIdx, series });
    }
    out.push({ group: g, elements, totalSeries: total });
  }
  return out;
}

/** Tri-state checkbox (checked / unchecked / indeterminate). */
function TriCheckbox({
  state,
  onChange,
  ariaLabel,
  testId,
}: {
  state: 'checked' | 'unchecked' | 'partial';
  onChange: () => void;
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <input
      type="checkbox"
      checked={state === 'checked'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'partial';
      }}
      onChange={onChange}
      aria-label={ariaLabel}
      aria-checked={state === 'partial' ? 'mixed' : state === 'checked'}
      data-testid={testId}
      className={cn(
        'border-border h-3.5 w-3.5 rounded border',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
      )}
    />
  );
}

export function VariableTreePicker({ runId, className }: VariableTreePickerProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const overlayRunIds = useRunsStore((s) => s.overlayRunIds);
  const allRuns = useRunsStore((s) => s.runs);
  const effectiveRunId = runId ?? activeRunId;
  const run = effectiveRunId ? allRuns[effectiveRunId] : undefined;

  // Resolve the runs the picker reflects. Mirrors TimeSeriesPlot's
  // priority: explicit prop > overlay set > active run.
  const overlayRuns = useMemo<readonly RunRecord[]>(() => {
    if (runId) return run ? [run] : [];
    if (overlayRunIds.size > 0) {
      const out: RunRecord[] = [];
      for (const id of Object.keys(allRuns)) {
        if (overlayRunIds.has(id)) out.push(allRuns[id]!);
      }
      return out;
    }
    return run ? [run] : [];
  }, [runId, overlayRunIds, allRuns, run]);

  const isMultiRun = overlayRuns.length > 1;

  const selected = usePlotStore((s) =>
    effectiveRunId ? s.selectedByRun[effectiveRunId] : undefined,
  );
  const filter = usePlotStore((s) => (effectiveRunId ? (s.filterByRun[effectiveRunId] ?? '') : ''));
  const expanded = usePlotStore((s) =>
    effectiveRunId ? s.expandedByRun[effectiveRunId] : undefined,
  );
  const toggleSeries = usePlotStore((s) => s.toggleSeries);
  const setSelection = usePlotStore((s) => s.setSelection);
  const setFilter = usePlotStore((s) => s.setFilter);
  const toggleExpanded = usePlotStore((s) => s.toggleExpanded);

  const { tree, availability } = useMemo(() => {
    if (overlayRuns.length === 0) {
      return { tree: [], availability: new Map<string, Set<string>>() };
    }
    return buildUnionTree(overlayRuns, filter);
  }, [overlayRuns, filter]);

  const selectionSet = selected ?? new Set<string>();
  const expandedSet = expanded ?? new Set<string>();
  const selectedCount = selectionSet.size;

  if (!effectiveRunId || !run) {
    return (
      <div
        data-testid="variable-tree-picker-empty"
        className={cn(
          'flex h-full w-full items-center justify-center',
          'text-muted-foreground p-4 text-sm',
          className,
        )}
      >
        Run a TDS to choose variables.
      </div>
    );
  }

  /** Group-level checkbox state. */
  const groupState = (g: GroupBucket): 'checked' | 'unchecked' | 'partial' => {
    let any = false;
    let all = true;
    for (const e of g.elements) {
      for (const s of e.series) {
        if (selectionSet.has(s.name)) any = true;
        else all = false;
      }
    }
    if (all && any) return 'checked';
    if (any) return 'partial';
    return 'unchecked';
  };

  /** Element-level checkbox state. */
  const elementState = (e: ElementBucket): 'checked' | 'unchecked' | 'partial' => {
    let any = false;
    let all = true;
    for (const s of e.series) {
      if (selectionSet.has(s.name)) any = true;
      else all = false;
    }
    if (all && any) return 'checked';
    if (any) return 'partial';
    return 'unchecked';
  };

  const onToggleGroup = (g: GroupBucket) => {
    const next = new Set(selectionSet);
    const allLeaves = g.elements.flatMap((e) => e.series.map((s) => s.name));
    const isAllChecked = allLeaves.every((n) => next.has(n));
    if (isAllChecked) {
      for (const n of allLeaves) next.delete(n);
    } else {
      for (const n of allLeaves) next.add(n);
    }
    setSelection(effectiveRunId, next);
  };

  const onToggleElement = (e: ElementBucket) => {
    const next = new Set(selectionSet);
    const leaves = e.series.map((s) => s.name);
    const isAllChecked = leaves.every((n) => next.has(n));
    if (isAllChecked) {
      for (const n of leaves) next.delete(n);
    } else {
      for (const n of leaves) next.add(n);
    }
    setSelection(effectiveRunId, next);
  };

  return (
    <div
      data-testid="variable-tree-picker"
      data-multi-run={isMultiRun ? 'true' : 'false'}
      className={cn('flex h-full w-full flex-col gap-2 p-2 text-sm', className)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground font-medium">Variables</span>
        <span data-testid="variable-tree-picker-count" className="text-muted-foreground text-xs">
          {selectedCount} selected
        </span>
      </div>
      {isMultiRun ? (
        <div
          data-testid="variable-tree-picker-runs-row"
          className="border-border flex flex-wrap items-center gap-1 rounded border px-1.5 py-1"
        >
          <span className="text-muted-foreground pr-1 text-[10px] uppercase">Overlay</span>
          {overlayRuns.map((r) => (
            <RunLegendChip key={r.runId} runId={r.runId} pinned />
          ))}
        </div>
      ) : null}
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(effectiveRunId, e.target.value)}
        placeholder="Filter (e.g., BUS5)"
        aria-label="Filter variables"
        data-testid="variable-tree-picker-filter"
        className={cn(
          'bg-background border-border h-7 rounded border px-2 text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      />
      <div
        role="tree"
        aria-label="State variables"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      >
        {tree.length === 0 ? (
          <div
            data-testid="variable-tree-picker-no-matches"
            className="text-muted-foreground p-2 text-xs"
          >
            No variables match the filter.
          </div>
        ) : (
          tree.map((g) => {
            const isExpanded = expandedSet.has(g.group);
            return (
              <div key={g.group} role="treeitem" aria-expanded={isExpanded}>
                <div className="hover:bg-muted/50 flex items-center gap-1 rounded px-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(effectiveRunId, g.group)}
                    aria-label={
                      isExpanded
                        ? `Collapse ${groupLabel(g.group)}`
                        : `Expand ${groupLabel(g.group)}`
                    }
                    data-testid={`variable-tree-picker-expand-${g.group}`}
                    className={cn(
                      'text-muted-foreground hover:text-foreground inline-flex h-4 w-4 items-center justify-center rounded',
                    )}
                  >
                    <span aria-hidden="true" className="text-[10px]">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                  <TriCheckbox
                    state={groupState(g)}
                    onChange={() => onToggleGroup(g)}
                    ariaLabel={`Toggle all ${groupLabel(g.group)}`}
                    testId={`variable-tree-picker-group-${g.group}`}
                  />
                  <span className="text-foreground font-medium">{groupLabel(g.group)}</span>
                  <span className="text-muted-foreground text-xs">({g.totalSeries})</span>
                </div>
                {isExpanded ? (
                  <div className="ml-5 flex flex-col gap-0.5">
                    {g.elements.map((el) => {
                      const elKey = `${g.group}-${el.elementIdx}`;
                      return (
                        <div key={elKey} role="treeitem">
                          <div className="hover:bg-muted/50 flex items-center gap-1 rounded px-1 py-0.5">
                            <TriCheckbox
                              state={elementState(el)}
                              onChange={() => onToggleElement(el)}
                              ariaLabel={`Toggle ${groupLabel(g.group)} element ${el.elementIdx}`}
                              testId={`variable-tree-picker-element-${elKey}`}
                            />
                            <span className="text-foreground font-mono text-xs">
                              {el.elementIdx}
                            </span>
                            <span className="text-muted-foreground text-[10px]">
                              ({el.series.length})
                            </span>
                          </div>
                          <div className="ml-4 flex flex-col gap-0.5">
                            {el.series.map((s) => {
                              const isOn = selectionSet.has(s.name);
                              const availSet = availability.get(s.name);
                              // In multi-run mode, surface a run count
                              // (e.g. ``2/3``) so the user can tell if a
                              // var is missing from one of their overlay
                              // runs. The picker still lets them tick
                              // the box (the plot just renders only the
                              // runs that have the column).
                              const missingFromAny =
                                isMultiRun &&
                                availSet !== undefined &&
                                availSet.size < overlayRuns.length;
                              return (
                                <label
                                  key={s.name}
                                  className={cn(
                                    'hover:bg-muted/50 flex cursor-pointer items-center gap-1 rounded px-1 py-0.5',
                                    missingFromAny ? 'opacity-70' : '',
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isOn}
                                    onChange={() => toggleSeries(effectiveRunId, s.name)}
                                    aria-label={`Toggle series ${s.name}`}
                                    data-testid={`variable-tree-picker-leaf-${s.name}`}
                                    className={cn(
                                      'border-border h-3.5 w-3.5 rounded border',
                                      'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                                    )}
                                  />
                                  <span className="text-foreground font-mono text-xs">
                                    {s.name}
                                  </span>
                                  {isMultiRun && availSet !== undefined ? (
                                    <span
                                      data-testid={`variable-tree-picker-leaf-availability-${s.name}`}
                                      className={cn(
                                        'text-muted-foreground ml-auto font-mono text-[10px]',
                                        missingFromAny ? 'text-danger/80' : '',
                                      )}
                                      title={
                                        missingFromAny
                                          ? `Available in ${availSet.size} of ${overlayRuns.length} overlay runs`
                                          : `Available in all ${overlayRuns.length} overlay runs`
                                      }
                                    >
                                      {availSet.size}/{overlayRuns.length}
                                    </span>
                                  ) : null}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
