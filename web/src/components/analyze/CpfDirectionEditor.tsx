import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  EMPTY_CUSTOM_DIRECTION,
  parseIncrease,
  type CustomDirection,
  type DirectionGeneratorRow,
  type DirectionLoadRow,
  type IncreaseDraft,
} from '@/lib/cpfOptions';

/**
 * CpfDirectionEditor: the two tables of a custom CPF direction.
 *
 * One row per PQ load (MW and MVAr gained for one unit of lambda) and one per
 * PV generator (MW gained). A blank field is zero and a device left at zero
 * does not move, so a regional pattern is a handful of numbers. The base
 * values beside the fields are the solved power flow's, and "Fill with base
 * values" copies them in: that is the "Loads and generation" direction, to be
 * thinned out from there. The slack generator has no row: it supplies what the
 * rest leaves.
 *
 * Presentational: the drafts live in the parent form, which parses them when
 * the run is started (``parseCustomDirection``).
 *
 * Test hooks: ``cpf-direction-editor``, ``cpf-direction-fill``,
 * ``cpf-direction-clear``, ``cpf-direction-load-{idx}-p`` / ``-q`` and
 * ``cpf-direction-gen-{idx}-p``.
 */
export interface CpfDirectionEditorProps {
  loads: readonly DirectionLoadRow[];
  generators: readonly DirectionGeneratorRow[];
  value: CustomDirection;
  onChange: (next: CustomDirection) => void;
  className?: string;
}

const BLANK: IncreaseDraft = { p: '', q: '' };

function formatBase(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/** The drafts that make the custom direction the proportional one. */
// eslint-disable-next-line react-refresh/only-export-components
export function baseValueDirection(
  loads: readonly DirectionLoadRow[],
  generators: readonly DirectionGeneratorRow[],
): CustomDirection {
  const text = (value: number | null) => (value === null || value === 0 ? '' : String(value));
  return {
    loads: Object.fromEntries(loads.map((row) => [row.idx, { p: text(row.p), q: text(row.q) }])),
    generators: Object.fromEntries(generators.map((row) => [row.idx, { p: text(row.p), q: '' }])),
  };
}

export function CpfDirectionEditor({
  loads,
  generators,
  value,
  onChange,
  className,
}: CpfDirectionEditorProps) {
  const setLoad = (idx: string, patch: Partial<IncreaseDraft>) =>
    onChange({
      ...value,
      loads: { ...value.loads, [idx]: { ...(value.loads[idx] ?? BLANK), ...patch } },
    });
  const setGenerator = (idx: string, p: string) =>
    onChange({ ...value, generators: { ...value.generators, [idx]: { p, q: '' } } });

  const hasBase = loads.some((row) => row.p !== null) || generators.some((row) => row.p !== null);

  return (
    <div
      data-testid="cpf-direction-editor"
      className={cn('border-border/60 flex flex-col gap-2 rounded border p-2', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-[10px] leading-snug">
          What each device gains for one unit of λ. Blank is no change, and a negative number takes
          power off. The slack generator supplies whatever the rest leaves.
        </span>
        <span className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasBase}
            title="Copy each device's own power in: the same curve as Loads and generation, to edit from"
            onClick={() => onChange(baseValueDirection(loads, generators))}
            data-testid="cpf-direction-fill"
          >
            Fill with base values
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_CUSTOM_DIRECTION)}
            data-testid="cpf-direction-clear"
          >
            Clear
          </Button>
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] items-start gap-3">
        <IncreaseTable
          caption="Loads (PQ)"
          empty="The case has no PQ load."
          columns={['Load', 'Bus', 'Base MW', 'Base MVAr', '+ MW', '+ MVAr']}
        >
          {loads.map((row) => {
            const draft = value.loads[row.idx] ?? BLANK;
            return (
              <tr key={row.idx} className="border-border/40 border-t">
                <DeviceCell idx={row.idx} name={row.name} />
                <td className="px-1 py-0.5">{row.bus ?? '—'}</td>
                <NumberCell>{formatBase(row.p)}</NumberCell>
                <NumberCell>{formatBase(row.q)}</NumberCell>
                <IncreaseCell
                  testId={`cpf-direction-load-${row.idx}-p`}
                  label={`Active power added to load ${row.idx}, MW`}
                  value={draft.p}
                  onChange={(p) => setLoad(row.idx, { p })}
                />
                <IncreaseCell
                  testId={`cpf-direction-load-${row.idx}-q`}
                  label={`Reactive power added to load ${row.idx}, MVAr`}
                  value={draft.q}
                  onChange={(q) => setLoad(row.idx, { q })}
                />
              </tr>
            );
          })}
        </IncreaseTable>

        <IncreaseTable
          caption="Generators (PV)"
          empty="The case has no PV generator."
          columns={['Generator', 'Bus', 'Base MW', '+ MW']}
        >
          {generators.map((row) => (
            <tr key={row.idx} className="border-border/40 border-t">
              <DeviceCell idx={row.idx} name={row.name} />
              <td className="px-1 py-0.5">{row.bus ?? '—'}</td>
              <NumberCell>{formatBase(row.p)}</NumberCell>
              <IncreaseCell
                testId={`cpf-direction-gen-${row.idx}-p`}
                label={`Active power added to generator ${row.idx}, MW`}
                value={value.generators[row.idx]?.p ?? ''}
                onChange={(p) => setGenerator(row.idx, p)}
              />
            </tr>
          ))}
        </IncreaseTable>
      </div>
    </div>
  );
}

function IncreaseTable({
  caption,
  empty,
  columns,
  children,
}: {
  caption: string;
  empty: string;
  columns: readonly string[];
  children: React.ReactNode[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">{caption}</span>
      {children.length === 0 ? (
        <span className="text-muted-foreground text-[10px]">{empty}</span>
      ) : (
        <div className="border-border/60 max-h-48 overflow-y-auto rounded border">
          <table className="w-full border-collapse text-[11px]">
            {/* Opaque: the rows scroll under a header that stays put. */}
            <thead className="bg-muted text-muted-foreground sticky top-0">
              <tr>
                {columns.map((column, i) => (
                  <th
                    key={column}
                    scope="col"
                    className={cn('px-1 py-0.5 font-medium', i >= 2 ? 'text-right' : 'text-left')}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeviceCell({ idx, name }: { idx: string; name: string }) {
  return (
    <th scope="row" className="px-1 py-0.5 text-left font-normal">
      <span className="font-mono">{idx}</span>
      {name !== '' && name !== idx ? (
        <span className="text-muted-foreground ml-1">{name}</span>
      ) : null}
    </th>
  );
}

function NumberCell({ children }: { children: React.ReactNode }) {
  return (
    <td className="text-muted-foreground px-1 py-0.5 text-right font-mono tabular-nums">
      {children}
    </td>
  );
}

function IncreaseCell({
  testId,
  label,
  value,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const invalid = parseIncrease(value) === null;
  return (
    <td className="px-1 py-0.5 text-right">
      <input
        data-testid={testId}
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'bg-background border-border h-6 w-16 rounded border px-1 text-right font-mono text-[11px]',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          invalid ? 'border-danger' : '',
        )}
      />
    </td>
  );
}
