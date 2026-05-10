/**
 * RunMenu — TopBar dropdown that picks the active routine for the
 * center Run button.
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
 */
import { useEffect, useState } from 'react';
import { TopBarMenu, TopBarMenuItem, TopBarMenuLabel } from './TopBarMenu';
import { SweepDialog } from '@/components/sweep/SweepDialog';
import { useRunModeStore } from '@/store/runMode';
import type { RunRoutine } from '@/lib/useRunReadiness';
import { useCommandRegistry, subscribePaletteDialog } from '@/lib/commands';

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
  const runCommands = commands.filter((c) => c.group === 'run');
  const activeRoutine = useRunModeStore((s) => s.activeRoutine);

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
        <TopBarMenuLabel>Active routine</TopBarMenuLabel>
        {orderedCommands.map((cmd, idx) => {
          const routine = routineFromId(cmd.id);
          const isActive = routine === activeRoutine;
          return (
            <TopBarMenuItem
              key={cmd.id}
              testId={`topbar-menu-run-${TESTID_SUFFIX_BY_ID[cmd.id] ?? routine}`}
              checked={isActive}
              onClick={cmd.action}
              data-routine-position={idx === 0 ? 'active' : 'alternative'}
            >
              {cmd.label}
            </TopBarMenuItem>
          );
        })}
      </TopBarMenu>
      <SweepDialog open={sweepOpen} onOpenChange={setSweepOpen} />
    </>
  );
}

function routineFromId(id: string): RunRoutine {
  // Registry ids are `run.<routine>`; strip the prefix.
  return id.replace(/^run\./, '') as RunRoutine;
}
