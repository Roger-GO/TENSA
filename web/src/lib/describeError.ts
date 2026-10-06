import { ProblemDetailsError } from '@/api/client';

/**
 * Why a request failed, in the words to put after "Could not ...": the server's
 * own detail when it sent one, else the error's message.
 */
export function describeError(err: unknown): string {
  if (err instanceof ProblemDetailsError) return err.detail ?? err.title ?? `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}
