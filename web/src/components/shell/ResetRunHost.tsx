import { useEffect } from 'react';
import { provideResetRun, providedResetRun } from '@/lib/resetRunRequest';
import { useResetRunAction } from '@/lib/useResetRunAction';

/**
 * Provides Reset run to the places that ask for it by `requestResetRun`
 * (`lib/resetRunRequest.ts`) while it is mounted. The reset says what the
 * other Reset run buttons say: where the run went, and which edits a case
 * file's reload lost. Draws nothing.
 */
export function ResetRunHost(): null {
  const { reset } = useResetRunAction({ errorTitle: 'Reset run', confirm: true });
  useEffect(() => {
    provideResetRun(reset);
    return () => {
      if (providedResetRun() === reset) provideResetRun(null);
    };
  }, [reset]);
  return null;
}
