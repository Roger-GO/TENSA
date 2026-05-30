/**
 * Controller classification (v3.1 Unit 18).
 *
 * The substrate's ``TopologySummary.controllers`` bucket carries dynamic
 * control devices — exciters, governors, power-system stabilisers, renewable-
 * energy controllers, measurement devices, and time-series profiles — each
 * tagged only with its ANDES model-class name (e.g. ``EXST1``, ``IEEEG1``,
 * ``REECA1``). The inspector (Unit 18), the SLD glyph (Unit 19), and the
 * attached-controllers drill-down (Unit 20) each need a coarse *sub-kind* to
 * pick an icon and to scope per-kind accordion-state persistence, so this
 * module maps a model class onto one of a small set of categories.
 *
 * The mapping is deliberately frontend-side and **cosmetic**: ``subKind`` only
 * drives the glyph + the localStorage key for accordion open-state. It does
 * NOT affect which parameters render — those come from the entry's own
 * ``params`` dict keyed by the real ``entry.kind``. A misclassification is a
 * wrong icon, never a wrong value.
 *
 * ANDES groups every model authoritatively (``Exciter`` / ``TurbineGov`` /
 * ``PSS`` / ``RenGen`` / …). If the substrate ever exposes that group on the
 * topology entry, prefer it over this static table — the table only exists
 * because the topology wire shape carries ``kind`` (class name), not group.
 */

export type ControllerSubKind =
  | 'exciter'
  | 'governor'
  | 'pss'
  | 'renewable'
  | 'measurement'
  | 'profile'
  | 'other';

// Synchronous-machine AVR / exciter classes (ANDES ``Exciter`` group).
const EXCITER_CLASSES: ReadonlySet<string> = new Set([
  'IEEEX1',
  'IEEET1',
  'IEEET3',
  'EXDC2',
  'ESDC1A',
  'ESDC2A',
  'EXST1',
  'ESST1A',
  'ESST3A',
  'ESST4B',
  'ESAC1A',
  'ESAC4A',
  'EXAC1',
  'EXAC2',
  'EXAC4',
  'AC8B',
  'SEXS',
  'SEXSA',
]);

// Turbine-governor classes (ANDES ``TurbineGov`` group).
const GOVERNOR_CLASSES: ReadonlySet<string> = new Set([
  'TGOV1',
  'TGOV1N',
  'TGOV1DB',
  'IEEEG1',
  'IEEEG1DB',
  'IEESGO',
  'GAST',
  'GAST2A',
  'HYGOV',
  'HYGOVDB',
]);

// Power-system-stabiliser classes (ANDES ``PSS`` group).
const PSS_CLASSES: ReadonlySet<string> = new Set(['IEEEST', 'ST2CUT', 'STAB1']);

// Measurement / frequency devices (ANDES ``Measurement`` group + PMU).
const MEASUREMENT_CLASSES: ReadonlySet<string> = new Set([
  'BusFreq',
  'BusROCOF',
  'PMU',
  'FreqMeasurement',
  'Coupling',
]);

// Renewable controllers span several ANDES groups (RenGen / RenExciter /
// RenPlant / RenTorque / RenAerodynamics / RenPitch / RenGovernor) that share
// a stable ``RE*`` / ``WT*`` naming convention, plus the distributed-
// generation pair PVD1 / ESD1.
const RENEWABLE_PREFIX = /^(REG|REE|REP|REC|WT)/;
const RENEWABLE_EXACT: ReadonlySet<string> = new Set(['PVD1', 'ESD1']);

/**
 * Classify an ANDES controller model class into a coarse
 * {@link ControllerSubKind}. Unknown classes fall back to ``'other'``
 * (rendered with a generic glyph).
 */
export function subKindForControllerClass(modelClass: string): ControllerSubKind {
  if (modelClass === 'TimeSeries') return 'profile';
  if (EXCITER_CLASSES.has(modelClass)) return 'exciter';
  if (GOVERNOR_CLASSES.has(modelClass)) return 'governor';
  if (PSS_CLASSES.has(modelClass)) return 'pss';
  if (MEASUREMENT_CLASSES.has(modelClass)) return 'measurement';
  if (RENEWABLE_PREFIX.test(modelClass) || RENEWABLE_EXACT.has(modelClass)) {
    return 'renewable';
  }
  return 'other';
}

export interface ControllerSummary {
  total: number;
  bySubKind: Record<ControllerSubKind, number>;
}

/**
 * Count a topology's controllers by sub-kind. Drives the dynamic-content
 * badge (Unit 24) — derived client-side from the existing `controllers`
 * bucket rather than a dedicated substrate field.
 */
export function summarizeControllers(
  controllers: readonly { kind: string }[],
): ControllerSummary {
  const bySubKind: Record<ControllerSubKind, number> = {
    exciter: 0,
    governor: 0,
    pss: 0,
    renewable: 0,
    measurement: 0,
    profile: 0,
    other: 0,
  };
  for (const c of controllers) {
    bySubKind[subKindForControllerClass(c.kind)] += 1;
  }
  return { total: controllers.length, bySubKind };
}

/** Human-readable label for a sub-kind (header eyebrow, drill-down rows). */
export function controllerSubKindLabel(subKind: ControllerSubKind): string {
  switch (subKind) {
    case 'exciter':
      return 'Exciter';
    case 'governor':
      return 'Governor';
    case 'pss':
      return 'PSS';
    case 'renewable':
      return 'Renewable';
    case 'measurement':
      return 'Measurement';
    case 'profile':
      return 'Profile';
    case 'other':
      return 'Controller';
  }
}
