/**
 * Tests for `<ReportDialog />` and `<ReportDialogButton />`
 * (Unit 4 of the v2.0 plan).
 *
 * Stubs ``globalThis.fetch`` so the ``useReport`` query (a TanStack
 * Query ``GET``) resolves with a synthetic ``ReportResponse``. The
 * tests check four user-visible flows:
 *
 * - Trigger button enables when a session is present, opens the dialog.
 * - Happy path: with a converged PF result on the session, the dialog
 *   fires the GET, renders the plain-text body + structured tables.
 * - Empty state: with NO PF result on the session, the dialog renders
 *   the "Run PFlow first" hint per tab without firing a network call.
 * - Tab switch: clicking the TDS tab fires the GET against the TDS
 *   route only after the user has switched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  ReportDialog,
  ReportDialogButton,
  useReportDialogStore,
} from '@/components/reports/ReportDialog';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { parseSessionId, parseRunId } from '@/api/types';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;
const writeTextSpy = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const SAMPLE_REPORT_BODY = {
  routine: 'pflow',
  plain_text:
    'ANDES 2.0.0\n\nPower flow converged in 4 iterations.\n\nBUS DATA:\nBUS1   1.03   0.0\n',
  structured: {
    tables: [
      {
        title: 'BUS DATA',
        headers: ['Bus Name', 'Vm(pu)', 'Va(rad.)'],
        rows: [
          ['BUS1', '1.03', '0.0'],
          ['BUS2', '1.04', '-0.030'],
        ],
      },
      {
        title: 'LINE DATA',
        headers: ['Line Name', 'P (pu)', 'Q (pu)'],
        rows: [['Line_1', '0.5', '0.1']],
      },
    ],
  },
};

const SAMPLE_TDS_BODY = {
  routine: 'tds',
  plain_text: '-> Time Domain Simulation Summary:\nFinal simulation time: 1.0 s\n',
  structured: {
    tables: [
      {
        title: 'TDS Summary',
        headers: ['Field', 'Value'],
        rows: [
          ['Final simulation time', '1.0 s'],
          ['Configured tf', '1.0 s'],
        ],
      },
    ],
  },
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProblemResponse(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Error', status, detail, instance: null }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  writeTextSpy.mockReset();
  writeTextSpy.mockResolvedValue(undefined);
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: writeTextSpy },
    configurable: true,
    writable: true,
  });

  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useReportDialogStore.setState({ dialogOpen: false, activeRoutine: 'pflow' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClipboard !== undefined) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  }
  cleanup();
});

// ---- helpers ------------------------------------------------------------

function seedConvergedPflow() {
  usePflowStore.setState({
    lastRun: {
      run_id: parseRunId('pf-run-1'),
      converged: true,
      iterations: 4,
      mismatch: 1e-9,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
      generator_outputs: {},
      load_consumption: {},
    },
    isRunning: false,
    error: null,
  });
}

function seedCompletedTdsRun() {
  useRunsStore.setState({
    activeRunId: 'tds-run-1',
    runs: {
      'tds-run-1': {
        runId: 'tds-run-1',
        startedAt: 0,
        tf: 1.0,
        tCurrent: 1.0,
        seqCount: 100,
        t: new Float64Array([0, 0.5, 1.0]),
        columns: {},
        columnNames: [],
        state: 'done',
        connection: 'connected',
        abortedLocally: false,
        errorReason: null,
      },
    },
  });
}

// ---- <ReportDialogButton /> ---------------------------------------------

describe('<ReportDialogButton />', () => {
  it('is enabled when a session is present', () => {
    render(withQueryClient(<ReportDialogButton />));
    expect(screen.getByTestId('report-dialog-button')).toBeEnabled();
  });

  it('is disabled when no session is present', () => {
    useSessionStore.setState({ sessionId: null });
    render(withQueryClient(<ReportDialogButton />));
    expect(screen.getByTestId('report-dialog-button')).toBeDisabled();
  });

  it('opens the report dialog on click', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<ReportDialogButton />));
    await user.click(screen.getByTestId('report-dialog-button'));
    expect(useReportDialogStore.getState().dialogOpen).toBe(true);
  });
});

// ---- <ReportDialog /> — tabs + empty states -----------------------------

describe('<ReportDialog /> — empty state', () => {
  it('renders the PFlow empty hint when no PF run has happened', async () => {
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));
    expect(await screen.findByTestId('report-dialog')).toBeInTheDocument();
    expect(await screen.findByTestId('report-empty-pflow')).toHaveTextContent(/run pflow first/i);
    // Empty-state path must NOT fire a network call (would 409 anyway).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders the TDS empty hint after switching to the TDS tab pre-run', async () => {
    const user = userEvent.setup();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));
    await user.click(await screen.findByTestId('report-tab-tds'));
    expect(await screen.findByTestId('report-empty-tds')).toHaveTextContent(
      /run a tds simulation first/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---- <ReportDialog /> — happy path --------------------------------------

describe('<ReportDialog /> — happy path', () => {
  it('renders the plain text + structured tables for PFlow when PF has converged', async () => {
    fetchSpy.mockResolvedValue(makeJsonResponse(SAMPLE_REPORT_BODY));
    seedConvergedPflow();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('/api/sessions/test-session-id/report');
    expect(url).toContain('routine=pflow');

    const plain = await screen.findByTestId('report-plain-text-pflow');
    expect(plain).toHaveTextContent('Power flow converged in 4 iterations.');

    expect(await screen.findByTestId('report-structured-table-0')).toHaveTextContent('BUS DATA');
    expect(await screen.findByTestId('report-structured-table-1')).toHaveTextContent('LINE DATA');
  });

  it('LatexCopyButton click writes a tabular block to the clipboard', async () => {
    const user = userEvent.setup();
    // user-event v14 sets navigator.clipboard at setup() — re-install
    // ours after so the button's writeText path lands on the spy.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    fetchSpy.mockResolvedValue(makeJsonResponse(SAMPLE_REPORT_BODY));
    seedConvergedPflow();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));

    await screen.findByTestId('report-plain-text-pflow');
    await user.click(screen.getByTestId('latex-copy-button-pflow'));
    await waitFor(() => expect(writeTextSpy).toHaveBeenCalledTimes(1));
    const payload = writeTextSpy.mock.calls[0]![0];
    expect(payload).toContain('\\begin{tabular}');
    expect(payload).toContain('% BUS DATA');
  });

  it('switching to the TDS tab fires a TDS GET when a run has completed', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('routine=tds')) {
        return Promise.resolve(makeJsonResponse(SAMPLE_TDS_BODY));
      }
      return Promise.resolve(makeJsonResponse(SAMPLE_REPORT_BODY));
    });
    seedConvergedPflow();
    seedCompletedTdsRun();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));

    // Wait for the initial PFlow fetch.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    await user.click(await screen.findByTestId('report-tab-tds'));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('routine=tds'))).toBe(true),
    );

    expect(await screen.findByTestId('report-plain-text-tds')).toHaveTextContent(
      'Final simulation time',
    );
  });
});

// ---- <ReportDialog /> — error path --------------------------------------

describe('<ReportDialog /> — error path', () => {
  it('treats a 409 as the empty state with the substrate detail message', async () => {
    fetchSpy.mockResolvedValue(makeProblemResponse(409, 'Run PFlow first.'));
    seedConvergedPflow();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(await screen.findByTestId('report-empty-pflow')).toHaveTextContent(/run pflow first/i);
  });

  it('renders a role=alert for non-409 errors', async () => {
    fetchSpy.mockResolvedValue(makeProblemResponse(500, 'PFlow.report() raised: disk full'));
    seedConvergedPflow();
    useReportDialogStore.getState().openDialog('pflow');
    render(withQueryClient(<ReportDialog />));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const alert = await screen.findByTestId('report-error-pflow');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(/disk full/i);
  });
});
