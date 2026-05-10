/**
 * ProfileImportDialog — file pick + upload, target assignment, stage
 * flow, delete flow, error handling. Mocks the substrate client so we
 * can assert what gets POSTed without spinning a real session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ProfileImportDialog } from '@/components/profiles/ProfileImportDialog';
import { useSessionStore } from '@/store/session';
import { useProfilesStore } from '@/store/profiles';
import { parseSessionId } from '@/api/types';
import type {
  ListProfilesResponse,
  TopologyEntry,
  TopologySummary,
  UploadProfileResponse,
} from '@/api/types';

const fetchSpy = vi.fn();
const postSpy = vi.fn();
const deleteSpy = vi.fn();
const getSpy = vi.fn();

let MOCK_TOPOLOGY: TopologySummary | null = null;
let MOCK_LIST_RESPONSE: ListProfilesResponse = { profiles: [] };
let postReturn: TopologyEntry | (() => Promise<TopologyEntry>) = {
  idx: 'TimeSeries_1',
  name: 'TimeSeries_1',
  kind: 'TimeSeries',
  params: { mode: 1, model: 'PQ', dev: 'PQ_5', tkey: 't' },
};
let postShouldFail: { status: number; detail: string } | null = null;
let uploadReturn: UploadProfileResponse = {
  profile_path: '/tmp/ws/profiles/abc.xlsx',
  bytes_written: 64,
};
let uploadShouldFail: { status: number; detail: string } | null = null;

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  const ProblemDetailsError = actual.ProblemDetailsError;
  return {
    ...actual,
    andesClient: {
      get: (path: string) => {
        getSpy(path);
        if (path.endsWith('/profiles')) {
          return Promise.resolve(MOCK_LIST_RESPONSE);
        }
        return Promise.resolve(null);
      },
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        if (postShouldFail) {
          return Promise.reject(
            new ProblemDetailsError(
              {
                type: 'about:blank',
                title: 'Error',
                status: postShouldFail.status,
                detail: postShouldFail.detail,
                instance: null,
              },
              null,
              path,
            ),
          );
        }
        if (typeof postReturn === 'function') return postReturn();
        return Promise.resolve(postReturn);
      },
      delete: (path: string) => {
        deleteSpy(path);
        return Promise.resolve(undefined);
      },
      put: vi.fn(),
    },
  };
});

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

// Stub global fetch — used by the upload mutation (multipart body).
const originalFetch = globalThis.fetch;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  fetchSpy.mockClear();
  postSpy.mockClear();
  deleteSpy.mockClear();
  getSpy.mockClear();
  postShouldFail = null;
  uploadShouldFail = null;
  postReturn = {
    idx: 'TimeSeries_1',
    name: 'TimeSeries_1',
    kind: 'TimeSeries',
    params: { mode: 1, model: 'PQ', dev: 'PQ_5', tkey: 't' },
  };
  uploadReturn = {
    profile_path: '/tmp/ws/profiles/abc.xlsx',
    bytes_written: 64,
  };
  MOCK_LIST_RESPONSE = { profiles: [] };
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [
      { idx: '1', name: 'BUS1', kind: 'Bus', params: {} },
      { idx: '5', name: 'BUS5', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [
      { idx: 'PV_3', name: 'PV_3', kind: 'PV', params: { bus: '5' } },
    ],
    loads: [
      { idx: 'PQ_5', name: 'PQ_5', kind: 'PQ', params: { bus: '5', p0: 0.15 } },
      { idx: 'PQ_8', name: 'PQ_8', kind: 'PQ', params: { bus: '8', p0: 0.10 } },
    ],
    shunts: [],
  };
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useProfilesStore.setState({ profiles: [] });

  // Stub global fetch for the upload mutation. The dialog's
  // ``useUploadProfile`` calls ``fetch`` directly (multipart).
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    fetchSpy(String(input));
    if (uploadShouldFail) {
      return new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Error',
          status: uploadShouldFail.status,
          detail: uploadShouldFail.detail,
          instance: null,
        }),
        {
          status: uploadShouldFail.status,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(JSON.stringify(uploadReturn), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  useProfilesStore.setState({ profiles: [] });
  globalThis.fetch = originalFetch;
});

describe('<ProfileImportDialog />', () => {
  it('renders nothing when open=false', () => {
    render(
      withQueryClient(<ProfileImportDialog open={false} onOpenChange={() => {}} />),
    );
    expect(screen.queryByTestId('profile-import-dialog')).toBeNull();
  });

  it('renders title, file input, and disabled stage button when no upload', () => {
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    expect(screen.getByTestId('profile-import-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Import time-series profile/)).toBeInTheDocument();
    expect(screen.getByTestId('profile-file-input')).toBeInTheDocument();
    expect(screen.getByTestId('profile-stage-submit')).toBeDisabled();
    expect(screen.getByTestId('profile-stage-submit')).toHaveTextContent(
      'Upload a file first',
    );
    // Empty staged list message.
    expect(screen.getByText(/No profiles staged/)).toBeInTheDocument();
    // Mode-1 disclaimer.
    expect(screen.getByTestId('profile-mode-note')).toHaveTextContent(/mode=1/i);
  });

  it('shows currently-staged profiles from the store with delete affordance', async () => {
    const staged: TopologyEntry = {
      idx: 'TimeSeries_1',
      name: 'TimeSeries_1',
      kind: 'TimeSeries',
      params: { mode: 1, model: 'PQ', dev: 'PQ_5', tkey: 't' },
    };
    MOCK_LIST_RESPONSE = { profiles: [staged] };
    useProfilesStore.setState({ profiles: [staged] });
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    await waitFor(() =>
      expect(screen.getByTestId('profile-staged-item-TimeSeries_1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('profile-delete-TimeSeries_1')).toBeInTheDocument();
  });

  it('uploading a file calls fetch then unlocks the stage button after a device pick', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));

    const fileInput = screen.getByTestId('profile-file-input') as HTMLInputElement;
    const file = new File(['t,p0\n0,0.15\n'], 'ramp.csv', { type: 'text/csv' });
    await user.upload(fileInput, file);
    await waitFor(() =>
      expect(screen.getByTestId('profile-upload-confirmation')).toHaveTextContent(
        /ramp\.csv/,
      ),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toContain('/profiles/upload');

    // Dev still empty — stage disabled.
    expect(screen.getByTestId('profile-stage-submit')).toBeDisabled();
    expect(screen.getByTestId('profile-stage-submit')).toHaveTextContent('Pick a device');

    // Pick a PQ device.
    const devSelect = screen.getByTestId('profile-dev-input') as HTMLSelectElement;
    await user.selectOptions(devSelect, 'PQ_5');
    expect(screen.getByTestId('profile-stage-submit')).not.toBeDisabled();
    expect(screen.getByTestId('profile-stage-submit')).toHaveTextContent(/Stage profile/);
  });

  it('clicking stage POSTs /profiles with the form payload', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));

    const fileInput = screen.getByTestId('profile-file-input') as HTMLInputElement;
    const file = new File(['t,p0\n0,0.15\n'], 'ramp.csv', { type: 'text/csv' });
    await user.upload(fileInput, file);
    await waitFor(() =>
      expect(screen.getByTestId('profile-upload-confirmation')).toBeInTheDocument(),
    );

    await user.selectOptions(screen.getByTestId('profile-dev-input'), 'PQ_5');
    await user.click(screen.getByTestId('profile-stage-submit'));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

    const [path, body] = postSpy.mock.calls[0]!;
    expect(path).toContain('/profiles');
    expect(body).toEqual({
      profile_path: '/tmp/ws/profiles/abc.xlsx',
      sheet: 'profile',
      fields: 'p0',
      dests: 'p0',
      tkey: 't',
      model: 'PQ',
      dev: 'PQ_5',
      mode: 1,
    });
  });

  it('switching model to PV repopulates the device picker', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    const modelSelect = screen.getByTestId('profile-model-input') as HTMLSelectElement;
    await user.selectOptions(modelSelect, 'PV');
    const devSelect = screen.getByTestId('profile-dev-input') as HTMLSelectElement;
    // PV_3 is the only PV in the mock topology.
    const options = Array.from(devSelect.options).map((o) => o.value);
    expect(options).toContain('PV_3');
    expect(options).not.toContain('PQ_5');
  });

  it('surfaces upload errors inline on a 422', async () => {
    uploadShouldFail = { status: 422, detail: 'unsupported extension' };
    const user = userEvent.setup();
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    const fileInput = screen.getByTestId('profile-file-input') as HTMLInputElement;
    // Use a .csv extension so the input's ``accept=".csv,.xlsx"`` filter
    // doesn't reject the upload before the substrate sees it. The
    // server-side 422 is what we're asserting on.
    const file = new File(['malformed,bytes'], 'profile.csv', { type: 'text/csv' });
    await user.upload(fileInput, file);
    await waitFor(() =>
      expect(screen.getByTestId('profile-server-error')).toHaveTextContent(
        /unsupported extension/,
      ),
    );
  });

  it('surfaces add errors inline on a 422', async () => {
    postShouldFail = { status: 422, detail: 'no PQ with idx=PQ_999' };
    const user = userEvent.setup();
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    const fileInput = screen.getByTestId('profile-file-input') as HTMLInputElement;
    const file = new File(['t,p0\n0,0.15\n'], 'ramp.csv', { type: 'text/csv' });
    await user.upload(fileInput, file);
    await waitFor(() =>
      expect(screen.getByTestId('profile-upload-confirmation')).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByTestId('profile-dev-input'), 'PQ_5');
    await user.click(screen.getByTestId('profile-stage-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('profile-server-error')).toHaveTextContent(
        /no PQ with idx=PQ_999/,
      ),
    );
  });

  it('clicking the × on a staged profile issues DELETE /profiles/{idx}', async () => {
    const user = userEvent.setup();
    const staged: TopologyEntry = {
      idx: 'TimeSeries_1',
      name: 'TimeSeries_1',
      kind: 'TimeSeries',
      params: { mode: 1, model: 'PQ', dev: 'PQ_5', tkey: 't' },
    };
    MOCK_LIST_RESPONSE = { profiles: [staged] };
    useProfilesStore.setState({ profiles: [staged] });
    render(withQueryClient(<ProfileImportDialog open onOpenChange={() => {}} />));
    await waitFor(() =>
      expect(screen.getByTestId('profile-delete-TimeSeries_1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('profile-delete-TimeSeries_1'));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteSpy.mock.calls[0]![0]).toContain('/profiles/TimeSeries_1');
  });

  it('cancel button calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      withQueryClient(<ProfileImportDialog open onOpenChange={onOpenChange} />),
    );
    await user.click(screen.getByTestId('profile-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
