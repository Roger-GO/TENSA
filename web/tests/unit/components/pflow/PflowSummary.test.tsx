/**
 * Tests for `<PflowSummary />`: the system totals of the last power flow, and
 * what it says when there are none to show.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PflowSummary } from '@/components/pflow/PflowSummary';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { PflowResult, PflowSettings, PflowSummary as Summary } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import {
  captureDownloads,
  exportAs,
  readBlob,
  type DownloadCapture,
} from '../../helpers/downloads';

const SUMMARY: Summary = {
  generation_p: 226.43,
  generation_q: 49.8,
  load_p: 223.7,
  load_q: 95.4,
  shunt_p: 0,
  shunt_q: -35.33,
  loss_p: 2.73,
  loss_q: -10.27,
  slack_p: 81.43,
  slack_q: -21.62,
};

const SETTINGS: PflowSettings = {
  tolerance: 1e-6,
  max_iterations: 25,
  flat_start: false,
  enforce_q_limits: false,
};

function result(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 3,
    mismatch: 6.96e-12,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    settings: SETTINGS,
    summary: SUMMARY,
    ...overrides,
  };
}

beforeEach(() => {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useCaseStore.setState({ selection: null });
});

afterEach(() => cleanup());

function cell(row: string, column: 0 | 1): string {
  const cells = within(screen.getByTestId(`pflow-summary-row-${row}`)).getAllByRole('cell');
  return cells[column]!.textContent ?? '';
}

describe('<PflowSummary />', () => {
  it('asks for a power flow before there is one', () => {
    render(<PflowSummary />);
    expect(screen.getByTestId('pflow-summary-status')).toHaveTextContent(/run a power flow/i);
    expect(screen.queryByTestId('pflow-summary-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-menu-trigger')).toBeDisabled();
  });

  it('shows generation, load, shunts, losses and the slack, in MW and MVAr', () => {
    usePflowStore.setState({ lastRun: result() });
    render(<PflowSummary />);

    expect(cell('generation', 0)).toBe('226.43');
    expect(cell('generation', 1)).toBe('49.80');
    expect(cell('load', 0)).toBe('223.70');
    expect(cell('load', 1)).toBe('95.40');
    expect(cell('shunt', 0)).toBe('0.00');
    expect(cell('shunt', 1)).toBe('-35.33');
    expect(cell('loss', 0)).toBe('2.73');
    expect(cell('loss', 1)).toBe('-10.27');
    expect(cell('slack', 0)).toBe('81.43');
    expect(cell('slack', 1)).toBe('-21.62');
    expect(screen.getByRole('columnheader', { name: 'P (MW)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Q (MVAr)' })).toBeInTheDocument();
  });

  it('says how the run went and what it ran with', () => {
    usePflowStore.setState({
      lastRun: result({
        iterations: 5,
        settings: { ...SETTINGS, enforce_q_limits: true, flat_start: true },
      }),
    });
    render(<PflowSummary />);
    const status = screen.getByTestId('pflow-summary-status');
    expect(status).toHaveTextContent('Converged in 5 iterations, final mismatch 6.96e-12.');
    expect(screen.getByTestId('pflow-summary-settings')).toHaveTextContent(
      'Ran with tolerance 1e-6, up to 25 iterations, flat start, Q limits enforced.',
    );
  });

  it('states the share the lines lose, and how the figures add up', () => {
    usePflowStore.setState({ lastRun: result() });
    render(<PflowSummary />);
    expect(screen.getByTestId('pflow-summary')).toHaveTextContent(
      /the lines lose 1\.21% of the active generation/,
    );
    expect(screen.getByTestId('pflow-summary')).toHaveTextContent(
      /generation equals load plus bus shunts plus line losses/i,
    );
  });

  it('leaves a dash where the case has no slack in service', () => {
    usePflowStore.setState({
      lastRun: result({ summary: { ...SUMMARY, slack_p: null, slack_q: null } }),
    });
    render(<PflowSummary />);
    expect(cell('slack', 0)).toBe('-');
    expect(cell('slack', 1)).toBe('-');
  });

  it('says there are no totals for a run that did not converge', () => {
    usePflowStore.setState({
      lastRun: result({ converged: false, iterations: 26, summary: null }),
    });
    render(<PflowSummary />);
    expect(screen.getByTestId('pflow-summary-status')).toHaveTextContent(
      /did not converge in 26 iterations/i,
    );
    expect(screen.queryByTestId('pflow-summary-table')).not.toBeInTheDocument();
  });

  it('says so, rather than showing a stale table, for the operating point read after a TDS run', () => {
    // GET /operating-point: converged, but it ran nothing, so no settings or totals.
    usePflowStore.setState({ lastRun: result({ summary: null, settings: null }) });
    render(<PflowSummary />);
    expect(screen.getByTestId('pflow-summary-status')).toHaveTextContent(
      /after a time-domain run/i,
    );
    expect(screen.queryByTestId('pflow-summary-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-summary-settings')).not.toBeInTheDocument();
  });

  it('handles a server that sends no summary field at all', () => {
    const { summary: _summary, settings: _settings, ...bare } = result();
    usePflowStore.setState({ lastRun: bare });
    render(<PflowSummary />);
    expect(screen.queryByTestId('pflow-summary-table')).not.toBeInTheDocument();
  });

  describe('export', () => {
    let downloads: DownloadCapture;
    beforeEach(() => {
      downloads = captureDownloads();
    });
    afterEach(() => downloads.restore());

    it('writes the table as a CSV with the settings in a comment', async () => {
      const user = userEvent.setup();
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
      });
      usePflowStore.setState({ lastRun: result() });
      render(<PflowSummary />);

      await exportAs(user, 'csv');

      expect(downloads.filenames[0]).toMatch(/^ieee14_pf-summary_.*\.csv$/);
      const csv = await readBlob(downloads.blobs[0]!);
      expect(csv).toContain('# Settings: tolerance 1e-6, up to 25 iterations');
      expect(csv).toContain('quantity,P (MW),Q (MVAr)');
      expect(csv).toContain('Generation,226.43,49.8');
      expect(csv).toContain('Bus shunts,0,-35.33');
      expect(csv).toContain('of which slack,81.43,-21.62');
    });
  });
});
