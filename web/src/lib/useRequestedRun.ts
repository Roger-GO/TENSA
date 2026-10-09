/**
 * useRequestedRun: start a run that a command asked for.
 *
 * The commands of the Run menu and the palette ("Run power flow (PF)",
 * "Run eigenvalue analysis (EIG)", Ctrl/Cmd+Enter) do not run anything
 * themselves: each routine is started by the component that owns its Run
 * button, which holds the form the run is made from and shows what comes of
 * it. A command checks that the routine can run (`runReadinessNow`), brings
 * that component on screen and leaves a request in the run-mode store
 * (`requestRun`). The component calls this hook with the routines it starts,
 * and `start` is called once for each request, when the component is
 * mounted: at once when it already is, and when it comes on screen otherwise
 * (the Analysis tab of a drawer that was collapsed).
 */
import { useEffect, useRef } from 'react';
import type { RunRoutine } from '@/lib/useRunReadiness';
import { useRunModeStore } from '@/store/runMode';

export function useRequestedRun(
  routines: readonly RunRoutine[],
  start: (routine: RunRoutine) => void,
): void {
  const request = useRunModeStore((s) => s.runRequest);
  // The handler of the render that is on screen: it reads the form as it stands.
  const startRef = useRef(start);
  startRef.current = start;
  const routinesKey = routines.join(',');
  useEffect(() => {
    if (request === null) return;
    const routine = useRunModeStore
      .getState()
      .takeRunRequest(routinesKey.split(',') as RunRoutine[]);
    if (routine !== null) startRef.current(routine);
  }, [request, routinesKey]);
}
