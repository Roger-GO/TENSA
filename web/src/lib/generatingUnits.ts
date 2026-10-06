/**
 * Generating units: which models of a case make up one generator.
 *
 * ANDES describes a generator in pieces. The power flow solves a static
 * generator (`PV`, `Slack`). A time-domain run puts a machine in its place
 * (`GENROU`, `GENCLS`, which names the generator in `gen`), and the machine
 * has its controllers: an exciter and a governor name it in `syn`, a
 * stabiliser names the exciter in `avr`. A converter does the same from the
 * other side: `REGCA1` names the generator in `gen`, `REECA1` the converter
 * in `reg`, `REPCA1` the electrical control in `ree`. To the person reading
 * the diagram all of that is one generator on one bus, so the diagram draws
 * it as one symbol and the Inspector lists it as one unit. This module is
 * the one place that says what belongs together.
 *
 * A unit goes by the idx of its static generator: that is what the power
 * flow reports on, what every other model of the unit leads back to, and
 * what is still there when the case is saved without its dynamic models. A
 * machine that names no generator of the case is a unit of its own, under
 * its own idx.
 *
 * Pure: nothing is read but the topology.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';
import {
  controllerSubKindLabel,
  subKindForControllerClass,
  type ControllerSubKind,
} from '@/lib/controllers';
import { DYNAMIC_GENERATOR_KINDS } from '@/lib/topology';
import type { SelectedElement } from '@/store/case';

/** What a model is to its unit: the generator, a machine, or a kind of controller. */
export type UnitRole = 'generator' | 'machine' | ControllerSubKind;

/** One model of a generating unit. */
export interface UnitMember {
  entry: TopologyEntry;
  /** ANDES model class (`PV`, `GENROU`, `EXST1`). */
  kind: string;
  idx: string;
  role: UnitRole;
  /**
   * The id the model goes by wherever one is picked by id: `generator-<idx>`
   * for a generator or a machine, `controller-<class>-<idx>` for a
   * controller. The tables, the search and the Inspector select by it, and
   * the diagram finds the unit it belongs to.
   */
  nodeId: string;
  /** How many references lead from the model back to the root of the unit. */
  depth: number;
}

/** A generator of the diagram: its static generator, its machine and their controllers. */
export interface GeneratingUnit {
  /** The idx the unit goes by: its static generator's, or its machine's when it has none. */
  idx: string;
  /** The bus the unit is on, or `null` when its root names none. */
  bus: string | null;
  /**
   * Every model of the unit, each after the one it refers to: the root first
   * (the static generator, or the machine of a unit that has none), then the
   * machine with its exciter, the stabiliser of that exciter and its
   * governor, then what names the generator itself (a converter and its
   * controls).
   */
  members: UnitMember[];
}

export interface GeneratingUnits {
  units: GeneratingUnit[];
  /**
   * The controllers that belong to no unit: one that acts on a bus (a PMU),
   * one whose reference names nothing in the case, and what refers to
   * either.
   */
  loose: TopologyEntry[];
}

/** The idx an entry names in `param`, or `null` when it names none. */
function refOf(entry: TopologyEntry, param: string): string | null {
  const value = entry.params?.[param];
  if (value === undefined || value === null || typeof value === 'boolean') return null;
  const text = String(value);
  return text === '' ? null : text;
}

/**
 * The params in which a controller names another controller, and the model
 * the name is meant for. An idx is only unique within a group of models, so
 * an exciter and a governor can both be `1`: the model a param is meant for
 * is the one taken. Failing that, a model the diagram has no name for is
 * taken (it may be of that group, and new to the table that names them), and
 * never a model of another group. A stabiliser whose exciter the case does
 * not list therefore belongs to no unit: it is not hung on the governor that
 * happens to have the exciter's idx.
 */
const CHAIN_REFS: ReadonlyArray<{ param: string; meant: (kind: string) => boolean }> = [
  { param: 'avr', meant: (kind) => subKindForControllerClass(kind) === 'exciter' },
  { param: 'reg', meant: (kind) => kind.startsWith('REG') },
  { param: 'ree', meant: (kind) => kind.startsWith('REE') },
];

/** The order the controllers of one model are listed in. */
const ROLE_ORDER: readonly UnitRole[] = [
  'generator',
  'machine',
  'exciter',
  'pss',
  'governor',
  'renewable',
  'measurement',
  'profile',
  'other',
];

/** The id a model goes by (see `UnitMember.nodeId`). */
function nodeIdOf(role: UnitRole, kind: string, idx: string): string {
  return role === 'generator' || role === 'machine'
    ? `generator-${idx}`
    : `controller-${kind}-${idx}`;
}

interface Draft {
  idx: string;
  bus: string | null;
  generator: TopologyEntry | null;
  machines: TopologyEntry[];
}

/**
 * Group the generators and the controllers of `topology` into generating
 * units.
 *
 * A machine joins the static generator it names in `gen`, when the two are on
 * the same bus. One that names none there joins the unit that goes by its
 * idx, if there is one: some cases number a generator and its machine alike
 * and leave the link out, and a unit is found by its idx, so two cannot
 * share one. Otherwise it stands alone. A controller joins the unit of what
 * it names: a machine in `syn`, a generator in `gen`, or another controller
 * of the unit. Where a `syn` matches no machine but a generator, or a `gen`
 * no generator but a machine, that one is taken: the reference can only
 * mean it.
 */
export function generatingUnits(topology: TopologySummary): GeneratingUnits {
  const generators = topology.generators ?? [];
  const controllers = topology.controllers ?? [];

  const drafts: Draft[] = [];
  const byIdx = new Map<string, Draft>();
  // The unit each generator and machine is in, and each of them by its idx.
  const unitOf = new Map<TopologyEntry, Draft>();
  const staticByIdx = new Map<string, TopologyEntry>();
  const machineByIdx = new Map<string, TopologyEntry>();

  for (const entry of generators) {
    if (DYNAMIC_GENERATOR_KINDS.has(entry.kind)) continue;
    const idx = String(entry.idx);
    // Two static generators cannot share an idx; a second one is not drawn.
    if (staticByIdx.has(idx)) continue;
    const draft: Draft = { idx, bus: refOf(entry, 'bus'), generator: entry, machines: [] };
    drafts.push(draft);
    byIdx.set(idx, draft);
    staticByIdx.set(idx, entry);
    unitOf.set(entry, draft);
  }
  for (const entry of generators) {
    if (!DYNAMIC_GENERATOR_KINDS.has(entry.kind)) continue;
    const idx = String(entry.idx);
    if (machineByIdx.has(idx)) continue;
    const bus = refOf(entry, 'bus');
    const named = refOf(entry, 'gen');
    const namedGenerator = named === null ? undefined : staticByIdx.get(named);
    let draft = namedGenerator === undefined ? undefined : unitOf.get(namedGenerator);
    // A machine that names a generator of another bus is drawn where it says it is.
    if (draft !== undefined && bus !== null && draft.bus !== null && draft.bus !== bus) {
      draft = undefined;
    }
    // One unit per idx: the diagram and the tables find a unit by it.
    draft ??= byIdx.get(idx);
    if (draft === undefined) {
      draft = { idx, bus, generator: null, machines: [] };
      drafts.push(draft);
      byIdx.set(idx, draft);
    }
    draft.machines.push(entry);
    machineByIdx.set(idx, entry);
    unitOf.set(entry, draft);
  }

  // What each controller refers to: a generator, a machine or a controller.
  const controllersByIdx = new Map<string, TopologyEntry[]>();
  for (const entry of controllers) {
    const idx = String(entry.idx);
    const list = controllersByIdx.get(idx);
    if (list) list.push(entry);
    else controllersByIdx.set(idx, [entry]);
  }
  const refersTo = (entry: TopologyEntry): TopologyEntry | null => {
    const syn = refOf(entry, 'syn');
    if (syn !== null) {
      const found = machineByIdx.get(syn) ?? staticByIdx.get(syn);
      if (found !== undefined) return found;
    }
    const gen = refOf(entry, 'gen');
    if (gen !== null) {
      const found = staticByIdx.get(gen) ?? machineByIdx.get(gen);
      if (found !== undefined) return found;
    }
    for (const { param, meant } of CHAIN_REFS) {
      const ref = refOf(entry, param);
      if (ref === null) continue;
      const named = (controllersByIdx.get(ref) ?? []).filter((other) => other !== entry);
      return (
        named.find((other) => meant(other.kind)) ??
        named.find((other) => subKindForControllerClass(other.kind) === 'other') ??
        null
      );
    }
    return null;
  };
  const parentOf = new Map<TopologyEntry, TopologyEntry | null>();
  for (const entry of controllers) parentOf.set(entry, refersTo(entry));

  // The unit a controller leads back to, through however many controllers.
  const unitOfController = (entry: TopologyEntry): Draft | null => {
    const seen = new Set<TopologyEntry>();
    let at: TopologyEntry | null | undefined = entry;
    while (at !== null && at !== undefined && !seen.has(at)) {
      const unit = unitOf.get(at);
      if (unit !== undefined) return unit;
      seen.add(at);
      at = parentOf.get(at);
    }
    return null;
  };
  const childrenOf = new Map<TopologyEntry, TopologyEntry[]>();
  const loose: TopologyEntry[] = [];
  for (const entry of controllers) {
    const parent = parentOf.get(entry) ?? null;
    if (parent === null || unitOfController(entry) === null) {
      loose.push(entry);
      continue;
    }
    const list = childrenOf.get(parent);
    if (list) list.push(entry);
    else childrenOf.set(parent, [entry]);
  }

  const roleOf = (entry: TopologyEntry): UnitRole => subKindForControllerClass(entry.kind);
  const units = drafts.map((draft): GeneratingUnit => {
    const members: UnitMember[] = [];
    const add = (entry: TopologyEntry, role: UnitRole, depth: number): void => {
      const idx = String(entry.idx);
      members.push({
        entry,
        kind: entry.kind,
        idx,
        role,
        nodeId: nodeIdOf(role, entry.kind, idx),
        depth,
      });
      const children = [...(childrenOf.get(entry) ?? [])].sort(
        (a, b) => ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)),
      );
      for (const child of children) add(child, roleOf(child), depth + 1);
    };
    if (draft.generator === null) {
      for (const machine of draft.machines) add(machine, 'machine', 0);
    } else {
      // The generator's own controllers (a converter) come after its machine.
      const own = childrenOf.get(draft.generator) ?? [];
      childrenOf.delete(draft.generator);
      add(draft.generator, 'generator', 0);
      for (const machine of draft.machines) add(machine, 'machine', 1);
      const ordered = [...own].sort(
        (a, b) => ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)),
      );
      for (const child of ordered) add(child, roleOf(child), 1);
    }
    return { idx: draft.idx, bus: draft.bus, members };
  });
  return { units, loose };
}

/** A member without its topology entry: what the diagram keeps of it on a node. */
export interface UnitMemberInfo extends Omit<UnitMember, 'entry'> {
  name: string;
}

export function unitMemberInfo(member: UnitMember): UnitMemberInfo {
  const { entry, ...rest } = member;
  return { ...rest, name: entry.name };
}

type MemberKey = Pick<UnitMember, 'kind' | 'idx' | 'role'>;

const isGenerator = (member: MemberKey): boolean =>
  member.role === 'generator' || member.role === 'machine';

/** What selects `member` in the Inspector. */
export function unitMemberSelection(member: MemberKey): SelectedElement {
  if (isGenerator(member)) {
    return { kind: 'generator', idx: member.idx, modelClass: member.kind };
  }
  return {
    kind: 'controller',
    subKind: member.role as ControllerSubKind,
    modelClass: member.kind,
    idx: member.idx,
  };
}

/**
 * The one of `members` that `selected` is, or `null` when it is none of them.
 * A generator picked without its model (an idx alone) is the first of that
 * idx the case lists, and the case lists the static generators first: so it
 * is the static generator where there is one of that idx, and a machine
 * otherwise.
 */
export function selectedUnitMember<M extends MemberKey>(
  members: readonly M[],
  selected: SelectedElement | null,
): M | null {
  if (selected === null) return null;
  if (selected.kind === 'controller') {
    return (
      members.find(
        (m) => !isGenerator(m) && m.kind === selected.modelClass && m.idx === selected.idx,
      ) ?? null
    );
  }
  if (selected.kind !== 'generator') return null;
  const ofIdx = members.filter((m) => isGenerator(m) && m.idx === selected.idx);
  if (selected.modelClass !== undefined) {
    const exact = ofIdx.find((m) => m.kind === selected.modelClass);
    if (exact !== undefined) return exact;
  }
  return ofIdx.find((m) => m.role === 'generator') ?? ofIdx[0] ?? null;
}

/** The unit `selected` is a model of, or `null` when it is of none. */
export function unitOfSelection(
  units: readonly GeneratingUnit[],
  selected: SelectedElement | null,
): GeneratingUnit | null {
  if (selected === null) return null;
  const candidates = units.filter((unit) => selectedUnitMember(unit.members, selected) !== null);
  if (candidates.length <= 1 || selected.kind !== 'generator') return candidates[0] ?? null;
  // Two units have a model of that idx (a generator here, a machine there):
  // the model that is meant decides, and without one the static generator.
  const wanted = (member: UnitMember): boolean =>
    selected.modelClass !== undefined
      ? member.kind === selected.modelClass
      : member.role === 'generator';
  return (
    candidates.find((unit) => {
      const member = selectedUnitMember(unit.members, selected);
      return member !== null && wanted(member);
    }) ??
    candidates[0] ??
    null
  );
}

/**
 * The generators and machines of the unit `selected` is one of: the static
 * generator and the machines that take its place in a time-domain run. To
 * the reader of the diagram they are one generator, so what the Inspector
 * shows of a generator beyond its own parameters (its variables in a run,
 * the disturbances that act on it) is read for all of them. Empty when the
 * selection is no generator, or is of no unit of `topology`.
 */
export function unitGenerators(
  topology: TopologySummary | null | undefined,
  selected: SelectedElement | null,
): UnitMember[] {
  if (!topology || selected === null || selected.kind !== 'generator') return [];
  const unit = unitOfSelection(generatingUnits(topology).units, selected);
  return unit === null ? [] : unit.members.filter(isGenerator);
}

/**
 * The few letters a model goes by on the symbol of its unit: what it is to
 * the unit (`SG` a machine, `AVR` an exciter, `GOV` a governor, `PSS` a
 * stabiliser), or for a converter and its controls the WECC name of the
 * stage (`REGC`, `REEC`, `REPC`). Any other model goes by the first letters
 * of its class.
 */
export function unitChipLabel(member: Pick<UnitMember, 'kind' | 'role'>): string {
  switch (member.role) {
    case 'generator':
      return 'GEN';
    case 'machine':
      return 'SG';
    case 'exciter':
      return 'AVR';
    case 'governor':
      return 'GOV';
    case 'pss':
      return 'PSS';
    default: {
      const stage = /^RE([GEP])C/.exec(member.kind);
      return stage ? `RE${stage[1]}C` : member.kind.slice(0, 4).toUpperCase();
    }
  }
}

/**
 * What a model is to its unit, in words (a tooltip, an accessible name): a
 * controller by the words the Inspector heads it with.
 */
export function unitRoleLabel(role: UnitRole): string {
  if (role === 'generator') return 'Generator';
  if (role === 'machine') return 'Machine';
  return controllerSubKindLabel(role);
}
