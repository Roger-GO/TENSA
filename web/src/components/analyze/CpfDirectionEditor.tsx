import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  EMPTY_CUSTOM_DIRECTION,
  directionTotals,
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
 * How large the numbers should be is the first thing a new user asks, and the
 * answer is that it does not matter to the curve: lambda counts multiples of
 * them. The editor says so, and under the tables it adds up what is typed
 * beside what the case has (``cpf-direction-total``), so the scale of lambda
 * can be read before the run.
 *
 * Presentational: the drafts live in the parent form, which parses them when
 * the run is started (``parseCustomDirection``).
 *
 * Test hooks: ``cpf-direction-editor``, ``cpf-direction-fill``,
 * ``cpf-direction-clear``, ``cpf-direction-size-hint``,
 * ``cpf-direction-total``, ``cpf-direction-load-{idx}-p`` / ``-q`` and
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

/** A sum as typed numbers add up: no trailing zeros, no float noise. */
function formatSum(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** A change with its sign, so that an increase and a decrease read apart. */
function formatChange(value: number): string {
  return `${value > 0 ? '+' : ''}${formatSum(value)}`;
}

/**
 * What one unit of lambda is with the drafts as they stand, beside the base
 * case's own totals.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function directionTotalText(
  custom: CustomDirection,
  loads: readonly DirectionLoadRow[],
  generators: readonly DirectionGeneratorRow[],
): string {
  const totals = directionTotals(custom, loads, generators);
  if (totals.moved === 0) {
    return 'No increase is set yet: a run needs one on at least one load or generator.';
  }
  const parts: string[] = [];
  if (totals.loadP !== 0 || totals.loadQ !== 0) {
    const base =
      totals.baseLoadP === null
        ? ''
        : ` (base case: ${formatSum(totals.baseLoadP)} MW, ${formatSum(totals.baseLoadQ ?? 0)} MVAr)`;
    parts.push(
      `the loads by ${formatChange(totals.loadP)} MW and ${formatChange(totals.loadQ)} MVAr${base}`,
    );
  }
  if (totals.generatorP !== 0) {
    const base =
      totals.baseGeneratorP === null ? '' : ` (base case: ${formatSum(totals.baseGeneratorP)} MW)`;
    parts.push(`the PV generators by ${formatChange(totals.generatorP)} MW${base}`);
  }
  // Increases that cancel out across devices still move something.
  if (parts.length === 0)
    return 'One unit of λ moves power between devices and adds none in total.';
  return `One unit of λ changes ${parts.join(' and ')}.`;
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-muted-foreground flex min-w-0 flex-1 basis-80 flex-col gap-1 text-[10px] leading-snug">
          <span>
            What each device gains for one unit of λ. Blank is no change, and a negative number
            takes power off. The slack generator supplies whatever the rest leaves.
          </span>
          <span data-testid="cpf-direction-size-hint">
            Any size works: λ counts multiples of these numbers, so ten times the numbers is the
            same curve at a tenth of the λ. Small numbers make a long run, because one step moves λ
            by half a unit at most; a run that uses up its steps says so and offers more. Not sure
            where to start? Fill with base values is every device growing in proportion, to edit
            from.
          </span>
        </span>
        <span className="flex gap-1">
          <Button
            type="button"
            variant="outline"
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

      <span data-testid="cpf-direction-total" className="text-foreground text-[11px] leading-snug">
        {directionTotalText(value, loads, generators)}
      </span>
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
