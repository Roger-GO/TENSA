/**
 * Tests for `<SweepDialog />` (Unit 18 of the v2.0 plan).
 *
 * Covers:
 * - Renders with a snapshot picker, parameter kind dropdown, range
 *   inputs, and tf input.
 * - Validation: missing snapshot disables the confirm button.
 * - Confirm fires the substrate mutation and registers the sweep in
 *   the sweep store.
 * - Substrate 409 / generic error surfaces inline.
 * - Cancel closes the dialog without firing the mutation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SweepDialog } from '@/components/sweep/SweepDialog';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useAuthStore } from '@/store/auth';
import { useCaseStore } from '@/store/case';
import { parseSessionId, parseWorkspacePath } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProblemResponse(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Error',
      status,
      detail,
      instance: null,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  // The Run-readiness hook (Unit 4 of v2.0 polish) reads case + auth +
  // sweep slices. Seed all three to a "happy path" baseline so the
  // existing dialog tests continue to assert the dialog-local
  // validation gates rather than tripping the new readiness gate.
  useAuthStore.setState({ token: 'test-token', persistFailed: false });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useAuthStore.setState({ token: null, persistFailed: false });
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
  });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  cleanup();
});

describe('<SweepDialog /> — render + validation', () => {
  it('renders the dialog inputs when open', async () => {
    // The list-snapshots query fires on mount; mock an empty list so the
    // picker renders without exploding.
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(200, { snapshots: [] }));
    render(withQueryClient(<SweepDialog open onOpenChange={() => {}} />));
    expect(await screen.findByTestId('sweep-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-parameter-kind')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-range-start')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-range-end')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-range-steps')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-tf')).toBeInTheDocument();
  });

  it('disables confirm when no snapshot is picked', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(200, { snapshots: [] }));
    render(withQueryClient(<SweepDialog open onOpenChange={() => {}} />));
    await screen.findByTestId('sweep-dialog');
    expect(screen.getByTestId('sweep-dialog-confirm')).toBeDisabled();
  });
});

describe('<SweepDialog /> — confirm flow', () => {
  it('confirm fires the substrate mutation and registers the sweep', async () => {
    const user = userEvent.setup();
    // First fetch: list snapshots. Second fetch: start sweep.
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          snapshots: [
            {
              name: 'snap-A',
              saved_at: '2026-05-09',
              has_pflow: true,
              has_tds: false,
              has_dill: true,
              andes_version: '2.0.0',
              disturbance_count: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse(202, { sweep_id: 'sweep-xyz', total: 5 }));

    const onOpenChange = vi.fn();
    render(withQueryClient(<SweepDialog open onOpenChange={onOpenChange} />));

    // Wait for the snapshots query to populate the dropdown.
    await waitFor(() =>
      expect(screen.getByTestId('sweep-dialog-snapshot').children.length).toBeGreaterThan(1),
    );

    // Pick the snapshot.
    await user.selectOptions(screen.getByTestId('sweep-dialog-snapshot'), 'snap-A');

    // Confirm should be enabled now.
    await waitFor(() => expect(screen.getByTestId('sweep-dialog-confirm')).toBeEnabled());

    await user.click(screen.getByTestId('sweep-dialog-confirm'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // Sweep should be registered in the store.
    const state = useSweepStore.getState();
    expect(state.activeSweepId).toBe('sweep-xyz');
    expect(state.sweeps['sweep-xyz']).toBeDefined();
    expect(state.sweeps['sweep-xyz']!.total).toBe(5);
    // The substrate request body should be the canonical wire shape.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const startCall = fetchSpy.mock.calls[1]!;
    const body = JSON.parse(String((startCall[1] as RequestInit).body));
    expect(body.parameter.kind).toBe('disturbance.fault.tc');
    expect(body.parameter.target).toBe(0);
    expect(body.parameter.range.steps).toBeGreaterThanOrEqual(2);
    expect(body.snapshot_name).toBe('snap-A');
  });

  it('surfaces a 409 sweep-already-running inline', async () => {
    const user = userEvent.setup();
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          snapshots: [
            {
              name: 'snap-A',
              saved_at: '2026-05-09',
              has_pflow: true,
              has_tds: false,
              has_dill: true,
              andes_version: '2.0.0',
              disturbance_count: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeProblemResponse(409, 'Sweep abc in progress; 1/5 iterations complete'),
      );

    render(withQueryClient(<SweepDialog open onOpenChange={() => {}} />));
    await waitFor(() =>
      expect(screen.getByTestId('sweep-dialog-snapshot').children.length).toBeGreaterThan(1),
    );
    await user.selectOptions(screen.getByTestId('sweep-dialog-snapshot'), 'snap-A');
    await waitFor(() => expect(screen.getByTestId('sweep-dialog-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('sweep-dialog-confirm'));

    expect(await screen.findByTestId('sweep-dialog-error')).toHaveTextContent(
      /Sweep abc in progress/,
    );
  });
});

describe('<SweepDialog /> — cancel', () => {
  it('cancel calls onOpenChange(false) without firing the mutation', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(200, { snapshots: [] }));
    const onOpenChange = vi.fn();
    render(withQueryClient(<SweepDialog open onOpenChange={onOpenChange} />));
    await screen.findByTestId('sweep-dialog');
    await user.click(screen.getByTestId('sweep-dialog-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Only the snapshots fetch should have fired.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('<SweepDialog /> — Run-readiness gates (v2.0 polish, Unit 4)', () => {
  it('confirm is disabled with a "No case loaded." tooltip when no case is loaded', async () => {
    const user = userEvent.setup();
    // Wipe the case so the readiness hook reports "No case loaded.".
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      dragOverrides: {},
      pendingDependents: [],
    });
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-A',
            saved_at: '2026-05-09',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 1,
          },
        ],
      }),
    );
    render(withQueryClient(<SweepDialog open onOpenChange={() => {}} />));
    await waitFor(() =>
      expect(screen.getByTestId('sweep-dialog-snapshot').children.length).toBeGreaterThan(1),
    );
    await user.selectOptions(screen.getByTestId('sweep-dialog-snapshot'), 'snap-A');

    const confirm = screen.getByTestId('sweep-dialog-confirm');
    expect(confirm).toBeDisabled();
    await user.hover(confirm.parentElement!);
    const matches = await screen.findAllByText(/No case loaded/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('confirm is disabled with the sweep-in-progress tooltip when a sweep is already active', async () => {
    const user = userEvent.setup();
    useSweepStore.setState({
      activeSweepId: 'sweep-already',
      sweeps: {
        'sweep-already': {
          sweepId: 'sweep-already',
          parameterKind: 'disturbance.fault.tc',
          parameterTarget: 0,
          snapshotName: 'snap-A',
          total: 5,
          state: 'running',
          iterations: [],
          truncated: false,
          error: null,
          startedAt: 0,
        },
      },
    });
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, {
        snapshots: [
          {
            name: 'snap-A',
            saved_at: '2026-05-09',
            has_pflow: true,
            has_tds: false,
            has_dill: true,
            andes_version: '2.0.0',
            disturbance_count: 1,
          },
        ],
      }),
    );
    render(withQueryClient(<SweepDialog open onOpenChange={() => {}} />));
    await waitFor(() =>
      expect(screen.getByTestId('sweep-dialog-snapshot').children.length).toBeGreaterThan(1),
    );
    await user.selectOptions(screen.getByTestId('sweep-dialog-snapshot'), 'snap-A');

    const confirm = screen.getByTestId('sweep-dialog-confirm');
    expect(confirm).toBeDisabled();
    await user.hover(confirm.parentElement!);
    const matches = await screen.findAllByText(/Sweep sweep-already in progress/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});
