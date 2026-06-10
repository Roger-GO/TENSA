import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';

/**
 * SynIdxSelect — dropdown of existing SYNCHRONOUS MACHINES (GENROU/GENCLS),
 * used by ElementForm for any param marked `kind: 'syn_idx'`. The such params
 * are the exciter/governor `syn` link, which attaches a controller to the
 * dynamic machine it regulates. Each option is `"<kind>-<idx> — <name>"`.
 *
 * Empty state: when the system has no synchronous machines yet, renders a
 * disabled select + an "Add a GENROU/GENCLS machine first" hint (an
 * exciter/governor cannot exist without a machine to attach to). Mirrors
 * GenIdxSelect / BusIdxSelect.
 */
export interface SynIdxSelectProps {
  /** ANDES idx of the currently-chosen synchronous machine, or empty string. */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  id?: string;
  'aria-describedby'?: string;
  className?: string;
}

export function SynIdxSelect({
  value,
  onChange,
  required,
  id,
  className,
  'aria-describedby': ariaDescribedBy,
}: SynIdxSelectProps) {
  const topology = useCurrentTopology();
  const machines = (topology?.generators ?? []).filter(
    (g) => g.kind === 'GENROU' || g.kind === 'GENCLS',
  );
  if (machines.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <select
          id={id}
          aria-describedby={ariaDescribedBy}
          disabled
          data-testid="syn-idx-select"
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            'text-muted-foreground',
            className,
          )}
        >
          <option>—</option>
        </select>
        <p className="text-muted-foreground text-[10px]">Add a GENROU/GENCLS machine first.</p>
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
      data-testid="syn-idx-select"
      className={cn(
        'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
        className,
      )}
    >
      <option value="" disabled>
        Pick a machine…
      </option>
      {machines.map((g) => {
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
