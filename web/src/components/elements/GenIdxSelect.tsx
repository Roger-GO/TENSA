import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';
import { staticGenerators, usedBy } from './genLink';

/**
 * GenIdxSelect — dropdown of existing STATIC generators (PV/Slack), used by
 * ElementForm for any param marked `kind: 'gen_idx'`: the mandatory `gen` link
 * of a dynamic machine (GENROU/GENCLS) or a battery (ESD1), which references
 * the static generator the dynamic model replaces when a time-domain run
 * starts. Each option is `"<kind>-<idx> — <name>"` so the user can pick by
 * either handle, followed by the bus the generator is on and the device that
 * already takes it over, `"(bus 2, used by GENROU_2)"`: the device being added
 * has to be on that bus, and a generator is not shared by default (`genLink`).
 *
 * Empty state: when the system has no static generators yet, renders a
 * disabled select + an "Add a PV or Slack generator first" hint (a dynamic
 * machine cannot exist without a static generator to attach to). Mirrors
 * BusIdxSelect.
 */
export interface GenIdxSelectProps {
  /** ANDES idx of the currently-chosen static generator, or empty string. */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  id?: string;
  'aria-describedby'?: string;
  /** The form refused the value: set once a submit found the field empty or unusable. */
  'aria-invalid'?: boolean;
  className?: string;
}

export function GenIdxSelect({
  value,
  onChange,
  required,
  id,
  className,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: GenIdxSelectProps) {
  const topology = useCurrentTopology();
  const staticGens = staticGenerators(topology);
  if (staticGens.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <select
          id={id}
          aria-describedby={ariaDescribedBy}
          disabled
          data-testid="gen-idx-select"
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            'text-muted-foreground',
            className,
          )}
        >
          <option>—</option>
        </select>
        <p className="text-muted-foreground text-[10px]">Add a PV or Slack generator first.</p>
      </div>
    );
  }
  return (
    <select
      id={id}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid ? true : undefined}
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      data-testid="gen-idx-select"
      className={cn(
        'bg-background h-7 max-w-full rounded border px-2 font-mono text-xs',
        ariaInvalid ? 'border-danger' : 'border-border',
        className,
      )}
    >
      <option value="" disabled>
        Pick a generator…
      </option>
      {staticGens.map((g) => {
        const where = [g.bus === null ? null : `bus ${g.bus}`, usedBy(g)]
          .filter((part) => part !== null)
          .join(', ');
        return (
          <option key={g.idx} value={g.idx}>
            {g.kind}-{g.idx} — {g.name}
            {where === '' ? '' : ` (${where})`}
          </option>
        );
      })}
    </select>
  );
}
