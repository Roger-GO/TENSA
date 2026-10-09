/**
 * RunMenu — TopBar dropdown that starts a routine.
 *
 * An entry that says Run runs: it selects the routine and starts it, by the
 * check and the handler of that routine's own Run button (`runRoutine` in the
 * command registry). One that cannot run yet says why in a notice. The two
 * entries that end in an ellipsis (the parameter sweep, the QV curve of a
 * bus) need something picked first and open the place where that is done.
 *
 * Unit 9 of the v2.0 polish plan refactored this file to derive its
 * items from the shared command registry (`useCommandRegistry()`).
 * Each `run.*` command in the registry maps to one routine entry.
 *
 * UX preserved from Unit 8:
 *
 * - The active routine appears at the top of the list with a
 *   leading checkmark glyph (rendered via `<TopBarMenuItem checked />`).
 * - Selecting EIG / CPF / SE flips the right-dock to the Analyze
 *   panel + sets the corresponding sub-mode. That side-effect lives
 *   in the registry's `action` closure; the menu just calls it.
 * - Selecting Sweep opens the SweepDialog (whose open state is local
 *   to this component); the registry posts to the palette-dialog
 *   bridge and the subscription below toggles the dialog.
 *
 * Under the routines, Run history opens the History drawer on its runs. The
 * top bar's own History button is in the More menu on all but the widest
 * windows, and the Run menu is where someone looks for a run they made.
 */
import { useEffect, useState } from 'react';
import { TopBarMenu, TopBarMenuItem, TopBarMenuLabel, TopBarMenuSeparator } from './TopBarMenu';
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import { useRunModeStore } from '@/store/runMode';
import type { RunRoutine } from '@/lib/useRunReadiness';
import { useCommandRegistry, subscribePaletteDialog } from '@/lib/commands';
import {
  NO_RUNS_YET,
  RUN_HISTORY_HINT,
  openRunHistory,
  runHistoryLabel,
  useRunHistory,
} from '@/lib/runHistory';

// The sweep dialog is its own chunk, fetched the first time it opens.
const SweepDialog = lazyNamed(
  () => import('@/components/sweep/SweepDialog'),
  'SweepDialog',
  'overlay',
);

const TESTID_SUFFIX_BY_ID: Record<string, string> = {
  'run.pflow': 'pflow',
  'run.tds': 'tds',
  'run.eig': 'eig',
  'run.cpf': 'cpf',
  'run.se': 'se',
  'run.sweep': 'sweep',
};

export function RunMenu() {
  const commands = useCommandRegistry();
  // Abort run (Esc) is a run command but not a routine to pick.
  const runCommands = commands.filter((c) => c.group === 'run' && c.id !== 'run.abort');
  const activeRoutine = useRunModeStore((s) => s.activeRoutine);
  const history = useRunHistory();

  const [sweepOpen, setSweepOpen] = useState(false);

  useEffect(() => {
    return subscribePaletteDialog((key) => {
      if (key === 'sweep') setSweepOpen(true);
    });
  }, []);

  // Re-order so the active routine appears first (matching the Unit-8
  // visual). The registry returns commands in declared order; we
  // sort here without mutating the source array.
  const orderedCommands = [
    ...runCommands.filter((c) => routineFromId(c.id) === activeRoutine),
    ...runCommands.filter((c) => routineFromId(c.id) !== activeRoutine),
  ];

  return (
    <>
      <TopBarMenu label="Run" testId="topbar-menu-run">
        <TopBarMenuLabel>Run now</TopBarMenuLabel>
        {orderedCommands.map((cmd, idx) => {
          const routine = routineFromId(cmd.id);
          const isActive = routine === activeRoutine;
          return (
            <TopBarMenuItem
              key={cmd.id}
              testId={`topbar-menu-run-${TESTID_SUFFIX_BY_ID[cmd.id] ?? routine}`}
              checked={isActive}
              title={
                isActive
                  ? `${cmd.description ?? ''} Ticked: the routine chosen last, which ${RUN_AGAIN_KEYS} runs again.`
                  : cmd.description
              }
              onClick={cmd.action}
              data-routine-position={idx === 0 ? 'active' : 'alternative'}
            >
              {cmd.label}
            </TopBarMenuItem>
          );
        })}
        <TopBarMenuSeparator />
        <TopBarMenuItem
          testId="topbar-menu-run-history"
          title={RUN_HISTORY_HINT}
          unavailableReason={history.available ? undefined : NO_RUNS_YET}
          onClick={openRunHistory}
        >
          {runHistoryLabel(history.runCount)}
        </TopBarMenuItem>
      </TopBarMenu>
      <LazyMount when={sweepOpen} onLoadFailed={() => setSweepOpen(false)}>
        <SweepDialog open={sweepOpen} onOpenChange={setSweepOpen} />
      </LazyMount>
    </>
  );
}

/** The keys of "Run again", as the shortcut list writes them. */
const RUN_AGAIN_KEYS = 'Ctrl+Enter (Cmd+Enter on a Mac)';

function routineFromId(id: string): RunRoutine {
  // Registry ids are `run.<routine>`; strip the prefix.
  return id.replace(/^run\./, '') as RunRoutine;
}
