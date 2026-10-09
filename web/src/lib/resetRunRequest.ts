/**
 * Reset run, asked for from where no hook can make it.
 *
 * The reset is a request with notices of its own (`useResetRunAction`), which
 * needs a component to live in. Two places that say a run has fixed the
 * system have none to spare: a notice of the diagram, whose button is drawn
 * by the toast surface, and the line of the Components palette, which is
 * drawn with or without a case. `ResetRunHost`
 * (`components/shell/ResetRunHost.tsx`), mounted once by the app, provides
 * the reset here, and those places ask for it.
 */
let provided: (() => void) | null = null;

/** Hand over the reset to answer `requestResetRun` with, or take it back with `null`. */
export function provideResetRun(reset: (() => void) | null): void {
  provided = reset;
}

/** The reset that is provided now, for the host to take back only its own. */
export function providedResetRun(): (() => void) | null {
  return provided;
}

/** Reset the run through the host. Answers `false` when the app has not mounted one. */
export function requestResetRun(): boolean {
  if (provided === null) return false;
  provided();
  return true;
}
