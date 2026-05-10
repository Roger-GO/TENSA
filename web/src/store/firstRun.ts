/**
 * First-run coach slice (Unit 13 of the v2.0 polish plan).
 *
 * Tracks the state of the 3-step coach card that walks a brand-new
 * user through their first session: pick a case → run PF → switch to
 * Analyze.
 *
 * Persistence:
 *
 * - The dismissal flag (``coachDismissed``) is persisted to
 *   ``localStorage`` under the versioned key
 *   ``andes-app:first-run-coach-v1`` so a returning user never sees the
 *   coach again. Bumping the suffix (``-v2``) is the migration knob for
 *   future major releases that want to re-introduce the coach.
 * - The current step is intentionally NOT persisted — restarting the
 *   browser drops the user back to step 1, which is correct: if they
 *   left mid-coach and came back later, the freshest "where am I"
 *   answer is "the beginning".
 *
 * Lifecycle:
 *
 * - On module load, ``readPersistedDismissal()`` checks the storage
 *   key. If the user dismissed the coach in a prior session,
 *   ``coachStep`` initializes to ``null`` and ``coachDismissed`` to
 *   ``true`` so the ``FirstRunCoach`` component renders nothing.
 * - Otherwise ``coachStep`` starts at ``1``.
 * - ``nextStep()`` advances 1 → 2 → 3 → null (terminal). Calling it
 *   while ``coachStep === null`` is a no-op so auto-advance hooks can
 *   fire safely after dismissal.
 * - ``dismissCoach()`` sets ``coachStep = null`` and persists
 *   ``coachDismissed = true``.
 *
 * Storage failures (private-mode Safari, quota, missing
 * ``localStorage``) fall back to in-memory state — the coach behaves
 * normally for the current tab; the user just sees it again next time.
 */
import { create } from 'zustand';

export const FIRST_RUN_STORAGE_KEY = 'andes-app:first-run-coach-v1';

/** Coach step. ``null`` means the coach is not visible. */
export type CoachStep = 1 | 2 | 3 | null;

/**
 * Read the persisted dismissal flag. Returns ``true`` only when the
 * stored value is the exact sentinel string ``'dismissed'``; any other
 * shape (missing, malformed, legacy) reads as ``false`` so we err on
 * the side of showing the coach to a fresh user.
 */
export function readPersistedDismissal(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(FIRST_RUN_STORAGE_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

/**
 * Persist the dismissal flag. Returns ``true`` on success, ``false``
 * if storage threw — the slice surfaces this as ``persistFailed``.
 */
export function writePersistedDismissal(dismissed: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (dismissed) {
      localStorage.setItem(FIRST_RUN_STORAGE_KEY, 'dismissed');
    } else {
      localStorage.removeItem(FIRST_RUN_STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export interface FirstRunState {
  /** Active coach step (1, 2, 3) or null when hidden / dismissed. */
  coachStep: CoachStep;
  /** True once the user has dismissed the coach (persisted). */
  coachDismissed: boolean;
  /** True if the most recent persistence attempt failed. */
  persistFailed: boolean;
  /** Advance to the next step (terminal: null). No-op once dismissed. */
  nextStep: () => void;
  /** Dismiss the coach forever (persists). */
  dismissCoach: () => void;
  /**
   * Test helper — reset in-memory state. Pass ``{ clearStorage: true }``
   * to also wipe the localStorage key so the next bootstrap shows the
   * coach again.
   */
  __resetForTests: (opts?: { clearStorage?: boolean }) => void;
}

const initialDismissed = readPersistedDismissal();

export const useFirstRunStore = create<FirstRunState>((set, get) => ({
  coachStep: initialDismissed ? null : 1,
  coachDismissed: initialDismissed,
  persistFailed: false,
  nextStep: () => {
    const { coachStep, coachDismissed } = get();
    if (coachDismissed || coachStep === null) return;
    if (coachStep === 1) set({ coachStep: 2 });
    else if (coachStep === 2) set({ coachStep: 3 });
    else if (coachStep === 3) {
      // Terminal — dismiss the coach without setting the persisted
      // flag. The "Done" CTA on step 3 routes through ``dismissCoach``
      // so the persistence happens there; reaching ``nextStep`` from
      // step 3 is a defensive no-throw path.
      const ok = writePersistedDismissal(true);
      set({ coachStep: null, coachDismissed: true, persistFailed: !ok });
    }
  },
  dismissCoach: () => {
    const ok = writePersistedDismissal(true);
    set({ coachStep: null, coachDismissed: true, persistFailed: !ok });
  },
  __resetForTests: (opts) => {
    if (opts?.clearStorage) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(FIRST_RUN_STORAGE_KEY);
        }
      } catch {
        // intentional swallow — tests only
      }
    }
    const dismissed = readPersistedDismissal();
    set({
      coachStep: dismissed ? null : 1,
      coachDismissed: dismissed,
      persistFailed: false,
    });
  },
}));
