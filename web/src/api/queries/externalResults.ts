/**
 * External results import: ``POST /external-results?source=tsat|psse``.
 *
 * The route holds no session and takes the export's bytes as the request body
 * (``application/octet-stream``, never multipart, which the server refuses
 * with 415). The default ``andesClient.post`` is JSON-shaped, so the mutation
 * calls ``fetch`` directly, as ``useExportBundle`` does, and honours the same
 * ``ProblemDetailsError`` taxonomy: the dialog reads ``problem.detail`` of a
 * 413, 415 or 422 for its inline error line.
 *
 * The import registers no job (the Activity panel tracks session routines and
 * this route holds no session) and fires no toast: the dialog consumes the
 * response and closes.
 */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { NetworkError, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type { components } from '@/api/generated';

/** One signal of an imported export, as the server sends it. */
export type ExternalSeries = components['schemas']['ExternalSeries'];
/** What ``POST /external-results`` answers. */
export type ExternalResultsResponse = components['schemas']['ExternalResultsResponse'];

export interface ImportExternalResultsVars {
  /** The tool whose export the file is. */
  source: 'tsat' | 'psse';
  /** The ``.xlsx`` export, sent byte for byte as the request body. */
  file: File;
}

/**
 * ``POST /api/external-results?source=...`` with the file as the whole body.
 * Reading a workbook takes seconds for a large one, so the timeout is the one
 * a case load gets.
 */
export function useImportExternalResults(): UseMutationResult<
  ExternalResultsResponse,
  Error,
  ImportExternalResultsVars
> {
  return useMutation({
    mutationFn: async ({ source, file }: ImportExternalResultsVars) => {
      const url = `/api/external-results?source=${source}`;
      const headers = new Headers();
      headers.set('Content-Type', 'application/octet-stream');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.caseLoad);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: file,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new NetworkError(`Network error on POST ${url}`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let parsed: unknown = undefined;
        try {
          parsed = await response.json();
        } catch {
          // ignore
        }
        const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
        const problem = {
          type: typeof obj.type === 'string' ? obj.type : 'about:blank',
          title: typeof obj.title === 'string' ? obj.title : `HTTP ${response.status}`,
          status: typeof obj.status === 'number' ? obj.status : response.status,
          detail: typeof obj.detail === 'string' ? obj.detail : null,
          instance: typeof obj.instance === 'string' ? obj.instance : null,
        };
        throw new ProblemDetailsError(problem, parsed, url);
      }

      return (await response.json()) as ExternalResultsResponse;
    },
  });
}
