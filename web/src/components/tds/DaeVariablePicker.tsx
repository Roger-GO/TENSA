import { useEffect, useState } from 'react';
import { isWaitingForSession, useDaeVariables } from '@/api/queries';
import type { DaeVariableInfo } from '@/api/types';
import { MAX_TDS_DAE_VARS, useUiStore } from '@/store/ui';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * DaeVariablePicker: choose ANDES variables to record in the next run, beside
 * the variable groups. Any state or algebraic variable the loaded models define
 * can be picked by the name ANDES gives it (``omega GENROU 1``, ``vf GENROU 2``,
 * ``v EXST1 1``); each becomes a column of the run, and the run's plot lists it
 * under "ANDES variables".
 *
 * The list comes from the substrate (``GET /sessions/{id}/dae-variables``), which
 * reads the models' own definitions: it needs no run, and asking does not close
 * the case to disturbances. It is searched by words in the name, a page at a
 * time (a large case has tens of thousands of variables), so the user types
 * ``omega gen`` and ticks the ones wanted, or adds everything that matched.
 *
 * The picks live in ``useUiStore.tdsConfig.daeVars``, which ``RunButton`` sends
 * with the run. They are names of this case's devices, so the case-change
 * cascade empties them.
 */

/** How many matches the list shows; the rest are reached by narrowing the search. */
export const DAE_PICKER_PAGE_SIZE = 50;

/** How long after the last keystroke the search is sent. */
const SEARCH_DEBOUNCE_MS = 250;

/** What ANDES says about a variable, for the hover text of its row. */
function describe(variable: DaeVariableInfo): string {
  const kind = variable.kind === 'x' ? 'State variable' : 'Algebraic variable';
  const detail = [variable.info, variable.unit ? `in ${variable.unit}` : null]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');
  return detail.length > 0 ? `${kind}: ${detail}` : kind;
}

export function DaeVariablePicker({ className }: { className?: string }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const hasCase = useCaseStore((s) => s.selection !== null);
  const picked = useUiStore((s) => s.tdsConfig.daeVars);
  const setTdsConfig = useUiStore((s) => s.setTdsConfig);

  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setSearch(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);

  const usable = sessionId !== null && hasCase;
  const room = MAX_TDS_DAE_VARS - picked.length;

  const toggle = (name: string) => {
    if (picked.includes(name)) {
      setTdsConfig({ daeVars: picked.filter((n) => n !== name) });
    } else if (room > 0) {
      setTdsConfig({ daeVars: [...picked, name] });
    }
  };

  return (
    <fieldset
      data-testid="tds-config-dae-vars"
      className={cn('flex flex-col gap-1.5', className)}
      aria-describedby="tds-config-dae-vars-hint"
    >
      <legend className="text-muted-foreground text-xs font-medium">
        ANDES variables to record (optional)
      </legend>
      <p id="tds-config-dae-vars-hint" className="text-muted-foreground text-[10px] leading-snug">
        Any state or algebraic variable of the models, named as ANDES names it (for example{' '}
        <code className="font-mono">omega GENROU 1</code> or{' '}
        <code className="font-mono">vf GENROU 2</code>), recorded beside the groups above. Fixed at
        run-start; the plot lists them under ANDES variables.
      </p>

      {picked.length > 0 ? (
        <div data-testid="tds-config-dae-picked" className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground text-xs" data-testid="tds-config-dae-count">
              {picked.length} selected
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="tds-config-dae-clear"
              onClick={() => setTdsConfig({ daeVars: [] })}
            >
              Clear
            </Button>
          </div>
          <ul className="flex max-h-20 flex-wrap gap-1 overflow-auto">
            {picked.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  data-testid={`tds-config-dae-chip-${name}`}
                  onClick={() => toggle(name)}
                  className={cn(
                    'border-border bg-muted/50 hover:bg-muted rounded-full border px-2 py-0.5',
                    'font-mono text-[10px]',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  )}
                >
                  {name} <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <input
        type="search"
        value={text}
        disabled={!usable}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search, e.g. omega genrou"
        aria-label="Search ANDES variables"
        data-testid="tds-config-dae-search"
        className={cn(
          'bg-background border-border h-7 rounded border px-2 text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:opacity-60',
        )}
      />

      {usable ? (
        <DaeVariableResults search={search} picked={picked} toggle={toggle} />
      ) : (
        <p data-testid="tds-config-dae-status" className="text-muted-foreground text-[10px]">
          Load a case to list its ANDES variables.
        </p>
      )}
      {room <= 0 ? (
        <span role="alert" className="text-danger text-[10px]">
          A run records at most {MAX_TDS_DAE_VARS} ANDES variables.
        </span>
      ) : null}
    </fieldset>
  );
}

/**
 * The matches of ``search``, a page of them, with a checkbox each and a button to
 * add what is shown. A separate component so the substrate is only asked while a
 * session and a case exist to ask about.
 */
function DaeVariableResults({
  search,
  picked,
  toggle,
}: {
  search: string;
  picked: readonly string[];
  toggle: (name: string) => void;
}) {
  const setTdsConfig = useUiStore((s) => s.setTdsConfig);
  const list = useDaeVariables(search, DAE_PICKER_PAGE_SIZE);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pickedSet = new Set(picked);
  const room = MAX_TDS_DAE_VARS - picked.length;
  const remaining = items.filter((v) => !pickedSet.has(v.name)).length;

  const addShown = () => {
    const fresh = items.map((v) => v.name).filter((name) => !pickedSet.has(name));
    setTdsConfig({ daeVars: [...picked, ...fresh.slice(0, Math.max(0, room))] });
  };

  let status: string | null = null;
  // First, since the list is asked for again for as long as a run refuses it:
  // the query is loading all that time, and this is what there is to say.
  if (isWaitingForSession(list)) {
    status = 'The session is busy with a run. The list is back when the run ends.';
  } else if (list.isError) status = `Could not list the variables: ${list.error.message}`;
  else if (list.isPending) status = 'Loading variables…';
  else if (items.length === 0) status = 'No variable matches.';

  if (status !== null) {
    return (
      <p data-testid="tds-config-dae-status" className="text-muted-foreground text-[10px]">
        {status}
      </p>
    );
  }
  return (
    <>
      <ul
        aria-label="ANDES variables"
        data-testid="tds-config-dae-results"
        className="border-border flex max-h-40 flex-col overflow-auto rounded border"
      >
        {items.map((variable) => {
          const id = `tds-config-dae-${variable.name}`;
          return (
            <li key={variable.name}>
              <label
                htmlFor={id}
                title={describe(variable)}
                className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 px-2 py-0.5"
              >
                <input
                  id={id}
                  type="checkbox"
                  data-testid={id}
                  checked={pickedSet.has(variable.name)}
                  onChange={() => toggle(variable.name)}
                  className="border-border h-3.5 w-3.5 rounded border"
                />
                <span className="text-foreground font-mono text-xs">{variable.name}</span>
                <span className="text-muted-foreground ml-auto text-[10px]">
                  {variable.kind === 'x' ? 'state' : 'algebraic'}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span data-testid="tds-config-dae-shown" className="text-muted-foreground text-[10px]">
          {total > items.length
            ? `Showing ${items.length} of ${total}. Narrow the search for the rest.`
            : `${total} ${total === 1 ? 'match' : 'matches'}`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={remaining === 0 || room <= 0}
          data-testid="tds-config-dae-add-shown"
          onClick={addShown}
        >
          {total > items.length ? `Add the ${remaining} shown` : `Add all ${remaining}`}
        </Button>
      </div>
    </>
  );
}
