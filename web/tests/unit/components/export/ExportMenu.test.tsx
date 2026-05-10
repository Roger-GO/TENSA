/**
 * Tests for `<ExportMenu />`.
 *
 * Covers:
 *  - Format gating (CSV-only, PNG-only, MAT slot)
 *  - Disabled state with tooltip copy "No data to export"
 *  - Happy path: CSV handler returns Blob → download triggered + success toast
 *  - Error path: handler throws → toast.error fires
 *  - URL.createObjectURL throwing is handled gracefully via toast.error
 *  - Filename composition matches `{case}_{run}_{panel}_{ts}.{ext}`
 *
 * Toast assertions: Unit 3 of the v2.0 polish plan moved transient
 * action results to the global toast surface (`@/lib/toast`). We mock
 * the wrapper here so we can assert on the call shape without mounting
 * the full sonner provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();
const toastInfoMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
    dismiss: vi.fn(),
  },
}));

import { ExportMenu } from '@/components/export/ExportMenu';
import { downloadBlob } from '@/components/export/downloadBlob';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let createObjectUrlMock: ReturnType<typeof vi.fn>;
let revokeObjectUrlMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectUrlMock = vi.fn(() => 'blob:fake-url');
  revokeObjectUrlMock = vi.fn();
  URL.createObjectURL = createObjectUrlMock as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrlMock as unknown as typeof URL.revokeObjectURL;
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastWarningMock.mockReset();
  toastInfoMock.mockReset();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  cleanup();
});

describe('<ExportMenu />', () => {
  it('renders the disabled trigger with tooltip copy when disabled', () => {
    render(<ExportMenu formats={['csv']} disabled panel="time-series" />);
    expect(screen.getByTestId('export-menu-trigger')).toBeDisabled();
    expect(screen.getByTestId('export-menu-disabled')).toBeInTheDocument();
  });

  it('opens the popover and shows only the requested formats', async () => {
    const user = userEvent.setup();
    render(
      <ExportMenu
        formats={['csv', 'png']}
        panel="time-series"
        onExportCsv={() => new Blob(['x'])}
        onExportPng={() => new Blob(['y'])}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu')).toBeInTheDocument();
    expect(screen.getByTestId('export-menu-csv')).toBeInTheDocument();
    expect(screen.getByTestId('export-menu-png')).toBeInTheDocument();
    expect(screen.queryByTestId('export-menu-mat')).toBeNull();
  });

  it('CSV-only: PNG and MAT buttons are absent', async () => {
    const user = userEvent.setup();
    render(<ExportMenu formats={['csv']} panel="scrub" onExportCsv={() => new Blob(['a'])} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-csv')).toBeInTheDocument();
    expect(screen.queryByTestId('export-menu-png')).toBeNull();
    expect(screen.queryByTestId('export-menu-mat')).toBeNull();
  });

  it('happy path: CSV click calls handler and triggers a download', async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn(() => new Blob(['data'], { type: 'text/csv' }));
    render(
      <ExportMenu
        formats={['csv']}
        panel="time-series"
        caseName="ieee14"
        runId="abcd1234ef"
        onExportCsv={onExportCsv}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() => expect(onExportCsv).toHaveBeenCalledTimes(1));
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    // The Blob handed to createObjectURL is the one our handler returned.
    const arg = createObjectUrlMock.mock.calls[0]?.[0] as Blob;
    expect(arg).toBeInstanceOf(Blob);
    expect(arg.type).toBe('text/csv');
  });

  it('handler returning null fires a warning toast (no inline error)', async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn(() => null);
    render(
      <ExportMenu
        formats={['csv']}
        panel="time-series"
        disabledTooltip="No data to export"
        onExportCsv={onExportCsv}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() => expect(onExportCsv).toHaveBeenCalled());
    await waitFor(() => expect(toastWarningMock).toHaveBeenCalledWith('No data to export'));
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    // Inline error UI was retired in Unit 3.
    expect(screen.queryByTestId('export-menu-error')).toBeNull();
  });

  it('createObjectURL throwing fires toast.error with the underlying detail', async () => {
    const user = userEvent.setup();
    createObjectUrlMock.mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const onExportCsv = vi.fn(() => new Blob(['x']));
    render(<ExportMenu formats={['csv']} panel="time-series" onExportCsv={onExportCsv} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Export failed; check browser settings.',
        expect.objectContaining({ description: 'quota exceeded' }),
      ),
    );
  });

  it('handler throwing an exception fires toast.error', async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn(() => {
      throw new Error('serialization failed');
    });
    render(<ExportMenu formats={['csv']} panel="time-series" onExportCsv={onExportCsv} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Export failed; check browser settings.',
        expect.objectContaining({ description: 'serialization failed' }),
      ),
    );
  });

  it('happy path also fires a toast.success with the output filename', async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn(() => new Blob(['data'], { type: 'text/csv' }));
    render(
      <ExportMenu
        formats={['csv']}
        panel="time-series"
        caseName="ieee14"
        onExportCsv={onExportCsv}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() => expect(onExportCsv).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(String(toastSuccessMock.mock.calls[0]![0])).toMatch(/^Exported ieee14_time-series_/);
  });

  it('MAT button has its tooltip copy and respects the absent handler', async () => {
    const user = userEvent.setup();
    render(<ExportMenu formats={['csv', 'mat']} panel="eig" onExportCsv={() => new Blob(['x'])} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    const matButton = await screen.findByTestId('export-menu-mat');
    expect(matButton).toBeDisabled();
  });
});

describe('downloadBlob', () => {
  it('creates an object URL, dispatches a click on a temp anchor, then revokes', async () => {
    vi.useFakeTimers();
    try {
      const blob = new Blob(['x']);
      const clickSpy = vi.fn();
      // jsdom anchor click() doesn't actually navigate; we just observe
      // that .click() was invoked on the anchor we created.
      const origCreateElement = document.createElement.bind(document);
      const createElementSpy = vi
        .spyOn(document, 'createElement')
        .mockImplementation((tag: string) => {
          const el = origCreateElement(tag);
          if (tag === 'a') {
            (el as HTMLAnchorElement).click = clickSpy;
          }
          return el;
        });
      downloadBlob(blob, 'foo.csv');
      expect(createObjectUrlMock).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      // Revoke is scheduled in setTimeout(0) — flush microtasks/timers.
      vi.runAllTimers();
      expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:fake-url');
      createElementSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
