/** The workspace's case files and the layout sidecar kept beside a case. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { andesClient, ProblemDetailsError, TIMEOUTS } from '@/api/client';
import type {
  SidecarLayout,
  UploadedWorkspaceFile,
  WorkspaceFileList,
  WorkspacePath,
} from '@/api/types';
import { useCaseStore } from '@/store/case';
import { queryKeys } from './keys';

/** `GET /workspace/files`. Stable across the tab; modest stale time. */
export function useListWorkspaceFiles(): UseQueryResult<WorkspaceFileList, Error> {
  return useQuery({
    queryKey: queryKeys.workspaceFiles,
    queryFn: async () => {
      return await andesClient.get<WorkspaceFileList>('/workspace/files', {
        timeoutMs: TIMEOUTS.workspace,
      });
    },
  });
}

export interface UploadWorkspaceFileVars {
  /** The file to add. It is stored under its own name. */
  file: File;
  /** Replace a file of the same name. Without it a name that is taken answers 409. */
  overwrite?: boolean;
}

/**
 * `POST /workspace/files?name=<file name>&overwrite=<bool>`. The file is the request
 * body. Errors: 400 (an unsafe name), 409 (the name is taken), 413 (over 32 MiB),
 * 422 (not a case format, or empty). Refreshes the workspace listing on success.
 */
export function useUploadWorkspaceFile(): UseMutationResult<
  UploadedWorkspaceFile,
  Error,
  UploadWorkspaceFileVars
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, overwrite = false }: UploadWorkspaceFileVars) => {
      return await andesClient.post<UploadedWorkspaceFile>('/workspace/files', {
        query: { name: file.name, overwrite: overwrite ? 'true' : 'false' },
        file,
        timeoutMs: TIMEOUTS.upload,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles });
    },
  });
}

/**
 * `GET /workspace/layout?case_path=<rel>`. Returns null on 404 (no
 * sidecar yet) — the auto-layout path takes over.
 */
export function useGetSidecar(
  casePath: WorkspacePath | null,
): UseQueryResult<SidecarLayout | null, Error> {
  return useQuery({
    queryKey: casePath ? queryKeys.sidecar(casePath) : ['sidecar', 'noop'],
    enabled: casePath !== null,
    queryFn: async () => {
      if (!casePath) throw new Error('sidecar query enabled without a case path');
      try {
        return await andesClient.get<SidecarLayout>('/workspace/layout', {
          query: { case_path: casePath },
          timeoutMs: TIMEOUTS.workspace,
        });
      } catch (err) {
        if (err instanceof ProblemDetailsError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
  });
}

export interface PutSidecarVars {
  casePath: WorkspacePath;
  layout: SidecarLayout;
}

/**
 * `PUT /workspace/layout?case_path=<rel>`. Invalidates the matching GET
 * so the next read returns the freshly-stored sidecar.
 */
export function usePutSidecar(): UseMutationResult<void, Error, PutSidecarVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ casePath, layout }: PutSidecarVars) => {
      await andesClient.put<void>('/workspace/layout', {
        query: { case_path: casePath },
        body: layout,
        timeoutMs: TIMEOUTS.workspace,
      });
    },
    onSuccess: (_data, { casePath, layout }) => {
      queryClient.setQueryData(queryKeys.sidecar(casePath), layout);
      useCaseStore.getState().setLayoutSidecar(layout);
    },
  });
}
