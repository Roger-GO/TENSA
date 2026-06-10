import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useFirstRunStore } from '@/store/firstRun';
import type { CoachStep } from '@/store/firstRun';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { cn } from '@/lib/cn';

/**
 * FirstRunCoach (Unit 13 of the v2.0 polish plan).
 *
 * Floating, non-blocking 3-step coach that walks a brand-new user
 * through producing their first PF result. Visible exactly once per
 * browser profile (dismissal persisted to ``localStorage`` under
 * ``andes-app:first-run-coach-v1``).
 *
 * Design constraints (from the plan):
 *
 * - **Non-modal.** No backdrop, no focus trap, no scroll lock — the
 *   user can interact with the rest of the app while the coach is
 *   visible. That's the whole point: the coach exists to nudge, not
 *   to block.
 * - **Anchored copy, simple positioning.** The card lives in a fixed
 *   corner per step (top-left for step 1, top-center for step 2,
 *   top-right for step 3) with copy that names the target ("Look at
 *   the left rail to pick a case…"). No intersection observer, no
 *   connector arrow.
 * - **Auto-advance.** Step 1 watches the case slice; once a case is
 *   loaded, advances to step 2. Step 2 watches the PFlow slice; once
 *   a converged result lands, advances to step 3. Step 3 has a
 *   "Done" CTA the user clicks themselves — switching to Analyze is
 *   the discoverable last action.
 * - **Always dismissable.** A small ``×`` button at any step closes
 *   the coach forever.
 *
 * The component renders nothing once the coach is dismissed; mounting
 * it at AppShell root is therefore zero-cost in the steady state.
 */

interface StepCopy {
  title: string;
  body: string;
  /** Anchor side — drives the fixed-position class. */
  anchor: 'top-left' | 'top-center' | 'top-right';
  /** Primary CTA label for this step. */
  cta: string;
}

const STEP_COPY: Record<Exclude<CoachStep, null>, StepCopy> = {
  1: {
    title: 'Pick a case',
    body: 'Look at the left rail to pick a case file (try kundur or IEEE 14). Loading sets up the topology and brings up the diagram.',
    anchor: 'top-left',
    cta: 'Got it',
  },
  2: {
    title: 'Run power flow',
    body: 'Use the Run button at the top of the screen to compute the operating point. The Inspector and Results table populate when PF converges.',
    anchor: 'top-center',
    cta: 'Got it',
  },
  3: {
    title: 'Open Analyze',
    body: 'Switch to the Analyze panel on the right to explore eigenvalues (EIG), continuation power flow (CPF), or state estimation (SE).',
    anchor: 'top-right',
    cta: 'Done',
  },
};

const ANCHOR_CLASS: Record<StepCopy['anchor'], string> = {
  // ``top-16`` clears the 44 px TopBar plus a few pixels of breathing
  // room. ``max-w-xs`` keeps the card under 320 px so it never
  // overflows narrow viewports. Step 1 ('top-left') sits just RIGHT of
  // the left rail (~240 px) instead of on top of it — the card must
  // never cover the Saved-cases list it is pointing the user at.
  'top-left': 'top-16 left-[260px]',
  'top-center': 'top-16 left-1/2 -translate-x-1/2',
  'top-right': 'top-16 right-4',
};

export function FirstRunCoach() {
  const coachStep = useFirstRunStore((s) => s.coachStep);
  const nextStep = useFirstRunStore((s) => s.nextStep);
  const dismissCoach = useFirstRunStore((s) => s.dismissCoach);

  const caseSelection = useCaseStore((s) => s.selection);
  const lastPfRun = usePflowStore((s) => s.lastRun);

  // Auto-advance: step 1 → step 2 once a case is loaded. Guarded on
  // ``coachStep === 1`` so the effect only fires the transition, not
  // on every case change after.
  useEffect(() => {
    if (coachStep === 1 && caseSelection !== null) {
      nextStep();
    }
  }, [coachStep, caseSelection, nextStep]);

  // Auto-advance: step 2 → step 3 once a converged PF result lands.
  // We require ``converged: true`` so a non-convergence run doesn't
  // prematurely advance.
  useEffect(() => {
    if (coachStep === 2 && lastPfRun !== null && lastPfRun.converged) {
      nextStep();
    }
  }, [coachStep, lastPfRun, nextStep]);

  if (coachStep === null) return null;

  const copy = STEP_COPY[coachStep];

  const onCta = () => {
    if (coachStep === 3) {
      // Step 3 is the terminal — clicking "Done" persists dismissal.
      dismissCoach();
    } else {
      nextStep();
    }
  };

  return (
    <div
      // ``role="region"`` rather than ``"dialog"`` because this is
      // intentionally NOT a modal — assistive tech should announce
      // it as an ambient region, not a focus-trapping dialog.
      role="region"
      aria-label="First-run coach"
      data-testid="first-run-coach"
      data-step={coachStep}
      className={cn(
        'fixed z-40 w-72 max-w-[calc(100vw-2rem)]',
        'border-border bg-background text-foreground',
        // Stronger card lift so the floating coach cleanly separates
        // from the SLD canvas underneath; ring complements shadow on
        // both light and dark backgrounds.
        'flex flex-col gap-2.5 rounded-[var(--radius-lg)] border p-4',
        'shadow-xl ring-1 ring-black/5 dark:ring-white/5',
        ANCHOR_CLASS[copy.anchor],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span
            data-testid="first-run-coach-step-indicator"
            className="text-primary text-[11px] font-semibold tracking-wider uppercase"
          >
            Step {coachStep} of 3
          </span>
          <p className="text-foreground text-base font-semibold tracking-tight">{copy.title}</p>
        </div>
        <button
          type="button"
          onClick={dismissCoach}
          aria-label="Dismiss first-run coach"
          data-testid="first-run-coach-dismiss"
          className={cn(
            'text-muted-foreground hover:bg-muted hover:text-foreground',
            '-mt-1 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center',
            'rounded-[var(--radius-sm)]',
            'transition-colors duration-[var(--duration-fast)]',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <CloseGlyph className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="text-muted-foreground text-[13px] leading-relaxed">{copy.body}</p>

      <div className="mt-1 flex items-center justify-between gap-2">
        <StepDots active={coachStep} />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onCta}
          data-testid="first-run-coach-cta"
        >
          {copy.cta}
        </Button>
      </div>
    </div>
  );
}

function StepDots({ active }: { active: 1 | 2 | 3 }) {
  return (
    <div
      aria-hidden="true"
      data-testid="first-run-coach-dots"
      className="flex items-center gap-1.5"
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 rounded-full',
            'transition-all duration-[var(--duration-fast)]',
            // Active dot stretches into a small bar so progress reads
            // at a glance even when the row is small; inactive dots
            // get a touch more contrast against the card background.
            i === active ? 'bg-primary w-4' : 'bg-muted-foreground/50 w-1.5',
          )}
        />
      ))}
    </div>
  );
}

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
