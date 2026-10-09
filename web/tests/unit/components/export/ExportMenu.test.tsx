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
import { ExportRefusedError } from '@/components/export/exportError';
import { NetworkError, ProblemDetailsError } from '@/api/client';

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

  it('is called "Export" unless the panel names what it exports', () => {
    const { rerender } = render(<ExportMenu formats={['csv']} panel="time-series" />);
    expect(screen.getByRole('button', { name: 'Export' })).toHaveTextContent('Export');

    // Two menus on one screen get names that tell them apart, in the label and for assistive tech.
    rerender(<ExportMenu formats={['csv']} panel="time-series" label="Export plot" />);
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Export plot' })).toHaveTextContent('Export plot');
  });

  it('says what is in it, after its name and on hover, where its label alone does not', () => {
    const { rerender } = render(
      <ExportMenu
        formats={['png']}
        panel="sld"
        description="a figure of the diagram for a paper (SVG, PDF or PNG), or a PNG of this view"
      />,
    );
    // The word that is shown stays first in what it is called.
    const trigger = screen.getByRole('button', {
      name: 'Export: a figure of the diagram for a paper (SVG, PDF or PNG), or a PNG of this view',
    });
    expect(trigger).toHaveTextContent(/^↓\s*Export$/);
    expect(trigger).toHaveAttribute(
      'title',
      'Export: a figure of the diagram for a paper (SVG, PDF or PNG), or a PNG of this view',
    );
    // Without one it is called by its label alone, and has no tooltip of its own.
    rerender(<ExportMenu formats={['png']} panel="sld" />);
    expect(screen.getByRole('button', { name: 'Export' })).not.toHaveAttribute('title');
  });

  it('lists the other ways out a panel gives it under the formats, and closes when one is picked', async () => {
    const user = userEvent.setup();
    const onFigure = vi.fn();
    const onExportPng = vi.fn(() => new Blob(['x'], { type: 'image/png' }));
    render(
      <ExportMenu
        formats={['png']}
        panel="sld"
        onExportPng={onExportPng}
        extraActions={[
          { id: 'figure', label: 'Figure for a paper (SVG, PDF, PNG)…', onSelect: onFigure },
        ]}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    const menu = await screen.findByTestId('export-menu');
    const buttons = [...menu.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['PNG', 'Figure for a paper (SVG, PDF, PNG)…']);

    await user.click(screen.getByTestId('export-menu-figure'));

    expect(onFigure).toHaveBeenCalledTimes(1);
    // It saves nothing itself: no file, and no notice of one.
    expect(onExportPng).not.toHaveBeenCalled();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('export-menu')).not.toBeInTheDocument());
  });

  it('puts a few words under such an entry on what it leads to', async () => {
    const user = userEvent.setup();
    render(
      <ExportMenu
        formats={['png']}
        panel="sld"
        label="Export figure"
        extraActions={[
          {
            id: 'figure',
            label: 'Figure for a paper…',
            hint: 'The publication look: SVG, PDF or PNG',
            onSelect: () => undefined,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Export figure' }));
    const entry = await screen.findByTestId('export-menu-figure');
    expect(entry).toHaveTextContent('Figure for a paper…');
    expect(entry).toHaveTextContent('The publication look: SVG, PDF or PNG');
  });

  it('lists nothing more than its formats for a panel that gives it no other way out', async () => {
    const user = userEvent.setup();
    render(<ExportMenu formats={['csv', 'png']} panel="time-series" onExportCsv={() => null} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    const menu = await screen.findByTestId('export-menu');
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['CSV', 'PNG']);
  });

  it('names the disabled trigger too', () => {
    render(<ExportMenu formats={['csv']} disabled panel="scrub" label="Export run data" />);
    expect(screen.getByRole('button', { name: 'Export run data' })).toBeDisabled();
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

describe('<ExportMenu /> — MAT and PNG capture', () => {
  it('MAT click runs the handler and downloads a .mat file', async () => {
    const user = userEvent.setup();
    const onExportMat = vi.fn(async () => new Blob(['MATL'], { type: 'application/octet-stream' }));
    render(
      <ExportMenu
        formats={['csv', 'mat']}
        panel="eig"
        caseName="kundur"
        onExportCsv={() => new Blob(['x'])}
        onExportMat={onExportMat}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    const matButton = await screen.findByTestId('export-menu-mat');
    expect(matButton).toBeEnabled();
    await user.click(matButton);
    await waitFor(() => expect(onExportMat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(String(toastSuccessMock.mock.calls[0]![0])).toMatch(/^Exported kundur_eig_.*\.mat$/);
    expect((createObjectUrlMock.mock.calls[0]![0] as Blob).type).toBe('application/octet-stream');
  });

  it('keeps its trigger out of a PNG of the panel that holds it', () => {
    const { rerender } = render(<ExportMenu formats={['png']} panel="p" onExportPng={vi.fn()} />);
    expect(screen.getByTestId('export-menu-trigger')).toHaveAttribute('data-export-ignore');
    rerender(<ExportMenu formats={['png']} panel="p" disabled />);
    expect(screen.getByTestId('export-menu-trigger')).toHaveAttribute('data-export-ignore');
    expect(screen.getByTestId('export-menu-disabled')).toHaveAttribute('data-export-ignore');
  });
});

describe('<ExportMenu /> — COMTRADE', () => {
  it('is offered only where the panel asks for it, and waits for its handler', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ExportMenu
        formats={['csv', 'comtrade']}
        panel="scrub"
        onExportCsv={() => new Blob(['x'])}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    const button = await screen.findByTestId('export-menu-comtrade');
    expect(button).toHaveTextContent('COMTRADE (.zip)');
    expect(button).toBeDisabled();

    rerender(<ExportMenu formats={['csv']} panel="scrub" onExportCsv={() => new Blob(['x'])} />);
    expect(screen.queryByTestId('export-menu-comtrade')).toBeNull();
  });

  it('says on hover that the download is a record of two files', async () => {
    const user = userEvent.setup();
    render(<ExportMenu formats={['comtrade']} panel="scrub" onExportComtrade={vi.fn()} />);
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.hover(await screen.findByTestId('export-menu-comtrade'));
    expect(
      (await screen.findAllByText(/IEEE C37\.111 record of the run: a \.cfg and an ASCII \.dat/))
        .length,
    ).toBeGreaterThan(0);
  });

  it('downloads the record as a .zip whose name says it is a COMTRADE record', async () => {
    const user = userEvent.setup();
    const onExportComtrade = vi.fn(async () => new Blob(['PK'], { type: 'application/zip' }));
    render(
      <ExportMenu
        formats={['csv', 'comtrade']}
        panel="scrub"
        caseName="ieee14"
        runId="abcd1234ef"
        onExportCsv={() => new Blob(['x'])}
        onExportComtrade={onExportComtrade}
      />,
    );
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-comtrade'));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(onExportComtrade).toHaveBeenCalledTimes(1);
    expect(String(toastSuccessMock.mock.calls[0]![0])).toMatch(
      /^Exported ieee14_abcd1234_scrub-comtrade_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/,
    );
    expect((createObjectUrlMock.mock.calls[0]![0] as Blob).type).toBe('application/zip');
    // The other formats keep their own names.
    await user.click(screen.getByTestId('export-menu-trigger'));
    await user.click(await screen.findByTestId('export-menu-csv'));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(2));
    expect(String(toastSuccessMock.mock.calls[1]![0])).toMatch(
      /^Exported ieee14_abcd1234_scrub_.*\.csv$/,
    );
  });

  it('gives the reason of an export that was refused, without blaming the browser', async () => {
    const user = userEvent.setup();
    const refusals: Error[] = [
      new ExportRefusedError('7,500,000 values, and one COMTRADE export takes at most 5,000,000.'),
      new ProblemDetailsError({
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        detail: 't must not decrease',
        instance: null,
      }),
      new NetworkError('Network error on POST /api/comtrade', new TypeError('Failed to fetch')),
    ];
    const onExportComtrade = vi.fn(async () => {
      throw refusals.shift()!;
    });
    render(<ExportMenu formats={['comtrade']} panel="scrub" onExportComtrade={onExportComtrade} />);

    // A failed export leaves the menu open on its formats, to try again.
    await user.click(screen.getByTestId('export-menu-trigger'));
    for (const description of [
      '7,500,000 values, and one COMTRADE export takes at most 5,000,000.',
      'Unprocessable Content: t must not decrease',
      'Network error on POST /api/comtrade',
    ]) {
      toastErrorMock.mockReset();
      await user.click(await screen.findByTestId('export-menu-comtrade'));
      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith('Export failed', { description }),
      );
      await waitFor(() => expect(screen.getByTestId('export-menu-comtrade')).toBeEnabled());
    }
    expect(createObjectUrlMock).not.toHaveBeenCalled();
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
