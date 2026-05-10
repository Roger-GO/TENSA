import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';

/**
 * BusIdxSelect — dropdown of existing buses, used by ElementForm for
 * any param marked `kind: 'bus_idx'`. Each option is rendered as
 * `"<idx> — <name>"` so the user can pick by either handle.
 *
 * Empty state: when the loaded system has no buses yet, renders a
 * disabled select + an "Add a Bus first" inline message. The
 * surrounding form's submit button is also disabled by the form itself
 * via the `required` flag.
 */
export interface BusIdxSelectProps {
  /** ANDES idx of the currently-chosen bus, or empty string. */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  id?: string;
  'aria-describedby'?: string;
  className?: string;
}

export function BusIdxSelect({
  value,
  onChange,
  required,
  id,
  className,
  'aria-describedby': ariaDescribedBy,
}: BusIdxSelectProps) {
  const topology = useCurrentTopology();
  const buses = topology?.buses ?? [];
  if (buses.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <select
          id={id}
          aria-describedby={ariaDescribedBy}
          disabled
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            'text-muted-foreground',
            className,
          )}
        >
          <option>—</option>
        </select>
        <p className="text-muted-foreground text-[10px]">Add a Bus first.</p>
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
      data-testid="bus-idx-select"
      className={cn(
        'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
        className,
      )}
    >
      <option value="" disabled>
        Pick a bus…
      </option>
      {buses.map((b) => {
        const idx = String(b.idx);
        return (
          <option key={idx} value={idx}>
            {idx} — {b.name}
          </option>
        );
      })}
    </select>
  );
}
