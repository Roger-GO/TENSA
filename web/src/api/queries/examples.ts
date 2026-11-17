/** The example cases: the catalog as this server sees it, and adding a case to the workspace. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { AddedExample, ExampleList } from '@/api/types';
import { queryKeys } from './keys';

/**
 * `GET /examples`. Every case of the catalog with whether its file is already in
 * the workspace and whether the file it would copy can be found. Read each time the
 * Example cases dialog opens (the workspace may have changed since), and again after
 * an add.
 */
export function useListExamples(): UseQueryResult<ExampleList, Error> {
  return useQuery({
    queryKey: queryKeys.examples,
    staleTime: 0,
    queryFn: async () => {
      return await andesClient.get<ExampleList>('/examples', { timeoutMs: TIMEOUTS.workspace });
    },
  });
}

export interface AddExampleVars {
  /** The id of the case, as `GET /examples` lists it. */
  id: string;
  /** Replace the files of the case that are in the workspace. Without it they answer 409. */
  overwrite?: boolean;
}

/**
 * `POST /examples/{id}/add?overwrite=<bool>`. Copies the case's file or files into the
 * workspace and records their source, citations and licence in `EXAMPLE-SOURCES.md`.
 * Errors: 400 (a link-only entry), 404 (an id the catalog lacks, or a file the installed
 * ANDES does not hold), 409 (a file is already there), 500 (the file could not be
 * written). Refreshes the example list and the workspace listing whatever the answer, so
 * a case that turns out to be there already (409) is shown as added.
 */
export function useAddExample(): UseMutationResult<AddedExample, Error, AddExampleVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, overwrite = false }: AddExampleVars) => {
      return await andesClient.post<AddedExample>(`/examples/${encodeURIComponent(id)}/add`, {
        query: { overwrite: overwrite ? 'true' : 'false' },
        timeoutMs: TIMEOUTS.upload,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.examples });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
    },
  });
}
