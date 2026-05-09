import { cn } from '@/lib/cn';

/**
 * BoltedFaultWarning — surfaced under the ``xf`` field in ``FaultSpecForm``
 * when ``xf < 0.01`` (essentially a "bolted fault"). ANDES's fixed-step
 * Trapezoidal integrator empirically diverges on near-bolted faults under
 * stiffer scenarios (gen-bus faults on IEEE 39 / kundur_full / inverter
 * cases — see ``docs/spikes/2026-05-09-xf-default-empirical.md``).
 *
 * The component is purely advisory — it does NOT block submit. The user is
 * still allowed to commit a bolted fault (a knowledgeable researcher may
 * deliberately pick a low ``xf`` to study a specific contingency, or to
 * compare against published bolted-fault references). Once adaptive TDS
 * lands (planned: Unit 16), the divergence regime shrinks substantially and
 * this banner can be relaxed.
 *
 * Threshold rationale: 0.01 is the smallest value that converges across
 * IEEE 14, IEEE 39, and kundur_full under the gen-bus + tc-tf=0.2 s stress
 * scenario. Anything below this reliably diverges on at least one of the
 * three classical cases. Inverter-rich systems need ``xf >= 0.1`` even
 * above the threshold — that case is also covered by this warning's copy.
 */

export interface BoltedFaultWarningProps {
  /** Current xf value from the FaultSpec form. May be NaN if the user has
   * cleared the field; we treat NaN as "no warning" (the field is invalid
   * and the form's own field-level error already covers it). */
  xf: number;
  className?: string;
}

/** Warning threshold. Values strictly below this get the advisory. */
export const BOLTED_FAULT_XF_THRESHOLD = 0.01;

export function BoltedFaultWarning({ xf, className }: BoltedFaultWarningProps) {
  // NaN guard: if xf is not a finite number the FaultSpecForm itself shows a
  // field-level "Enter a finite number" error; no need to also show this
  // banner. (NaN < 0.01 is false in JS so this is mostly defensive.)
  if (!Number.isFinite(xf)) return null;
  if (xf >= BOLTED_FAULT_XF_THRESHOLD) return null;

  return (
    <div
      role="alert"
      data-testid="bolted-fault-warning"
      className={cn(
        'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        'flex flex-col gap-1 rounded border px-2 py-1.5 text-[11px] leading-snug',
        className,
      )}
    >
      <span className="font-medium">Bolted fault — numerical instability risk</span>
      <span>
        Bolted faults often diverge with fixed-step integration. If you hit
        numerical instability, either set xf &ge; 0.01 or enable adaptive TDS
        (planned: Unit 16).
      </span>
    </div>
  );
}
