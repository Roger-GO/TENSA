/**
 * The export menus on the Analyze panel's views: the EIG scatter, participation
 * table and damping chart, the CPF curve (nose and QV) and the SE residual
 * chart. Each is driven through its real menu; the PNG rasteriser and the
 * state-matrix download are stubbed, because jsdom can do neither.
 *
 * Coverage:
 * - Which formats each view offers, and no menu while a view is empty.
 * - File names: `{case}_{panel}_{timestamp}.{ext}`, with the case from the store.
 * - CSV content is the result, not what the panel's display filter hides.
 * - The participation CSV is the filtered, sorted table.
 * - PNG rasterises the view's own card; MAT fetches the session's state matrix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const toastWarningMock = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const { elementToPngMock, fetchMatMock } = vi.hoisted(() => ({
  elementToPngMock: vi.fn(),
  fetchMatMock: vi.fn(),
}));
vi.mock('@/components/export/exportToPng', async (importActual) => ({
  ...(await importActual<typeof import('@/components/export/exportToPng')>()),
  elementToPng: elementToPngMock,
}));
vi.mock('@/components/export/exportToMat', () => ({
  fetchEigStateMatrixMat: fetchMatMock,
}));

import { CPFCurveChart } from '@/components/analyze/CPFCurveChart';
import { EIGDampingChart } from '@/components/analyze/EIGDampingChart';
import { EIGParticipationTable } from '@/components/analyze/EIGParticipationTable';
import { EIGScatter } from '@/components/analyze/EIGScatter';
import { SEResidualChart } from '@/components/analyze/SEResidualChart';
import { DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { CpfResult, EigResult, SeResult } from '@/api/types';
import {
  captureDownloads,
  exportAs,
  readBlob,
  type DownloadCapture,
} from '../../helpers/downloads';

const EIG: EigResult = {
  eigenvalues: [
    { real: -0.1, imag: 2.0 }, // poorly damped: shown under the default filter
    { real: -0.5, imag: 0.0 }, // well damped: hidden by it
    { real: -10.0, imag: 1.0 }, // far left: hidden by it
  ],
  damping_ratios: [0.05, 1.0, 0.995],
  frequencies_hz: [0.318, 0, 0.159],
  mode_count: 3,
  state_count: 3,
  state_names: ['delta_1', 'omega_1', 'delta_2'],
  tds_initialized: true,
};

const CPF: CpfResult = {
  lambdas: [0, 0.5, 1],
  voltages_per_bus: { '1': [1.06, 1.05, 1.0], '2': [1.04, 1.02, 0.9] },
  bus_idxes: ['1', '2'],
  nose_idx: 2,
  max_lam: 1,
  truncated: false,
  done_msg: 'Nose point at lambda=1.000000',
  mode: 'pv',
};

const SE: SeResult = {
  converged: true,
  iterations: 3,
  mismatch: 12.345,
  residuals: [0.01, -0.5, 0.02],
  measurement_count: 3,
  flagged_indices: [1],
};

const PARTICIPATION = [
  { state_name: 'omega_2', factor: 0.05 },
  { state_name: 'delta_1', factor: 0.92 },
  { state_name: 'omega_1', factor: 0.41 },
];

let downloads: DownloadCapture;

beforeEach(() => {
  downloads = captureDownloads();
  elementToPngMock.mockReset();
  fetchMatMock.mockReset();
  toastWarningMock.mockReset();
  useAnalyzeStore.setState({
    subMode: 'eig',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
  });
});

afterEach(() => {
  downloads.restore();
  cleanup();
  useCaseStore.setState({ selection: null });
  useSessionStore.setState({ sessionId: null });
});

describe('EIG scatter export', () => {
  it('offers CSV, PNG and MAT', async () => {
    const user = userEvent.setup();
    render(<EIGScatter result={EIG} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-csv')).toBeEnabled();
    expect(screen.getByTestId('export-menu-png')).toBeEnabled();
    expect(screen.getByTestId('export-menu-mat')).toBeEnabled();
  });

  it('has no menu while there is nothing to show', () => {
    render(<EIGScatter result={null} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
  });

  it('exports every mode as CSV, including the ones the display filter hides', async () => {
    const user = userEvent.setup();
    render(<EIGScatter result={EIG} />);
    // The default filter draws one of the three modes.
    expect(screen.getByTestId('eig-scatter').textContent).toMatch(/1 of 3 visible/);
    await exportAs(user, 'csv');
    expect(downloads.filenames).toHaveLength(1);
    expect(downloads.filenames[0]).toMatch(/^ieee14_eig_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    const lines = (await readBlob(downloads.blobs[0]!)).split('\n');
    expect(lines[1]).toBe('mode,real,imag,damping_ratio,frequency_hz');
    expect(lines.slice(2, 5)).toEqual([
      '0,-0.1,2,0.05,0.318',
      '1,-0.5,0,1,0',
      '2,-10,1,0.995,0.159',
    ]);
  });

  it('rasterises its own card for PNG', async () => {
    const user = userEvent.setup();
    elementToPngMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<EIGScatter result={EIG} />);
    await exportAs(user, 'png');
    expect(elementToPngMock).toHaveBeenCalledTimes(1);
    expect(elementToPngMock.mock.calls[0]![0]).toBe(screen.getByTestId('eig-scatter'));
    expect(downloads.filenames[0]).toMatch(/^ieee14_eig_.*\.png$/);
  });

  it('downloads the session state matrix for MAT', async () => {
    const user = userEvent.setup();
    fetchMatMock.mockResolvedValue(new Blob(['MATL'], { type: 'application/octet-stream' }));
    render(<EIGScatter result={EIG} />);
    await exportAs(user, 'mat');
    expect(fetchMatMock).toHaveBeenCalledWith('sess-1');
    expect(downloads.filenames[0]).toMatch(/^ieee14_eig_.*\.mat$/);
  });

  it('exports nothing for MAT when no session is open', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessionId: null });
    render(<EIGScatter result={EIG} />);
    await exportAs(user, 'mat');
    expect(fetchMatMock).not.toHaveBeenCalled();
    expect(downloads.filenames).toHaveLength(0);
    expect(toastWarningMock).toHaveBeenCalledTimes(1);
  });

  it('names a blank system `case`', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
    render(<EIGScatter result={EIG} />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^case_eig_/);
  });
});

describe('EIG participation table export', () => {
  function renderTable(selectedModeId: number | null) {
    useAnalyzeStore.setState({ selectedModeId });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <EIGParticipationTable rows={PARTICIPATION} />
      </QueryClientProvider>,
    );
  }

  it('offers CSV only', async () => {
    const user = userEvent.setup();
    renderTable(3);
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-csv')).toBeEnabled();
    expect(screen.queryByTestId('export-menu-png')).toBeNull();
  });

  it('exports the rows as sorted, and names the mode in the file and in the header', async () => {
    const user = userEvent.setup();
    renderTable(3);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^ieee14_eig-participation-mode-3_.*\.csv$/);
    expect((await readBlob(downloads.blobs[0]!)).split('\n')).toEqual([
      '# participation factors of mode 3',
      'state,factor',
      // The default order is by descending |factor|.
      'delta_1,0.92',
      'omega_1,0.41',
      'omega_2,0.05',
      '',
    ]);
  });

  it('exports only the rows the filter keeps, and says it filtered', async () => {
    const user = userEvent.setup();
    renderTable(3);
    await user.type(screen.getByTestId('participation-filter-input'), 'omega');
    await exportAs(user, 'csv');
    expect((await readBlob(downloads.blobs[0]!)).split('\n')).toEqual([
      '# participation factors of mode 3',
      '# filtered to states matching "omega"',
      'state,factor',
      'omega_1,0.41',
      'omega_2,0.05',
      '',
    ]);
  });

  it('follows the sort the user picked', async () => {
    const user = userEvent.setup();
    renderTable(3);
    // State header: first click sorts ascending by name.
    await user.click(screen.getByTestId('participation-header-state'));
    await exportAs(user, 'csv');
    const lines = (await readBlob(downloads.blobs[0]!)).split('\n');
    expect(lines.slice(2, 5).map((l) => l.split(',')[0])).toEqual([
      'delta_1',
      'omega_1',
      'omega_2',
    ]);
  });

  it('disables the menu when the filter keeps no rows', async () => {
    const user = userEvent.setup();
    renderTable(3);
    await user.type(screen.getByTestId('participation-filter-input'), 'zzz');
    const table = screen.getByTestId('eig-participation-table');
    expect(within(table).getByTestId('export-menu-trigger')).toBeDisabled();
  });
});

describe('EIG damping chart export', () => {
  it('offers PNG only and rasterises its own card', async () => {
    const user = userEvent.setup();
    elementToPngMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<EIGDampingChart result={EIG} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-png')).toBeEnabled();
    expect(screen.queryByTestId('export-menu-csv')).toBeNull();
    await user.click(screen.getByTestId('export-menu-png'));
    expect(elementToPngMock.mock.calls[0]![0]).toBe(screen.getByTestId('eig-damping-chart'));
    expect(downloads.filenames[0]).toMatch(/^ieee14_eig-damping_.*\.png$/);
  });

  it('has no menu while there is nothing to show', () => {
    render(<EIGDampingChart result={null} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
  });
});

describe('CPF curve export', () => {
  it('exports every bus at every step for a PV curve', async () => {
    const user = userEvent.setup();
    // One bus drawn is enough to show the file has them all.
    render(<CPFCurveChart result={CPF} maxVisibleBuses={1} />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^ieee14_cpf-pv_.*\.csv$/);
    const lines = (await readBlob(downloads.blobs[0]!)).split('\n');
    expect(lines.slice(3)).toEqual([
      'lambda,bus_1_v,bus_2_v',
      '0,1.06,1.04',
      '0.5,1.05,1.02',
      '1,1,0.9',
      '',
    ]);
  });

  it('names a QV curve cpf-qv', async () => {
    const user = userEvent.setup();
    const qv: CpfResult = {
      ...CPF,
      lambdas: [0, 2],
      voltages_per_bus: { '5': [1, 0.8] },
      bus_idxes: ['5'],
      nose_idx: 1,
      max_lam: 2,
      mode: 'qv',
    };
    render(<CPFCurveChart result={qv} />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^ieee14_cpf-qv_.*\.csv$/);
  });

  it('rasterises its own card for PNG', async () => {
    const user = userEvent.setup();
    elementToPngMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<CPFCurveChart result={CPF} />);
    await exportAs(user, 'png');
    expect(elementToPngMock.mock.calls[0]![0]).toBe(screen.getByTestId('cpf-curve'));
    expect(downloads.filenames[0]).toMatch(/^ieee14_cpf-pv_.*\.png$/);
  });

  it('has no menu before a run, or for a run with no steps', () => {
    const { rerender } = render(<CPFCurveChart result={null} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
    rerender(<CPFCurveChart result={{ ...CPF, lambdas: [], voltages_per_bus: {} }} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
  });
});

describe('SE residual chart export', () => {
  it('exports each residual with its flag', async () => {
    const user = userEvent.setup();
    render(<SEResidualChart result={SE} />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^ieee14_se-residuals_.*\.csv$/);
    expect((await readBlob(downloads.blobs[0]!)).split('\n').slice(1)).toEqual([
      'measurement,residual,flagged',
      '0,0.01,false',
      '1,-0.5,true',
      '2,0.02,false',
      '',
    ]);
  });

  it('rasterises its own card for PNG', async () => {
    const user = userEvent.setup();
    elementToPngMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<SEResidualChart result={SE} />);
    await exportAs(user, 'png');
    expect(elementToPngMock.mock.calls[0]![0]).toBe(screen.getByTestId('se-residual-chart'));
  });

  it('has no menu before a run, or for a run with no residuals', () => {
    const { rerender } = render(<SEResidualChart result={null} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
    rerender(<SEResidualChart result={{ ...SE, residuals: [], flagged_indices: [] }} />);
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
  });
});
