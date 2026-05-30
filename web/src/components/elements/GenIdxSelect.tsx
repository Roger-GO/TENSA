import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';

/**
 * GenIdxSelect — dropdown of existing STATIC generators (PV/Slack), used by
 * ElementForm for any param marked `kind: 'gen_idx'`. The only such param is
 * the dynamic machines' (GENROU/GENCLS) mandatory `gen` link, which references
 * the static generator the dynamic model replaces in power flow. Each option
 * is `"<kind>-<idx> — <name>"` so the user can pick by either handle.
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
  className?: string;
}

export function GenIdxSelect({
  value,
  onChange,
  required,
  id,
  className,
  'aria-describedby': ariaDescribedBy,
}: GenIdxSelectProps) {
  const topology = useCurrentTopology();
  const staticGens = (topology?.generators ?? []).filter(
    (g) => g.kind === 'PV' || g.kind === 'Slack',
  );
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
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      data-testid="gen-idx-select"
      className={cn(
        'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
        className,
      )}
    >
      <option value="" disabled>
        Pick a generator…
      </option>
      {staticGens.map((g) => {
        const idx = String(g.idx);
        return (
          <option key={idx} value={idx}>
            {g.kind}-{idx} — {g.name}
          </option>
        );
      })}
    </select>
  );
}
