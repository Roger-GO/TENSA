/**
 * <ExternalResultsDialog />: the source picker, the file chooser, the import
 * mutation, the series checkboxes with their axis selectors, the inline error
 * line, and the traces written to the store on "Add to plot".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseMutationResult } from '@tanstack/react-query';
import { ExternalResultsDialog } from '@/components/plots/ExternalResultsDialog';
import type { ExternalResultsResponse, ImportExternalResultsVars } from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useExternalOverlaysStore } from '@/store/externalOverlays';

const mutateSpy = vi.hoisted(() => vi.fn());
let mutationState: Pick<
  UseMutationResult<ExternalResultsResponse, Error, ImportExternalResultsVars>,
  'isPending'
>;

vi.mock('@/api/queries', () => ({
  useImportExternalResults: () => ({
    mutate: mutateSpy,
    isPending: mutationState.isPending,
  }),
}));

const RESPONSE: ExternalResultsResponse = {
  source: 'tsat',
  samples: 100,
  series: [
    { name: 'column 1', t: [0.2, 0, 0.1], y: [3, 1, null] },
    { name: 'column 2', t: [0.2, 0, 0.1], y: [30, 10, 20] },
  ],
};

function openDialog() {
  useExternalOverlaysStore.setState({ traces: [], dialogOpen: true });
  return render(<ExternalResultsDialog />);
}

function pickFile(name = 'export.xlsx') {
  const file = new File(['xlsx'], name);
  fireEvent.change(screen.getByTestId('external-results-file'), { target: { files: [file] } });
  return file;
}

/**
 * Drive a successful import: answer the mutation's onSuccess with ``RESPONSE``.
 * The callback sets the dialog's state, so it runs inside ``act`` for the
 * choose phase to be on screen when the helper returns.
 */
async function importSuccessfully(response: ExternalResultsResponse = RESPONSE) {
  const file = pickFile();
  await userEvent.setup().click(screen.getByTestId('external-results-import'));
  const [, options] = mutateSpy.mock.calls.at(-1)! as [
    ImportExternalResultsVars,
    { onSuccess: (data: ExternalResultsResponse) => void },
  ];
  await act(async () => {
    options.onSuccess(response);
  });
  return file;
}

describe('ExternalResultsDialog', () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    mutationState = { isPending: false };
    useExternalOverlaysStore.setState({ traces: [], dialogOpen: false });
  });

  afterEach(() => {
    cleanup();
    useExternalOverlaysStore.setState({ traces: [], dialogOpen: false });
  });

  it('renders the source radios (TSAT checked), the file input and a disabled Import', () => {
    openDialog();
    expect(screen.getByText('Import external result')).toBeInTheDocument();
    expect(screen.getByTestId('external-results-source-tsat')).toBeChecked();
    expect(screen.getByTestId('external-results-source-psse')).not.toBeChecked();
    expect(screen.getByTestId('external-results-file')).toBeInTheDocument();
    expect(screen.getByTestId('external-results-import')).toBeDisabled();
  });

  it('enables Import once a file is picked and sends {source, file} on click', async () => {
    const user = userEvent.setup();
    openDialog();
    const file = pickFile();
    expect(screen.getByTestId('external-results-import')).toBeEnabled();

    await user.click(screen.getByTestId('external-results-import'));

    expect(mutateSpy).toHaveBeenCalledWith(
      { source: 'tsat', file },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('sends source psse when PSS/E is picked first', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(screen.getByTestId('external-results-source-psse'));
    const file = pickFile();

    await user.click(screen.getByTestId('external-results-import'));

    expect(mutateSpy).toHaveBeenCalledWith(
      { source: 'psse', file },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('shows the sample count and a checked checkbox per series after the import', async () => {
    openDialog();
    await importSuccessfully();

    expect(
      screen.getByText('The file holds 100 samples in 2 series. Pick the series to plot.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('external-results-series-column 1')).toBeChecked();
    expect(screen.getByTestId('external-results-series-column 2')).toBeChecked();
    expect(screen.getByTestId('external-results-axis-column 1')).toHaveValue('left');
    expect(screen.getByTestId('external-results-axis-column 2')).toHaveValue('left');
  });

  it('disables "Add to plot" when every series is unchecked', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();
    expect(screen.getByTestId('external-results-add')).toBeEnabled();

    await user.click(screen.getByTestId('external-results-series-column 1'));
    await user.click(screen.getByTestId('external-results-series-column 2'));

    expect(screen.getByTestId('external-results-add')).toBeDisabled();
  });

  it('writes the checked series as traces on "Add to plot", sorted, nulls as NaN, and closes', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();

    await user.click(screen.getByTestId('external-results-add'));

    const traces = useExternalOverlaysStore.getState().traces;
    expect(traces.map((t) => t.id)).toEqual(['tsat:column 1', 'tsat:column 2']);
    const first = traces[0]!;
    expect(first.label).toBe('tsat: column 1');
    expect(first.axis).toBe('left');
    // The export's order (0.2, 0, 0.1) is sorted, y kept paired, null as NaN.
    expect(Array.from(first.t)).toEqual([0, 0.1, 0.2]);
    expect(first.y[0]).toBe(1);
    expect(Number.isNaN(first.y[1]!)).toBe(true);
    expect(first.y[2]).toBe(3);
    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(false);
  });

  it('keeps samples of one time in the order the export gave them', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully({
      source: 'psse',
      samples: 4,
      series: [{ name: 'column 1', t: [0.1, 0, 0.1, 0.05], y: [7, 1, 8, null] }],
    });

    await user.click(screen.getByTestId('external-results-add'));

    const [trace] = useExternalOverlaysStore.getState().traces;
    expect(trace!.id).toBe('psse:column 1');
    expect(trace!.label).toBe('psse: column 1');
    expect(Array.from(trace!.t)).toEqual([0, 0.05, 0.1, 0.1]);
    expect(Array.from(trace!.y)).toEqual([1, NaN, 7, 8]);
  });

  it('asks for a new import when another file is picked after one was read', async () => {
    openDialog();
    await importSuccessfully();
    expect(screen.getByTestId('external-results-add')).toBeInTheDocument();

    const other = pickFile('other.xlsx');

    expect(screen.queryByTestId('external-results-add')).toBeNull();
    expect(screen.queryByTestId('external-results-series-list')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('external-results-import'));
    expect(mutateSpy.mock.calls.at(-1)![0]).toEqual({ source: 'tsat', file: other });
  });

  it('names each axis selector for its series', async () => {
    openDialog();
    await importSuccessfully();

    expect(screen.getByRole('combobox', { name: 'Axis of column 2' })).toBe(
      screen.getByTestId('external-results-axis-column 2'),
    );
  });

  it('stores the axis a series is given', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();
    await user.selectOptions(screen.getByTestId('external-results-axis-column 2'), 'right');

    await user.click(screen.getByTestId('external-results-add'));

    const traces = useExternalOverlaysStore.getState().traces;
    expect(traces.find((t) => t.id === 'tsat:column 2')?.axis).toBe('right');
    expect(traces.find((t) => t.id === 'tsat:column 1')?.axis).toBe('left');
  });

  it('adds only the checked series', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();
    await user.click(screen.getByTestId('external-results-series-column 2'));

    await user.click(screen.getByTestId('external-results-add'));

    expect(useExternalOverlaysStore.getState().traces.map((t) => t.id)).toEqual(['tsat:column 1']);
  });

  it('shows the server detail of a refusal inline, in role="alert"', async () => {
    const user = userEvent.setup();
    openDialog();
    pickFile();
    await user.click(screen.getByTestId('external-results-import'));
    const [, options] = mutateSpy.mock.calls.at(-1)! as [
      ImportExternalResultsVars,
      { onError: (err: Error) => void },
    ];
    await act(async () => {
      options.onError(
        new ProblemDetailsError({
          type: 'about:blank',
          title: 'Content Too Large',
          status: 413,
          detail: 'the export exceeds 32 MiB',
          instance: null,
        }),
      );
    });

    const alert = screen.getByTestId('external-results-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('the export exceeds 32 MiB');
    // Back on the pick phase: the Import button is there again.
    expect(screen.getByTestId('external-results-import')).toBeEnabled();
  });

  it('shows the message of a non-problem error inline', async () => {
    const user = userEvent.setup();
    openDialog();
    pickFile();
    await user.click(screen.getByTestId('external-results-import'));
    const [, options] = mutateSpy.mock.calls.at(-1)! as [
      ImportExternalResultsVars,
      { onError: (err: Error) => void },
    ];
    await act(async () => {
      options.onError(new Error('Network error on POST /api/external-results?source=tsat'));
    });

    expect(screen.getByTestId('external-results-error')).toHaveTextContent(
      'Network error on POST /api/external-results?source=tsat',
    );
  });

  it('starts fresh when it is opened again (LazyMount unmounts it on close)', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();
    await user.click(screen.getByTestId('external-results-add'));
    cleanup();

    openDialog();

    expect(screen.getByTestId('external-results-source-tsat')).toBeChecked();
    expect(screen.getByTestId('external-results-import')).toBeDisabled();
    expect(screen.queryByTestId('external-results-error')).toBeNull();
    expect(screen.queryByTestId('external-results-series-list')).toBeNull();
  });

  it('upserts a trace imported twice under the same id', async () => {
    const user = userEvent.setup();
    openDialog();
    await importSuccessfully();
    await user.click(screen.getByTestId('external-results-add'));
    cleanup();

    openDialog();
    await importSuccessfully();
    await user.click(screen.getByTestId('external-results-add'));

    expect(
      useExternalOverlaysStore.getState().traces.filter((t) => t.id === 'tsat:column 1'),
    ).toHaveLength(1);
  });
});
