/**
 * What the user is told when the request to abort a run fails. The Abort button
 * and the Esc command both send the same request, so they say the same thing.
 */
import { ProblemDetailsError } from '@/api/client';
import { toast } from '@/lib/toast';

export function reportAbortError(err: Error): void {
  const detail =
    err instanceof ProblemDetailsError
      ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
      : (err.message ?? 'Abort failed');
  toast.error('TDS error', { description: `Could not abort: ${detail}` });
}
