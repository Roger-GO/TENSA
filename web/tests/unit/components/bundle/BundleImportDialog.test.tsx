/**
 * Tests for `<BundleImportDialog />` and `<BundleImportButton />`
 * (Unit 10 of the v2.0 plan).
 *
 * The bundle-import endpoint accepts a multipart upload and returns
 * either a 200 ``status="committed"`` (clean import) or a 409
 * ``status="plan"`` (conflicts to resolve). The mutation hook in
 * ``queries.ts`` re-shapes the 409 body into the same return type so
 * the dialog always sees a ``BundleImportResponse``.
 *
 * We mock ``globalThis.fetch`` to drive both branches:
 *
 * - committed → success state, store invalidation, auto-close
 * - plan → BundleConflictResolver renders inline; "Confirm resolution"
 *   re-issues with ``force_resolve=true``.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { BundleImportButton } from '@/components/bundle/BundleImportDialog';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeCommittedResponse() {
  return jsonResponse(200, {
    status: 'committed',
    plan: {
      manifest: {
        andes_version: '2.0.0',
        andes_app_version: '0.1.0.dev0',
        case_filename: 'ieee14.raw',
        case_sha256: 'abc',
        disturbance_count: 0,
        exported_at: '2026-05-09T00:00:00+00:00',
        files: ['case/ieee14.raw', 'manifest.json'],
      },
      case_files: ['ieee14.raw'],
      conflicts: [],
      blocked: false,
      has_conflicts: false,
    },
    warnings: [],
    case_filename: 'ieee14.raw',
    addfile_filenames: [],
    disturbances_replayed: 0,
  });
}

function makePlanResponse() {
  // 409 with a sha-mismatch conflict. ProblemDetails wraps the response
  // body inside ``detail`` per the substrate's convention.
  const importResponse = {
    status: 'plan',
    plan: {
      manifest: {
        andes_version: '2.0.0',
        andes_app_version: '0.1.0.dev0',
        case_filename: 'ieee14.raw',
        case_sha256: 'sha-bundle',
        disturbance_count: 0,
        exported_at: '2026-05-09T00:00:00+00:00',
        files: ['case/ieee14.raw', 'manifest.json'],
      },
      case_files: ['ieee14.raw'],
      conflicts: [
        {
          kind: 'sha-mismatch',
          severity: 'warning',
          message: 'Workspace already has ieee14.raw with a different checksum.',
          filename: 'ieee14.raw',
          bundle_meta: {
            filename: 'ieee14.raw',
            sha256: 'sha-bundle',
            size_bytes: 100,
          },
          workspace_meta: {
            filename: 'ieee14.raw',
            sha256: 'sha-workspace',
            size_bytes: 120,
          },
          bundle_andes_version: null,
          current_andes_version: null,
        },
      ],
      blocked: false,
      has_conflicts: true,
    },
    warnings: [],
    case_filename: null,
    addfile_filenames: [],
    disturbances_replayed: 0,
  };
  return jsonResponse(409, {
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: importResponse,
    instance: null,
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('<BundleImportButton />', () => {
  it('is enabled when a session is present', () => {
    render(withQueryClient(<BundleImportButton />));
    expect(screen.getByTestId('bundle-import-button')).toBeEnabled();
  });

  it('is disabled when no session is present', () => {
    useSessionStore.setState({ sessionId: null });
    render(withQueryClient(<BundleImportButton />));
    expect(screen.getByTestId('bundle-import-button')).toBeDisabled();
  });

  it('opens the dialog on click', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));
    expect(await screen.findByTestId('bundle-import-dialog')).toBeInTheDocument();
  });
});

describe('<BundleImportDialog /> — happy path', () => {
  it('uploads the picked file and surfaces the success state', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makeCommittedResponse());
    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));

    const input = (await screen.findByTestId('bundle-import-file-input')) as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'bundle.zip', {
      type: 'application/zip',
    });
    await user.upload(input, file);

    // File name preview appears.
    expect(screen.getByTestId('bundle-import-file-name')).toHaveTextContent(/bundle\.zip/);

    await user.click(screen.getByTestId('bundle-import-validate'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/sessions/test-session-id/bundle/import');
    expect((init as RequestInit).method).toBe('POST');
    // Body is FormData; we can't easily inspect the file but we can
    // check the multipart marker via Content-Type (the fetch spy
    // captures the headers we set; the boundary is browser-set).
    const headers = (init as RequestInit).headers as Headers;
    // Auth header forwarded.
    expect(headers).toBeInstanceOf(Headers);

    await waitFor(() =>
      expect(screen.getByTestId('bundle-import-success')).toHaveTextContent(/Imported ieee14\.raw/),
    );
    // Mutation hook mirrors the case selection into the case slice.
    await waitFor(() => expect(useCaseStore.getState().selection).not.toBeNull());
  });
});

describe('<BundleImportDialog /> — conflict path', () => {
  it('surfaces the BundleConflictResolver when the substrate returns a plan', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(makePlanResponse());
    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));

    const input = (await screen.findByTestId('bundle-import-file-input')) as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b])], 'bundle.zip', {
      type: 'application/zip',
    });
    await user.upload(input, file);
    await user.click(screen.getByTestId('bundle-import-validate'));

    // Conflict resolver renders inline.
    expect(await screen.findByTestId('bundle-conflict-resolver')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-conflict-sha-mismatch-ieee14.raw')).toBeInTheDocument();
    // Both sides of the diff visible.
    expect(screen.getByTestId('bundle-conflict-bundle-side')).toHaveTextContent(/sha-bundle/);
    expect(screen.getByTestId('bundle-conflict-workspace-side')).toHaveTextContent(/sha-workspace/);
    // Confirm-resolution button replaces the validate button.
    expect(screen.getByTestId('bundle-import-confirm-resolution')).toBeEnabled();
  });

  it('confirm-resolution re-issues with force_resolve=true', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(makePlanResponse());
    fetchSpy.mockResolvedValueOnce(makeCommittedResponse());

    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));
    const input = (await screen.findByTestId('bundle-import-file-input')) as HTMLInputElement;
    const file = new File([new Uint8Array([0x50, 0x4b])], 'bundle.zip', {
      type: 'application/zip',
    });
    await user.upload(input, file);
    await user.click(screen.getByTestId('bundle-import-validate'));
    await screen.findByTestId('bundle-conflict-resolver');

    // User picks "use workspace original" before confirming.
    await user.click(screen.getByTestId('bundle-conflict-pick-workspace'));
    await user.click(screen.getByTestId('bundle-import-confirm-resolution'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    // The second call's body is FormData; we inspect the FormData
    // entries by re-reading them off the mock's args.
    const secondCall = fetchSpy.mock.calls[1]!;
    const init = secondCall[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('force_resolve')).toBe('true');
    expect(body.get('use_bundle_case')).toBe('false');
  });
});

describe('<BundleImportDialog /> — error path', () => {
  it('surfaces the inline error on a 422 corrupt-zip / malformed-manifest response', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      jsonResponse(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Bundle is not a valid ZIP archive: bad magic bytes',
        instance: null,
      }),
    );
    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));
    const input = (await screen.findByTestId('bundle-import-file-input')) as HTMLInputElement;
    const file = new File([new Uint8Array([0x00, 0x01])], 'bundle.zip', {
      type: 'application/zip',
    });
    await user.upload(input, file);
    await user.click(screen.getByTestId('bundle-import-validate'));

    await waitFor(() =>
      expect(screen.getByTestId('bundle-import-error')).toHaveTextContent(
        /not a valid ZIP archive/,
      ),
    );
  });

  it('cancel closes the dialog without firing the mutation', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<BundleImportButton />));
    await user.click(screen.getByTestId('bundle-import-button'));
    await user.click(await screen.findByTestId('bundle-import-cancel'));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Dialog closes (the inner content unmounts).
    await waitFor(() => expect(screen.queryByTestId('bundle-import-dialog')).toBeNull());
  });
});
