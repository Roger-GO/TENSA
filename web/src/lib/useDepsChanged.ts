/**
 * useDepsChanged: whether this render is the first, or one whose ``deps``
 * differ (``Object.is``, as React compares the dependencies of an effect) from
 * those of the render before.
 *
 * It is for state that is set from other state or from props when they change:
 * ``if (useDepsChanged([open])) setDraft(blank)``. That runs where an effect
 * with the same dependencies would, on the first render and on each change,
 * but while rendering: React drops what the render returned and renders again
 * at once with the new state, so no render is committed, painted or handed to
 * an effect with the state of before. An effect that sets state shows a frame
 * of the old state and then renders everything a second time.
 *
 * The dependencies must hold still from one render to the next as long as
 * nothing changed (values, or objects that are kept): an array or an object
 * made anew by each render is a change at every render, and React gives up on
 * a render that keeps setting state while it renders. Each change also runs
 * the component's function a second time (its memos are kept), which suits
 * what changes at the pace of the user and not at every frame of a drag; for
 * that, a check of the state itself (``if (gone) setPicked(null)``) does
 * without the hook.
 */
import { useState } from 'react';

export function useDepsChanged(deps: readonly unknown[]): boolean {
  const [seen, setSeen] = useState<readonly unknown[] | null>(null);
  const changed =
    seen === null || seen.length !== deps.length || deps.some((dep, i) => !Object.is(dep, seen[i]));
  if (changed) setSeen(deps);
  return changed;
}
