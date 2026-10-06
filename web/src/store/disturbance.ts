/**
 * Disturbance editor slice (Unit 6 of the v0.2 plan).
 *
 * Holds the local list of disturbances the user is composing in the
 * timeline editor. The shape mirrors the substrate's
 * ``FaultSpec | ToggleSpec | AlterSpec`` discriminated union — see
 * ``server/src/tensa/core/disturbance.py``. The discriminator is
 * ``kind`` (NOT ``type``), and the field names match the substrate
 * (``bus_idx`` / ``tf`` / ``tc`` for faults; ``dev_idx`` for toggle and
 * alter). The pseudo-code in the plan's prose uses different field names
 * — this slice follows the canonical Pydantic contract.
 *
 * Lifecycle:
 *
 * - Each disturbance carries a client-generated ``id`` (UUID v4 from the
 *   ``uuid`` package added in Unit 2). The id stays stable across edits
 *   so React-list keys and timeline-marker refs survive a spec mutation.
 *   The substrate assigns its own idx on commit; the client id is purely
 *   a UI handle.
 * - ``dirty`` is true whenever the local list has unsynced changes
 *   relative to whatever the substrate last accepted. It flips to true on
 *   every add/update/remove, and back to false on ``markCommitted``.
 *   ``clearDisturbances`` is the "clean slate" path — it resets to empty
 *   AND clears ``dirty`` because there's nothing to commit anymore.
 * - ``committed`` tracks whether the current list (or the most recently
 *   committed prior shape) has been pushed to the substrate. It's true
 *   immediately after a successful commit; the next add/update/remove
 *   flips it back to false (because the local list has diverged again).
 *
 * - Deleting an element takes the disturbances that act on it off the list
 *   (``removeWith``): committed, they would name a device that is gone, and
 *   the run would fail on it. They are remembered by the element deleted, so
 *   undoing the delete puts them back (``restoreWith``) and redoing it takes
 *   them off again (``removeAgainWith``), with any put on the list in between
 *   that act on what the delete takes.
 *
 * NO commit happens in this slice. Unit 7 wires the actual
 * ``POST /sessions/{id}/disturbances`` call when "Run TDS" fires; this
 * slice exposes ``markCommitted`` so Unit 7 can report success back.
 *
 * Sorting + ties: the timeline + the panel list both display
 * disturbances in time order. Sort key is ``spec.t`` (or ``spec.tf`` for
 * faults — Fault's "start" field is ``tf``, the wire field
 * "fault-applied time"). Ties (e.g., two disturbances at t=1.0) are
 * broken by insertion order, mirroring how ANDES processes
 * simultaneously-scheduled events. We expose insertion order via the
 * ``disturbances`` array itself; any sorted view is derived in the
 * components (``sortedDisturbances`` selector below).
 */
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec } from '@/api/types';

/**
 * One disturbance in the local editor. The ``id`` is a client-generated
 * UUID (via ``uuid`` v4); the ``spec`` is the substrate-shape payload.
 */
export interface DisturbanceLocal {
  /** Client-generated UUID v4. Stable across spec edits. */
  id: string;
  /** Substrate-shape disturbance spec (FaultSpec | ToggleSpec | AlterSpec). */
  spec: DisturbanceSpec;
}

/** Default values for a freshly-created Fault row.
 *
 * ``xf`` default is 0.05 — empirically validated by the Unit 5 sweep (see
 * ``docs/spikes/2026-05-09-xf-default-empirical.md``). The prior 0.0001
 * (essentially a bolted fault) diverges under fixed-step Trapezoidal on
 * stiffer scenarios (IEEE 39 gen-bus, kundur_full gen-bus, REGCP1 inverter
 * case). 0.05 is the smallest value that converges across IEEE 14, IEEE 39,
 * and kundur_full under both gentle and gen-bus stress, *and* sits above the
 * ``BoltedFaultWarning`` threshold (0.01) so the default UX is warning-free.
 * Inverter-rich systems may need ``xf >= 0.1`` — those users get the warning.
 */
export function blankFaultSpec(): FaultSpec {
  return {
    kind: 'fault',
    bus_idx: '',
    tf: 1.0,
    tc: 1.1,
    xf: 0.05,
    rf: 0.0,
  };
}

/** Default values for a freshly-created Toggle row. */
export function blankToggleSpec(): ToggleSpec {
  return {
    kind: 'toggle',
    model: 'Line',
    dev_idx: '',
    t: 1.0,
  };
}

/** Default values for a freshly-created Alter row.
 *
 * ANDES's ``Alter`` model has no ``value`` parameter — the new value is
 * ``v_new = v_current <method> amount``. ``method`` defaults to ``'='``
 * (absolute set) so a fresh row reads as "set to amount"; ``amount``
 * defaults to 0.0. See ``server/src/tensa/core/disturbance.py``.
 */
export function blankAlterSpec(): AlterSpec {
  return {
    kind: 'alter',
    model: 'PQ',
    dev_idx: '',
    src: '',
    t: 1.0,
    method: '=',
    amount: 0.0,
  };
}

/**
 * Human-readable verb for each Alter ``method``, used in summary text.
 * Mirrors the operand semantics: ``'='`` is an absolute set; the rest
 * combine ``amount`` with the parameter's current value.
 */
const ALTER_METHOD_VERB: Record<AlterSpec['method'], string> = {
  '=': 'set to',
  '+': 'increase by',
  '-': 'decrease by',
  '*': 'scale by',
  '/': 'divide by',
};

/**
 * Returns the time at which the disturbance fires for sort + display.
 * Faults use ``tf`` (the substrate field for "fault-applied time");
 * Toggle and Alter both use ``t``.
 */
export function disturbanceTime(spec: DisturbanceSpec): number {
  if (spec.kind === 'fault') return spec.tf;
  return spec.t;
}

/**
 * Short human-readable summary of a disturbance, used in the panel list
 * row and tooltip text. Examples:
 *
 *   "Fault on Bus 5 at t=1.000s"
 *   "Toggle Line 7 at t=2.500s"
 *   "Alter PQ.4 Ppf increase by 0.2 at t=3.000s"
 */
export function disturbanceSummary(spec: DisturbanceSpec): string {
  if (spec.kind === 'fault') {
    const bus = String(spec.bus_idx).length === 0 ? '?' : String(spec.bus_idx);
    return `Fault on Bus ${bus} at t=${spec.tf.toFixed(3)}s`;
  }
  if (spec.kind === 'toggle') {
    const dev = String(spec.dev_idx).length === 0 ? '?' : String(spec.dev_idx);
    return `Toggle ${spec.model} ${dev} at t=${spec.t.toFixed(3)}s`;
  }
  const dev = String(spec.dev_idx).length === 0 ? '?' : String(spec.dev_idx);
  const src = spec.src.length === 0 ? '?' : spec.src;
  const verb = ALTER_METHOD_VERB[spec.method];
  return `Alter ${spec.model}.${dev} ${src} ${verb} ${spec.amount} at t=${spec.t.toFixed(3)}s`;
}

/** A device as a delete names it: its ANDES model and its idx. */
export interface DeviceRef {
  model: string;
  idx: string | number;
}

/** Whether a disturbance acts on ``device``: a fault on that bus, a toggle or an alter of that device. */
export function actsOn(spec: DisturbanceSpec, device: DeviceRef): boolean {
  if (spec.kind === 'fault') {
    return device.model === 'Bus' && String(spec.bus_idx) === String(device.idx);
  }
  return spec.model === device.model && String(spec.dev_idx) === String(device.idx);
}

/** The disturbances of ``list`` that act on one of ``devices``, in list order. */
export function disturbancesActingOn(
  list: readonly DisturbanceLocal[],
  devices: readonly DeviceRef[],
): DisturbanceLocal[] {
  return list.filter((d) => devices.some((device) => actsOn(d.spec, device)));
}

/** The key ``removeWith`` and its two counterparts remember a deleted element by. */
export function deletedElementKey(model: string, idx: string | number): string {
  return `${model} ${String(idx)}`;
}

export interface DisturbanceState {
  /** Current local disturbance list, in insertion order. */
  disturbances: DisturbanceLocal[];
  /**
   * The disturbances a delete took off the list, by the element deleted
   * (``deletedElementKey``), each with the place it had in the list.
   */
  removedWith: Record<string, { index: number; disturbance: DisturbanceLocal }[]>;
  /** True when the local list has changes not yet committed to the substrate. */
  dirty: boolean;
  /** True when the current list (or a superset thereof) was committed. */
  committed: boolean;

  /**
   * Append a new disturbance (with a freshly-generated id). The newly-
   * added disturbance is appended; sorting for display is the consumer's
   * responsibility.
   */
  addDisturbance: (spec: DisturbanceSpec) => DisturbanceLocal;

  /**
   * Replace an existing disturbance's spec by id. Preserves the id; if
   * the id is unknown, no-op (defensive — protects against late-arriving
   * dialog saves after a delete).
   */
  updateDisturbance: (id: string, spec: DisturbanceSpec) => void;

  /** Drop one disturbance by id. */
  removeDisturbance: (id: string) => void;

  /** Drop everything. Resets dirty AND committed (clean slate). */
  clearDisturbances: () => void;

  /**
   * Take the disturbances with these ``ids`` off the list because the element
   * ``key`` names was deleted, and remember them under it, in place of what an
   * earlier delete of that element was remembered to have taken.
   */
  removeWith: (key: string, ids: readonly string[]) => void;

  /**
   * Put back what ``removeWith`` took off for ``key`` (the delete was undone).
   * Returns how many came back. They stay remembered, for a redo.
   */
  restoreWith: (key: string) => number;

  /**
   * Take off again what ``restoreWith`` put back for ``key`` (the delete was
   * redone), and with them the disturbances with the ids in ``also``: the ones
   * put on the list since the undo that act on what the delete takes. What
   * goes is what is remembered from then on, so the next undo puts back those
   * and no other. Returns how many went.
   */
  removeAgainWith: (key: string, also?: readonly string[]) => number;

  /** Mark the current list as committed (called from Unit 7 on commit success). */
  markCommitted: () => void;

  /**
   * Force the dirty flag. Used by Unit 7 if a commit fails partway
   * through and the local list needs to be flagged dirty again so the UI
   * doesn't show "all synced".
   */
  markDirty: () => void;
}

/**
 * Indirection over ``uuid.v4()`` so tests can assert on deterministic
 * ids without ``vi.mock``-ing the entire ``uuid`` module (which would
 * affect every other slice that reads it). Default delegates to
 * ``uuid.v4``.
 */
let uuidFactory: () => string = () => uuidv4();

function generateId(): string {
  return uuidFactory();
}

/**
 * Test-only helper: override the UUID factory so test cases can assert on
 * deterministic ids. Pass ``null`` to restore real UUID generation.
 */
export function __setUuidFactoryForTests(fn: (() => string) | null): void {
  uuidFactory = fn ?? (() => uuidv4());
}

export const useDisturbanceStore = create<DisturbanceState>((set, get) => ({
  disturbances: [],
  removedWith: {},
  dirty: false,
  committed: false,

  addDisturbance: (spec) => {
    const next: DisturbanceLocal = { id: generateId(), spec };
    set({
      disturbances: [...get().disturbances, next],
      dirty: true,
      committed: false,
    });
    return next;
  },

  updateDisturbance: (id, spec) => {
    const list = get().disturbances;
    let found = false;
    const updated = list.map((d) => {
      if (d.id !== id) return d;
      found = true;
      return { ...d, spec };
    });
    if (!found) return;
    set({
      disturbances: updated,
      dirty: true,
      committed: false,
    });
  },

  removeDisturbance: (id) => {
    const list = get().disturbances;
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return;
    set({
      disturbances: next,
      dirty: true,
      committed: false,
    });
  },

  clearDisturbances: () => {
    set({ disturbances: [], removedWith: {}, dirty: false, committed: false });
  },

  removeWith: (key, ids) => {
    const list = get().disturbances;
    const wanted = new Set(ids);
    const removed = list
      .map((disturbance, index) => ({ index, disturbance }))
      .filter(({ disturbance }) => wanted.has(disturbance.id));
    if (removed.length === 0) {
      // What an earlier delete of the same element took is not this one's to
      // put back: the list has held the element again since, without them.
      if (key in get().removedWith) {
        const { [key]: _earlier, ...others } = get().removedWith;
        set({ removedWith: others });
      }
      return;
    }
    set({
      disturbances: list.filter((d) => !wanted.has(d.id)),
      removedWith: { ...get().removedWith, [key]: removed },
      dirty: true,
      committed: false,
    });
  },

  restoreWith: (key) => {
    const remembered = get().removedWith[key];
    if (remembered === undefined) return 0;
    const next = [...get().disturbances];
    const present = new Set(next.map((d) => d.id));
    let restored = 0;
    // Lowest place first, so each lands where it stood among the ones before it.
    for (const { index, disturbance } of [...remembered].sort((a, b) => a.index - b.index)) {
      if (present.has(disturbance.id)) continue;
      next.splice(Math.min(index, next.length), 0, disturbance);
      restored += 1;
    }
    if (restored > 0) set({ disturbances: next, dirty: true, committed: false });
    return restored;
  },

  removeAgainWith: (key, also = []) => {
    const remembered = (get().removedWith[key] ?? []).map((r) => r.disturbance.id);
    const before = get().disturbances.length;
    // Remembered afresh, as the list stands now: one of them taken off by hand
    // since the undo is not the next undo's to put back.
    get().removeWith(key, [...remembered, ...also]);
    return before - get().disturbances.length;
  },

  markCommitted: () => {
    set({ dirty: false, committed: true });
  },

  markDirty: () => {
    set({ dirty: true });
  },
}));

/**
 * Sort disturbances by (time ascending, insertion order). Pure helper —
 * the store's array is in insertion order; consumers that want display
 * order call this. Two disturbances at the exact same ``t`` keep their
 * insertion-order ordering, mirroring ANDES's tie-break behavior.
 */
export function sortedDisturbances(list: DisturbanceLocal[]): DisturbanceLocal[] {
  // Tag with original index, sort stably by time, then drop the tag.
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const ta = disturbanceTime(a.d.spec);
      const tb = disturbanceTime(b.d.spec);
      if (ta === tb) return a.i - b.i;
      return ta - tb;
    })
    .map(({ d }) => d);
}
