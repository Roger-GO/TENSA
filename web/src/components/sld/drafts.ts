/**
 * Drafts on the diagram: what a draft is drawn as, and what it still lacks.
 *
 * A draft (`store/drafts.ts`) is an element that was placed on the diagram
 * and is not in the system yet. This module is everything about one that
 * can be worked out without a canvas:
 *
 * - `draftStatus`: the values its form shows (the ones it was given over the
 *   ones a form of its kind opens with) checked against the model's schema,
 *   so the diagram and the list of drafts say "incomplete" or "ready" by the
 *   rule the form itself adds by (`checkElementValues`). `draftReservedIdxs`
 *   gives each draft of a model an idx of its own to open with, and
 *   `draftRows` is the list of drafts as it is shown over the diagram.
 * - `draftGraph`: the nodes and edges the canvas adds to the diagram for the
 *   drafts. A draft stands as a symbol of its own (node type `draft`, drawn
 *   dashed by `DraftNode`). One that names a bus of the case is wired to it:
 *   a device by a connector (a `stub` edge, like the one of a generator, so
 *   it leaves the middle of the face that looks at the bus and lands on a tap
 *   of the bar), and a line or a transformer that names both its buses is
 *   drawn between them as the branch it will be, in the place of its symbol.
 *   Every one of these is an ordinary node or edge to the rest of the
 *   diagram, so the lines go round a draft, the labels keep off it, and it
 *   is dropped clear of what stands there, as a device is (`picture.ts`,
 *   `dropPlace.ts`).
 * - `addedNodeId` and `addedElement`: what a draft becomes once it is added,
 *   so the element can take the place its draft stood in and be selected.
 *
 * Nothing of a draft is written to the layout beside the case
 * (`captureLayout` reads buses, devices and branches by their own types and
 * buckets, and a draft has neither).
 *
 * Pure: no React, nothing read but the arguments.
 */
import type { Edge, Node } from '@xyflow/react';
import type { ParamValue, TopologyParamMeta, TopologySchema, TopologySummary } from '@/api/types';
import { elementDefaults } from '@/components/elements/elementHelp';
import { ELEMENT_KINDS, type ElementKind } from '@/components/elements/elementKinds';
import {
  checkElementValues,
  existingIdxSetFor,
  nextAvailableIdx,
  pickTargets,
  seedElementValues,
  withHeldValues,
} from '@/components/elements/elementValues';
import { subKindForControllerClass } from '@/lib/controllers';
import type { RouteOverride, SelectedElement } from '@/store/case';
import { DRAFT_NODE_SIZE, type DraftElement, type KeptRoute } from '@/store/drafts';

export { DRAFT_NODE_SIZE };

/** The React Flow node type of a draft. */
export const DRAFT_NODE_TYPE = 'draft';

/**
 * How the line of a draft is drawn, a connector to its bus or the branch it
 * will be: dashed, in the colour of its badge, where a line of the system is
 * solid. `active` is the line of the draft that is picked.
 */
export function draftStrokeStyle(
  ready: boolean,
  active = false,
): { stroke: string; strokeWidth: number; strokeDasharray: string } {
  return {
    stroke: active
      ? 'var(--color-primary)'
      : ready
        ? 'var(--color-success)'
        : 'var(--color-warning)',
    strokeWidth: active ? 2.5 : 1.5,
    strokeDasharray: '6 4',
  };
}

/** The edge of a draft that is drawn as a branch: `draft-line-<draft id>`. */
export function draftBranchEdgeId(draftId: string): string {
  return `draft-line-${draftId}`;
}

/** The kinds a draft is drawn as a branch for, once it names both its buses. */
const BRANCH_KINDS: ReadonlySet<string> = new Set(['Line', 'Transformer2W']);

/** The models whose element is a node of its own on the diagram, with the type of that node. */
const NODE_TYPE_OF_MODEL: Readonly<Record<string, 'generator' | 'load' | 'shunt'>> = {
  PV: 'generator',
  Slack: 'generator',
  PQ: 'load',
  Shunt: 'shunt',
};

/** The entry of `ELEMENT_KINDS` a draft is of, or `null` for a kind the app no longer offers. */
export function draftKind(draft: Pick<DraftElement, 'kind'>): ElementKind | null {
  return ELEMENT_KINDS.find((k) => k.value === draft.kind) ?? null;
}

export interface DraftStatus {
  /** Whether nothing is missing or refused: the draft can be added as it is. */
  ready: boolean;
  /** The required fields that are empty, by name, in the order the form shows them. */
  missing: string[];
  /** The fields that hold a value the form refuses, by name. */
  refused: string[];
  /** The values the form of the draft shows: what it was given, over what a form opens with. */
  values: Record<string, ParamValue>;
  /** Those values as the server takes them. Whole only for a draft that is ready. */
  params: Record<string, ParamValue>;
}

/** The fields of the model a draft is sent as, or `null` while the schema is not in. */
export function draftFields(
  draft: Pick<DraftElement, 'kind'>,
  schema: TopologySchema | null | undefined,
): readonly TopologyParamMeta[] | null {
  const kind = draftKind(draft);
  const metas = kind === null ? undefined : schema?.models[kind.submitModel];
  return metas === undefined || metas.length === 0 ? null : metas;
}

/** What a form of `kind` opens with besides the next free idx: the kind's own values, or the model's for this case. */
export function draftDefaults(
  kind: ElementKind,
  baseMva: number | null,
): Record<string, string | number | boolean> | undefined {
  return kind.defaultParams ?? elementDefaults(kind.submitModel, { baseMva });
}

/**
 * The idx values the form of each draft does not propose, by the id of the
 * draft: a form opens with the next free idx of the case, and two drafts of
 * one model would both open with the same. So each keeps off the idx that
 * was typed into any other draft of its model, and off the ones proposed to
 * the drafts placed before it: three loads dropped in a row are `PQ_12`,
 * `PQ_13` and `PQ_14`, and when the first is added or deleted the others
 * follow the case as any form does.
 */
export function draftReservedIdxs(
  drafts: readonly DraftElement[],
  topology: TopologySummary | null,
): Map<string, string[]> {
  const modelOf = (draft: DraftElement) => draftKind(draft)?.submitModel;
  const typed = (draft: DraftElement): string | null => {
    const idx = draft.values.idx;
    return idx === undefined || String(idx) === '' ? null : String(idx);
  };
  // The idx values proposed so far, by model.
  const proposed = new Map<string, string[]>();
  const reserved = new Map<string, string[]>();
  for (const draft of drafts) {
    const model = modelOf(draft);
    if (model === undefined) continue;
    const before = proposed.get(model) ?? [];
    const kept = [
      ...drafts
        .filter((other) => other !== draft && modelOf(other) === model)
        .map(typed)
        .filter((idx) => idx !== null),
      ...before,
    ];
    reserved.set(draft.id, kept);
    // One whose idx was set, to a value or to nothing, is proposed none.
    if (!('idx' in draft.values)) {
      proposed.set(model, [...before, nextAvailableIdx(model, topology, kept)]);
    }
  }
  return reserved;
}

/**
 * What `draft` holds and whether it can be added, for the case whose
 * topology is `topology`. `reservedIdxs` are the idx values its form does not
 * propose (`draftReservedIdxs`). `null` while the schema is not in, and for a
 * kind the app has no form for.
 */
export function draftStatus(
  draft: DraftElement,
  schema: TopologySchema | null | undefined,
  topology: TopologySummary | null,
  reservedIdxs?: readonly string[],
): DraftStatus | null {
  const kind = draftKind(draft);
  const metas = draftFields(draft, schema);
  if (kind === null || metas === null) return null;
  const model = kind.submitModel;
  const defaults = draftDefaults(kind, topology?.base_mva ?? null);
  const values = withHeldValues(
    model,
    seedElementValues(model, metas, topology, defaults, reservedIdxs),
    draft.values,
  );
  const { errors, params } = checkElementValues(
    metas,
    values,
    existingIdxSetFor(topology, model),
    pickTargets(topology),
  );
  const isEmpty = (name: string) => values[name] === '' || values[name] === undefined;
  // In the order the form shows them: the required fields, then the others.
  const wrong = [...metas.filter((m) => m.required), ...metas.filter((m) => !m.required)]
    .map((m) => m.name)
    .filter((name) => name in errors);
  return {
    ready: wrong.length === 0,
    missing: wrong.filter(isEmpty),
    refused: wrong.filter((name) => !isEmpty(name)),
    values,
    // What the form opens with goes with the add where a field was left empty.
    params: defaults ? { ...defaults, ...params } : params,
  };
}

/** "bus", "bus and Vn", "bus, Vn and p0". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a draft still lacks, in a few words: `Missing bus and Vn`, `Check
 * idx`, or `Ready to add`. For the list of drafts and the name of its node.
 */
export function draftSummary(status: DraftStatus | null): string {
  if (status === null) return 'Checking';
  if (status.ready) return 'Ready to add';
  const parts: string[] = [];
  if (status.missing.length > 0) parts.push(`Missing ${listOf(status.missing)}`);
  if (status.refused.length > 0) {
    parts.push(`${parts.length === 0 ? 'Check' : 'check'} ${listOf(status.refused)}`);
  }
  return parts.join('; ');
}

/** A draft as the list of drafts shows it (`SldDraftsIndicator`). */
export interface DraftRow {
  id: string;
  /** The kind the draft is of: a `value` of `ELEMENT_KINDS`. */
  kind: string;
  /** What the draft is called, `PV generator 3`. */
  name: string;
  /** Whether it can be added to the system as it is. */
  ready: boolean;
  /** What it still lacks, in a few words. */
  summary: string;
}

/** The rows of the list of drafts, in the order the drafts were placed. */
export function draftRows(
  drafts: readonly DraftElement[],
  schema: TopologySchema | null | undefined,
  topology: TopologySummary | null,
): DraftRow[] {
  const reserved = draftReservedIdxs(drafts, topology);
  return drafts.map((draft) => {
    const status = draftStatus(draft, schema, topology, reserved.get(draft.id));
    return {
      id: draft.id,
      kind: draft.kind,
      name: draftName(draft, status),
      ready: status?.ready === true,
      summary: draftSummary(status),
    };
  });
}

/** What a draft is called: its kind and the idx it has now, `PV generator 3`. */
export function draftName(draft: DraftElement, status: DraftStatus | null): string {
  const label = draftKind(draft)?.label ?? draft.kind;
  const idx = status?.values.idx;
  return idx === undefined || idx === '' ? label : `${label} ${String(idx)}`;
}

/** The short name a draft carries under its symbol: the model and the idx, `PV 3`. */
export function draftCaption(draft: DraftElement, status: DraftStatus | null): string {
  const idx = status?.values.idx;
  const model = draft.kind === 'Transformer2W' ? 'Trafo' : draft.kind;
  if (idx === undefined || idx === '') return model;
  const text = String(idx);
  // An idx that already says what it is (`GENROU_2`) stands alone.
  return text.toLowerCase().startsWith(model.toLowerCase()) ? text : `${model} ${text}`;
}

/** What a draft is connected to on the diagram, from the values it holds. */
export interface DraftWiring {
  /** The bus a device hangs off, when the case has it. */
  bus: string | null;
  /** The two buses of a line or a transformer, when the case has both and they differ. */
  ends: { from: string; to: string } | null;
}

export function draftWiring(
  draft: DraftElement,
  status: DraftStatus | null,
  buses: ReadonlySet<string>,
): DraftWiring {
  const named = (field: string): string | null => {
    const value = status?.values[field];
    const idx = value === undefined || value === '' ? null : String(value);
    return idx !== null && buses.has(idx) ? idx : null;
  };
  if (BRANCH_KINDS.has(draft.kind)) {
    const [from, to] = [named('bus1'), named('bus2')];
    return { bus: null, ends: from !== null && to !== null && from !== to ? { from, to } : null };
  }
  return { bus: named('bus'), ends: null };
}

/** What `DraftNode` reads of its node. */
export interface DraftNodeData extends Record<string, unknown> {
  draft: true;
  /** The id of the draft, which is the id of the node as well. */
  idx: string;
  /** What the draft is called, `PV generator 3`. */
  name: string;
  /** The kind it is a draft of: a `value` of `ELEMENT_KINDS`. */
  kind: string;
  /** The short name under the symbol. */
  caption: string;
  ready: boolean;
  /** What it still lacks, in a few words. */
  summary: string;
  /** The bus it hangs off, which takes it along when it is moved. */
  parentBus?: string;
}

export interface DraftGraphOptions {
  schema: TopologySchema | null | undefined;
  topology: TopologySummary | null;
  /** Where each bus stands, by its idx: the anchors of a route are read against it. */
  busPositions: ReadonlyMap<string, { x: number; y: number }>;
  /** The route kept for the branch of a draft, by edge id (`routeOverrides`). */
  routes?: Readonly<Record<string, RouteOverride | null>>;
  /**
   * The route the branch of a draft was last drawn along, by edge id, as it
   * is kept with the drafts (`KeptDraftRoutes.own`): for one `routes` says
   * nothing of, as in a case that was just opened again.
   */
  kept?: Readonly<Record<string, KeptRoute>>;
}

const standsAt = (
  at: { x: number; y: number } | undefined,
  place: { x: number; y: number },
): boolean =>
  at !== undefined && Math.abs(at.x - place.x) < 0.01 && Math.abs(at.y - place.y) < 0.01;

/**
 * The nodes and edges the diagram draws for `drafts`. A draft the app has
 * no form for is still drawn, as incomplete, so it can be found and deleted.
 */
export function draftGraph(
  drafts: readonly DraftElement[],
  options: DraftGraphOptions,
): { nodes: Node[]; edges: Edge[] } {
  const { schema, topology, busPositions } = options;
  const buses = new Set((topology?.buses ?? []).map((b) => String(b.idx)));
  const reserved = draftReservedIdxs(drafts, topology);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const draft of drafts) {
    const status = draftStatus(draft, schema, topology, reserved.get(draft.id));
    const name = draftName(draft, status);
    const summary = draftSummary(status);
    const wiring = draftWiring(draft, status, buses);
    if (wiring.ends !== null) {
      // A line or a transformer that names both its buses: the branch it
      // will be, routed like any other and kept on the route it was given
      // while its buses stand where they stood then.
      const id = draftBranchEdgeId(draft.id);
      const { from, to } = wiring.ends;
      // `null` among the routes says that it has none, whatever was kept.
      const chosen = options.routes?.[id];
      const held = chosen === undefined ? options.kept?.[id] : (chosen ?? undefined);
      const fits =
        held !== undefined &&
        held.points.length >= 2 &&
        standsAt(busPositions.get(from), held.anchors.source) &&
        standsAt(busPositions.get(to), held.anchors.target);
      const transformer = draft.kind === 'Transformer2W';
      edges.push({
        id,
        source: from,
        target: to,
        // The words a line of the case is named by, so that what reads the
        // diagram from the page takes it for the line it is drawn as.
        ariaLabel: `Draft ${name}: ${summary}, bus ${from} to bus ${to}`,
        type: transformer ? 'transformer' : fits ? 'routed' : 'topology',
        data: {
          draft: true,
          draftId: draft.id,
          name,
          ready: status?.ready === true,
          ...(fits
            ? {
                bendPoints: held.points,
                bendAnchors: {
                  source: { ...held.anchors.source },
                  target: { ...held.anchors.target },
                },
              }
            : {}),
          ...(transformer ? { winding: '2w' } : {}),
        },
      });
      continue;
    }
    const data: DraftNodeData = {
      draft: true,
      idx: draft.id,
      name,
      kind: draft.kind,
      caption: draftCaption(draft, status),
      ready: status?.ready === true,
      summary,
      ...(wiring.bus !== null ? { parentBus: wiring.bus } : {}),
    };
    nodes.push({
      id: draft.id,
      type: DRAFT_NODE_TYPE,
      ariaLabel: `Draft ${name}: ${summary}`,
      position: { x: draft.position.x, y: draft.position.y },
      initialWidth: DRAFT_NODE_SIZE.width,
      initialHeight: DRAFT_NODE_SIZE.height,
      data,
    });
    if (wiring.bus !== null) {
      edges.push({
        id: `stub-${draft.id}`,
        ariaLabel: `Draft ${name}, connection to bus ${wiring.bus}`,
        source: draft.id,
        target: wiring.bus,
        type: 'stub',
        data: { draft: true, draftId: draft.id, name, ready: status?.ready === true },
      });
    }
  }
  return { nodes, edges };
}

/** The id of the draft a node or an edge of the diagram is drawn for, or `null`. */
export function draftIdOf(item: { data?: unknown } | null | undefined): string | null {
  const data = item?.data as { draft?: unknown; draftId?: unknown; idx?: unknown } | undefined;
  if (data?.draft !== true) return null;
  const id = data.draftId ?? data.idx;
  return typeof id === 'string' ? id : null;
}

/**
 * The id of the node the element a draft was added as is drawn on, for a
 * model that has a node of its own: a bus, a static generator, a load, a
 * shunt. `null` for the others (a line is an edge, a machine joins the
 * symbol of its generator, a controller is named on that symbol).
 */
export function addedNodeId(model: string, idx: string): string | null {
  if (model === 'Bus') return idx;
  const type = NODE_TYPE_OF_MODEL[model];
  return type === undefined ? null : `${type}-${idx}`;
}

/**
 * The element a draft was added as, as the Inspector selects one: by the
 * model it was sent as and the values it was sent with. A line with a tap
 * or a phase shift is listed with the transformers.
 */
export function addedElement(
  model: string,
  params: Readonly<Record<string, ParamValue>>,
): SelectedElement | null {
  const idx = params.idx === undefined ? '' : String(params.idx);
  if (idx === '') return null;
  if (model === 'Bus') return { kind: 'bus', idx };
  if (model === 'Line') {
    const off = (name: string, nominal: number): boolean => {
      const value = params[name];
      return value !== undefined && Math.abs(Number(value) - nominal) > 1e-9;
    };
    return { kind: off('tap', 1) || off('phi', 0) ? 'transformer' : 'line', idx };
  }
  if (model === 'PV' || model === 'Slack' || model === 'GENROU' || model === 'GENCLS') {
    return { kind: 'generator', idx, modelClass: model };
  }
  if (model === 'PQ' || model === 'ZIP') return { kind: 'load', idx, modelClass: model };
  if (model === 'Shunt') return { kind: 'shunt', idx };
  return { kind: 'controller', subKind: subKindForControllerClass(model), modelClass: model, idx };
}
