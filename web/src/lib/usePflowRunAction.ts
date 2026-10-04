/**
 * usePflowRunAction — the "run a power flow and say what happened" handler,
 * shared by every control that starts one: the top-bar Run button and the
 * "Run power flow" recovery that EIG / CPF / SE offer while no converged
 * operating point exists.
 *
 * Success toasts the iteration count. A non-converged run is a 200 that the
 * ``ConvergenceErrorPanel`` shows from the pflow slice, so it gets no toast,
 * and a 5xx goes to ``RuntimeCrashModal`` through ``pflow.error`` the same way.
 * A 4xx that points at a reload offers "Reload case + retry" when the caller
 * supplies ``reloadCase``.
 */
import { useRunPflow } from '@/api/queries';
import { ProblemDetailsError, ServerError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { toast } from '@/lib/toast';

export function usePflowRunAction(reloadCase?: () => void): () => void {
  const sessionId = useSessionStore((s) => s.sessionId);
  const runPflow = useRunPflow();

  return () => {
    if (!sessionId) return;
    runPflow.mutate(sessionId, {
      onSuccess: (data) => {
        if (data.converged) {
          toast.success(`PF converged in ${data.iterations} iterations.`);
        }
      },
      onError: (err) => {
        if (err instanceof ServerError) return;
        if (err instanceof ProblemDetailsError) {
          const detail = err.detail ?? err.title ?? `HTTP ${err.status}`;
          // The substrate's pflow handler hints "call /reload" when a failed
          // setup() left the System unusable; offer that as an action.
          if (reloadCase !== undefined && /reload/i.test(detail)) {
            toast.error('Run PF failed', {
              description: detail,
              action: { label: 'Reload case + retry', onClick: reloadCase },
            });
          } else {
            toast.error('Run PF failed', { description: detail });
          }
        } else {
          toast.error('Run PF failed', {
            description: err.message ?? 'Run PF failed',
          });
        }
      },
    });
  };
}
