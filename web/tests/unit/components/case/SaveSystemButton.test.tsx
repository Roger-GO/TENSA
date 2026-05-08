/**
 * SaveSystemButton — modal-driven case save with format radio,
 * extension auto-derivation, sidecar auto-write, and 409 overwrite-flip.
 *
 * Tests stub `andesClient.post`/`put` so the lifecycle is exercised
 * without a substrate. We watch:
 * - format-radio toggling rewrites the inline filename preview.
 * - submit fires POST /sessions/{id}/save with the right body.
 * - on 409 with overwrite=false, the inline error suggests ticking
 *   overwrite; toggling and re-submitting passes overwrite=true.
 * - sidecar auto-write fires PUT /workspace/layout when there are
 *   drag overrides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SaveSystemButton } from '@/components/case/SaveSystemButton';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { parseSessionId } from '@/api/types';
import type { ProblemDetails, TopologySummary } from '@/api/types';

const postSpy = vi.fn();
const putSpy = vi.fn();
type Resolver = () => Promise<unknown>;
let nextPost: Resolver = () =>
  Promise.resolve({ filename: 'my-system.xlsx', bytes_written: 1024 });
let nextPut: Resolver = () => Promise.resolve(undefined);

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

function makeProblemDetails(status: number, detail: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: `HTTP ${status}`,
    status,
    detail,
    instance: null,
  };
}

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      delete: vi.fn(),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return nextPost();
      },
      put: (path: string, opts: { body?: unknown; query?: Record<string, string> }) => {
        putSpy(path, opts.body, opts.query);
        return nextPut();
      },
    },
  };
});

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  putSpy.mockClear();
  nextPost = () =>
    Promise.resolve({ filename: 'my-system.xlsx', bytes_written: 1024 });
  nextPut = () => Promise.resolve(undefined);
  MOCK_TOPOLOGY = emptyTopology();
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useCaseStore.setState({
    selection: null,
    topology: emptyTopology(),
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
});

describe('<SaveSystemButton />', () => {
  it('renders the trigger button enabled when a topology is loaded', () => {
    render(withQueryClient(<SaveSystemButton />));
    expect(screen.getByTestId('save-system-button')).toBeEnabled();
  });

  it('disables the trigger button when topology is null', () => {
    MOCK_TOPOLOGY = null;
    render(withQueryClient(<SaveSystemButton />));
    expect(screen.getByTestId('save-system-button')).toBeDisabled();
  });

  it('clicking the trigger opens the modal with the xlsx default + filename preview', async () => {
    render(withQueryClient(<SaveSystemButton />));
    await userEvent.click(screen.getByTestId('save-system-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Save system/i);
    // Preview reflects the default filename + xlsx default.
    expect(screen.getByText(/my-system\.xlsx/)).toBeInTheDocument();
  });

  it('switching the format radio updates the auto-derived extension preview', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByRole('radio', { name: /json/i }));
    expect(screen.getByText(/my-system\.json/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /raw/i }));
    expect(screen.getByText(/my-system\.raw/)).toBeInTheDocument();
  });

  it('happy path: submitting posts to /sessions/{id}/save with the right body', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const [path, body] = postSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/save');
    expect(body).toEqual({
      filename: 'my-system.xlsx',
      format: 'xlsx',
      overwrite: false,
    });
  });

  it('on a 409 with overwrite=false, surfaces the inline overwrite-suggestion error', async () => {
    const user = userEvent.setup();
    const { ProblemDetailsError } = await import('@/api/client');
    nextPost = () =>
      Promise.reject(
        new ProblemDetailsError(makeProblemDetails(409, 'File exists')),
      );
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('save-error')).toHaveTextContent(/Overwrite/i);
  });

  it('toggling Overwrite + re-submitting passes overwrite=true to the server', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    const overwriteCheckbox = screen.getByRole('checkbox', { name: /Overwrite if exists/i });
    await user.click(overwriteCheckbox);
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    const [, body] = postSpy.mock.calls[0] ?? [];
    expect(body).toMatchObject({ overwrite: true });
  });

  it('auto-writes a sidecar via PUT /workspace/layout when drag overrides exist', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      dragOverrides: {
        // bus drag (no kind prefix) → goes under coordinates
        '1': { x: 10, y: 20 },
      },
    });
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [path, body] = putSpy.mock.calls[0] ?? [];
    expect(path).toBe('/workspace/layout');
    // The sidecar payload includes the bus coords.
    expect(body).toMatchObject({
      coordinates: { '1': { x: 10, y: 20 } },
    });
  });

  it('skips the sidecar write entirely when there are no drag overrides', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ dragOverrides: {} });
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalled();
    });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty filename with an inline error before firing the request', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    const filename = screen.getByTestId('save-filename') as HTMLInputElement;
    await user.clear(filename);
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toBeInTheDocument();
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('partitions non-bus drag overrides into the non_bus_coordinates side of the sidecar', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...emptyTopology(),
      generators: [{ idx: '1', name: 'G1', kind: 'PV', params: {} }],
    };
    useCaseStore.setState({
      dragOverrides: {
        // non-bus drag uses the `${uiCategory}-${idx}` shape
        'generator-1': { x: 50, y: 60 },
      },
    });
    render(withQueryClient(<SaveSystemButton />));
    await user.click(screen.getByTestId('save-system-button'));
    await user.click(screen.getByTestId('save-confirm'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [, body] = putSpy.mock.calls[0] ?? [];
    // The non-bus coord lands under `non_bus_coordinates` keyed by both
    // model class (PV) and UI category (generator).
    expect(body).toMatchObject({
      coordinates: {},
      non_bus_coordinates: {
        PV: { '1': { x: 50, y: 60 } },
        generator: { '1': { x: 50, y: 60 } },
      },
    });
  });
});
