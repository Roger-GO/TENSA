/**
 * The comparison of two results documents (``POST /compare``) and the
 * conversion of a kept run's traces into one (``POST /results/convert``).
 *
 * Both routes hold no session: the body carries everything the server needs.
 * The mutation's result is read by the compare view from ``data``; nothing is
 * written to a store here.
 */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { andesClient, NetworkError, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type { components } from '@/api/generated';

export type CompareRequest = components['schemas']['CompareRequest'];
export type CompareResponse = components['schemas']['CompareResponse'];
export type ResultsDocument = components['schemas']['ResultsDocument'];
export type ConvertResultRequest = components['schemas']['ConvertResultRequest'];
export type ConvertResultResponse = components['schemas']['ConvertResultResponse'];
export type KeyEntrySchema = components['schemas']['KeyEntrySchema'];
export type Tolerances = components['schemas']['Tolerances'];
export type SeriesDifferenceOut = components['schemas']['SeriesDifferenceOut'];
export type TableRowDifferenceOut = components['schemas']['TableRowDifferenceOut'];
export type EigenvaluePairOut = components['schemas']['EigenvaluePairOut'];
export type PflowComparisonOut = components['schemas']['PflowComparisonOut'];
export type NotComparableOut = components['schemas']['NotComparableOut'];

/** One side of a comparison, as the view keeps it: the document and what to call it. */
export interface CompareSide {
  document: ResultsDocument;
  /** What the picker and the verdict call it. */
  label: string;
}

/** The raw text of the tolerance fields, as the view's inputs hold them. */
export interface CompareTolerancesInput {
  quantities: Record<string, string>;
  frequency_hz: string;
  damping_ratio: string;
  max_mode_distance: string;
}

/**
 * `POST /compare`. Session-less: the two documents are the body.
 * No store writes on success; the view reads the mutation's `data`.
 */
export function useCompareResults(): UseMutationResult<
  CompareResponse,
  ProblemDetailsError | NetworkError | Error,
  CompareRequest
> {
  return useMutation({
    mutationFn: async (body: CompareRequest) =>
      await andesClient.post<CompareResponse>('/compare', {
        body,
        timeoutMs: TIMEOUTS.pflowRun,
      }),
  });
}

/**
 * `POST /results/convert`, as a plain fetch: the view needs the document of a
 * run it just picked, once, not a cached query.
 */
export async function convertResult(body: ConvertResultRequest): Promise<ConvertResultResponse> {
  return await andesClient.post<ConvertResultResponse>('/results/convert', {
    body,
    timeoutMs: TIMEOUTS.pflowRun,
  });
}

/**
 * `GET /sessions/{id}/keys`, as a plain fetch: the key listing a run records
 * when it starts, so a later comparison can send it back with the traces.
 */
export async function fetchKeyListing(sessionId: string): Promise<KeyEntrySchema[]> {
  const answer = await andesClient.get<{ keys: KeyEntrySchema[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/keys`,
    { timeoutMs: TIMEOUTS.workspace },
  );
  return answer.keys;
}
