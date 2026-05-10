/**
 * RunMenu — TopBar dropdown that picks the active routine for the
 * center Run button (Unit 8 of the v2.0 polish plan).
 *
 * The active routine is tracked in ``useRunModeStore`` (a tiny slice
 * created for this unit). Selecting an item:
 *
 * - PFlow / TDS — sets ``activeRoutine``. The existing center
 *   ``<RunButton />`` keeps its own internal PF/TDS toggle (added in
 *   v0.2 Unit 9) so the actual click target follows the routine choice
 *   for those two modes.
 * - EIG / CPF / SE — sets ``activeRoutine`` AND swaps the right-dock
 *   top region to the Analyze panel + flips its sub-mode. This is the
 *   one place these routines have a UI home today; clicking the menu
 *   item is the most direct path to "I want to run EIG".
 * - Sweep — sets ``activeRoutine`` AND opens the SweepDialog (which
 *   manages its own start flow). The dialog is mounted here so the
 *   open/close state stays local; this matches the pre-Unit-8 wiring
 *   in ``TopBar``.
 *
 * Items appear in a stable order (PFlow first by convention so a fresh
 * session lands on the most-common routine). The active item shows a
 * leading checkmark via ``checked``; the menu's docstring on
 * ``TopBarMenuItem`` covers the visual.
 */
import { useState } from 'react';
import { TopBarMenu, TopBarMenuItem, TopBarMenuLabel } from './TopBarMenu';
import { SweepDialog } from '@/components/sweep/SweepDialog';
import { useRunModeStore } from '@/store/runMode';
import { useAnalyzeStore } from '@/store/analyze';
import { useUiStore } from '@/store/ui';
import type { RunRoutine } from '@/lib/useRunReadiness';

interface RoutineEntry {
  id: RunRoutine;
  label: string;
  testIdSuffix: string;
}

const ROUTINES: readonly RoutineEntry[] = [
  { id: 'pflow', label: 'PFlow', testIdSuffix: 'pflow' },
  { id: 'tds', label: 'TDS', testIdSuffix: 'tds' },
  { id: 'eig', label: 'EIG', testIdSuffix: 'eig' },
  { id: 'cpf', label: 'CPF', testIdSuffix: 'cpf' },
  { id: 'se', label: 'SE', testIdSuffix: 'se' },
  { id: 'sweep', label: 'Sweep', testIdSuffix: 'sweep' },
];

/**
 * Map a Run routine to the Analyze sub-mode that hosts its result
 * view. Routines without an Analyze home (PFlow, TDS, Sweep) return
 * null and the menu item skips the right-dock swap.
 */
function analyzeSubModeFor(routine: RunRoutine): 'eig' | 'cpf' | 'se' | null {
  if (routine === 'eig') return 'eig';
  if (routine === 'cpf') return 'cpf';
  if (routine === 'se') return 'se';
  return null;
}

export function RunMenu() {
  const activeRoutine = useRunModeStore((s) => s.activeRoutine);
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  const setAnalyzeSubMode = useAnalyzeStore((s) => s.setSubMode);
  const setRightDockPanel = useUiStore((s) => s.setActiveRightDockTopPanel);

  const [sweepOpen, setSweepOpen] = useState(false);

  const handleSelect = (routine: RunRoutine) => {
    setActiveRoutine(routine);
    const subMode = analyzeSubModeFor(routine);
    if (subMode !== null) {
      setAnalyzeSubMode(subMode);
      setRightDockPanel('analyze');
    }
    if (routine === 'sweep') {
      setSweepOpen(true);
    }
  };

  // Reorder so the active routine appears at the top of the list, per
  // the spec: "The currently-active routine appears at the top with a
  // check mark." The remainder keeps its declared order.
  const orderedRoutines = [
    ROUTINES.find((r) => r.id === activeRoutine)!,
    ...ROUTINES.filter((r) => r.id !== activeRoutine),
  ];

  return (
    <>
      <TopBarMenu label="Run" testId="topbar-menu-run">
        <TopBarMenuLabel>Active routine</TopBarMenuLabel>
        {orderedRoutines.map((routine, idx) => (
          <TopBarMenuItem
            key={routine.id}
            testId={`topbar-menu-run-${routine.testIdSuffix}`}
            checked={routine.id === activeRoutine}
            onClick={() => handleSelect(routine.id)}
            // After the active routine, insert a visual hint that the
            // remaining items are alternatives. Implemented as data-attr
            // rather than a dedicated separator so the keyboard nav
            // (which only counts items) doesn't have to skip it.
            data-routine-position={idx === 0 ? 'active' : 'alternative'}
          >
            Run {routine.label}
          </TopBarMenuItem>
        ))}
      </TopBarMenu>
      <SweepDialog open={sweepOpen} onOpenChange={setSweepOpen} />
    </>
  );
}
