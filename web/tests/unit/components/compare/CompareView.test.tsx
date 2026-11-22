/**
 * The compare view: its pickers, tolerances, verdict sections and overlay,
 * with the comparison and conversion routes mocked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/queries', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/queries')>();
  return { ...original, useCompareResults: vi.fn() };
});
vi.mock('@/api/queries/compare', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/queries/compare')>();
  return { ...original, convertResult: vi.fn() };
});

import { useCompareResults } from '@/api/queries';
import { convertResult } from '@/api/queries/compare';
import type { CompareResponse } from '@/api/queries/compare';
import { CompareView } from '@/components/compare/CompareView';
import { useCompareViewStore } from '@/store/compareView';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import { useRunsStore } from '@/store/runs';
import { finishedRun } from '../../helpers/runs';

function emptyResponse(overrides: Partial<CompareResponse> = {}): CompareResponse {
  return {
    engine_reference: { name: 'andes', versions: {} },
    engine_comparison: { name: 'andes', versions: {} },
    operating_point_differs: false,
    power_flow: null,
    series: [],
    not_comparable: [],
    unmatched_series_reference: [],
    unmatched_series_comparison: [],
    eigenvalues: [],
    unmatched_eigenvalues_reference: [],
    unmatched_eigenvalues_comparison: [],
    errors: [],
    ...overrides,
  } as CompareResponse;
}

function mockMutation(response: CompareResponse | null = null) {
  const mutate = vi.fn();
  vi.mocked(useCompareResults).mockReturnValue({
    mutate,
    data: response,
    error: null,
    isPending: false,
    isError: false,
    isSuccess: response !== null,
    isIdle: response === null,
  } as unknown as ReturnType<typeof useCompareResults>);
  return mutate;
}

function seedRuns() {
  const r1 = finishedRun('r1', {
    ordinal: 1,
    displayName: 'Base case',
    caseName: 'ieee14',
    engine: 'andes',
    keys: [{ key: 'bus:7', bucket: 'bus', model: 'Bus', idx: 7, source: 'file' }],
  });
  const r2 = finishedRun('r2', {
    ordinal: 2,
    startedAt: 2_000,
    engine: 'andes',
    keys: [{ key: 'bus:7', bucket: 'bus', model: 'Bus', idx: 7, source: 'file' }],
  });
  const r3 = finishedRun('r3', { ordinal: 3, startedAt: 3_000, state: 'streaming' });
  const r4 = finishedRun('r4', { ordinal: 4, startedAt: 4_000 });
  useRunsStore.setState({
    runs: { r1, r2, r3, r4 },
    activeRunId: null,
    overlayRunIds: new Set(),
    runCount: 4,
  });
}

function convertAnswer() {
  return {
    document: {
      tensa_results: 1 as const,
      engine: { name: 'andes' },
      status: 'completed' as const,
      series: [
        { quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0, 0.1, 0.2], y: [1, 0.99, 0.98] },
      ],
    },
    skipped: [],
    notes: [],
  };
}

describe('CompareView', () => {
  beforeEach(() => {
    vi.mocked(convertResult).mockReset().mockResolvedValue(convertAnswer());
    useCompareViewStore.setState({
      open: true,
      referenceSource: null,
      comparisonSource: null,
      quantityTolerances: {},
      frequencyHz: '0.02',
      dampingRatio: '0.02',
      maxModeDistance: '0.05',
      selectedSeriesKey: null,
    });
    useExternalOverlaysStore.setState({ traces: [] });
    seedRuns();
  });

  afterEach(() => {
    cleanup();
    useCompareViewStore.setState({ open: false });
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
  });

  it('renders nothing when closed, and the empty text when open with no sides', () => {
    useCompareViewStore.setState({ open: false });
    mockMutation();
    const { rerender } = render(<CompareView />);
    expect(screen.queryByTestId('compare-view')).toBeNull();

    useCompareViewStore.setState({ open: true });
    rerender(<CompareView />);
    expect(screen.getByTestId('compare-view')).toBeDefined();
    expect(screen.getByTestId('compare-view-empty').textContent).toContain(
      'Pick two results to compare',
    );
  });

  it('lists finished runs newest first, not a streaming one, and disables the other side', () => {
    mockMutation();
    render(<CompareView />);
    const selectA = screen.getByTestId('compare-view-select-a') as HTMLSelectElement;
    const values = [...selectA.options].map((o) => o.value);
    // r3 is streaming and not offered; r1, r2, r4 are finished, newest first.
    expect(values).toEqual(['', 'r4', 'r2', 'r1']);

    fireEvent.change(selectA, { target: { value: 'r2' } });
    const selectB = screen.getByTestId('compare-view-select-b') as HTMLSelectElement;
    const optionR2 = [...selectB.options].find((o) => o.value === 'r2')!;
    expect(optionR2.disabled).toBe(true);
  });

  it('lists a run kept before keys were recorded disabled, with the reason', () => {
    mockMutation();
    render(<CompareView />);
    const selectA = screen.getByTestId('compare-view-select-a') as HTMLSelectElement;
    const optionR4 = [...selectA.options].find((o) => o.value === 'r4')!;
    expect(optionR4.disabled).toBe(true);
    expect(optionR4.title).toBe('Kept before runs recorded their keys; run it again to compare it');
  });

  it('sends a body with only reference and comparison when every tolerance is at its default', async () => {
    const mutate = mockMutation();
    render(<CompareView />);
    fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByTestId('compare-view-select-b'), { target: { value: 'r2' } });
    fireEvent.click(screen.getByTestId('compare-view-run'));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const body = mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['comparison', 'reference']);
  });

  it('sends tolerances.quantities.voltage as a number when it is changed', async () => {
    const mutate = mockMutation();
    render(<CompareView />);
    fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByTestId('compare-view-select-b'), { target: { value: 'r2' } });
    fireEvent.change(screen.getByTestId('compare-view-tol-voltage'), {
      target: { value: '0.002' },
    });
    fireEvent.click(screen.getByTestId('compare-view-run'));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const body = mutate.mock.calls[0]![0] as { tolerances?: { quantities?: { voltage?: number } } };
    expect(body.tolerances?.quantities?.voltage).toBe(0.002);
  });

  it('sends tolerances.frequency_hz and no quantities when only it is changed', async () => {
    const mutate = mockMutation();
    render(<CompareView />);
    fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByTestId('compare-view-select-b'), { target: { value: 'r2' } });
    fireEvent.change(screen.getByTestId('compare-view-tol-frequency-hz'), {
      target: { value: '0.05' },
    });
    fireEvent.click(screen.getByTestId('compare-view-run'));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const body = mutate.mock.calls[0]![0] as { tolerances?: Record<string, unknown> };
    expect(body.tolerances).toEqual({ frequency_hz: 0.05 });
  });

  it.each(['abc', '0'])(
    'refuses %s as a tolerance: inline error, aria-invalid, no request',
    (text) => {
      const mutate = mockMutation();
      render(<CompareView />);
      fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
      fireEvent.change(screen.getByTestId('compare-view-select-b'), { target: { value: 'r2' } });
      fireEvent.change(screen.getByTestId('compare-view-tol-voltage'), { target: { value: text } });

      expect(screen.getByTestId('compare-view-tol-voltage-error').textContent).toBe(
        'Must be a number greater than 0',
      );
      expect(screen.getByTestId('compare-view-tol-voltage').getAttribute('aria-invalid')).toBe(
        'true',
      );
      expect((screen.getByTestId('compare-view-run') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId('compare-view-run'));
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('shows the file error and sends nothing for a file that fails to parse', async () => {
    const mutate = mockMutation();
    render(<CompareView />);
    const file = new File(['not json {'], 'broken.json', { type: 'application/json' });
    const input = screen.getByTestId('compare-view-file-input-a') as HTMLInputElement;
    fireEvent.click(screen.getByTestId('compare-view-file-a'));
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByTestId('compare-view-file-error').textContent).toBe(
        'broken.json is not a JSON file',
      ),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows the operating point verdict: warning, ok, or neither carries a table', () => {
    mockMutation(
      emptyResponse({
        power_flow: {
          converged_reference: true,
          converged_comparison: true,
          rows: [
            {
              quantity: 'voltage',
              key: 'bus:7',
              unit: 'pu',
              reference: 1.0,
              value: 1.05,
              diff: 0.05,
              within_tolerance: false,
              tolerance: 0.001,
            },
          ],
          unmatched: { missing_in_comparison: [], missing_in_reference: [] },
        },
      }),
    );
    const { rerender } = render(<CompareView />);
    expect(screen.getByTestId('compare-view-pflow-warning').textContent).toContain(
      'The two results start from different operating points',
    );

    mockMutation(
      emptyResponse({
        power_flow: {
          converged_reference: true,
          converged_comparison: true,
          rows: [
            {
              quantity: 'voltage',
              key: 'bus:7',
              unit: 'pu',
              reference: 1.0,
              value: 1.0001,
              diff: 0.0001,
              within_tolerance: true,
              tolerance: 0.001,
            },
          ],
          unmatched: { missing_in_comparison: [], missing_in_reference: [] },
        },
      }),
    );
    rerender(<CompareView />);
    expect(screen.getByTestId('compare-view-pflow-ok').textContent).toBe(
      'Same operating point within tolerance.',
    );

    mockMutation(emptyResponse());
    rerender(<CompareView />);
    expect(screen.getByTestId('compare-view-pflow-none').textContent).toContain(
      'Neither result carries a power flow table',
    );
  });

  it('sorts series rows outside-tolerance first, with verdicts and a dash for no tolerance', () => {
    mockMutation(
      emptyResponse({
        series: [
          {
            quantity: 'voltage',
            key: 'bus:1',
            unit: 'pu',
            samples: 3,
            t_start: 0,
            t_end: 0.2,
            max_diff: 0.5,
            max_diff_t: 0.1,
            rms_diff: 0.3,
            swing_ref: 0.2,
            within_tolerance: true,
            tolerance: 1,
          },
          {
            quantity: 'voltage',
            key: 'bus:7',
            unit: 'pu',
            samples: 3,
            t_start: 0,
            t_end: 0.2,
            max_diff: 0.01,
            max_diff_t: 0.1,
            rms_diff: 0.005,
            swing_ref: 0.2,
            within_tolerance: false,
            tolerance: 0.001,
          },
          {
            quantity: 'frequency',
            key: 'sys',
            unit: 'Hz',
            samples: 3,
            t_start: 0,
            t_end: 0.2,
            max_diff: 0.02,
            max_diff_t: 0.1,
            rms_diff: 0.01,
            swing_ref: 0.1,
            within_tolerance: null,
            tolerance: null,
          },
        ],
      }),
    );
    render(<CompareView />);
    const rows = screen
      .getAllByRole('row')
      .filter((el) => el.getAttribute('data-testid')?.startsWith('compare-view-series-grid-row-'));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'compare-view-series-grid-row-voltage|bus:7',
      'compare-view-series-grid-row-voltage|bus:1',
      'compare-view-series-grid-row-frequency|sys',
    ]);
    expect(
      screen.getByTestId('compare-view-series-grid-cell-voltage|bus:7-within').textContent,
    ).toBe('Outside');
    expect(
      screen.getByTestId('compare-view-series-grid-cell-voltage|bus:1-within').textContent,
    ).toBe('Inside');
    expect(
      screen.getByTestId('compare-view-series-grid-cell-frequency|sys-tolerance').textContent,
    ).toBe('—');
    expect(
      screen.getByTestId('compare-view-series-grid-cell-frequency|sys-within').textContent,
    ).toBe('—');
  });

  it('lists unmatched keys, never ignores them', () => {
    mockMutation(emptyResponse({ unmatched_series_reference: ['Bus_9_v'] }));
    render(<CompareView />);
    expect(screen.getByTestId('compare-view-unmatched-series-reference').textContent).toBe(
      'Only in A: Bus_9_v',
    );
  });

  it('renders an eigenvalue pair with both frequencies and dampings side by side', () => {
    mockMutation(
      emptyResponse({
        eigenvalues: [
          {
            index_ref: 0,
            index_new: 2,
            eigenvalue_ref_re: -0.5,
            eigenvalue_ref_im: 7.1,
            eigenvalue_new_re: -0.51,
            eigenvalue_new_im: 7.12,
            distance: 0.022,
            frequency_hz_ref: 1.13,
            frequency_hz_new: 1.133,
            damping_ratio_ref: 0.07,
            damping_ratio_new: 0.071,
            within_tolerance: true,
          },
        ],
      }),
    );
    render(<CompareView />);
    expect(screen.getByTestId('compare-view-eig-grid-cell-0|2-frequency_hz_ref').textContent).toBe(
      '1.130',
    );
    expect(screen.getByTestId('compare-view-eig-grid-cell-0|2-frequency_hz_new').textContent).toBe(
      '1.133',
    );
    expect(screen.getByTestId('compare-view-eig-grid-cell-0|2-damping_ratio_ref').textContent).toBe(
      '0.070',
    );
    expect(screen.getByTestId('compare-view-eig-grid-cell-0|2-damping_ratio_new').textContent).toBe(
      '0.071',
    );
  });

  it('writes two traces to the overlay store on row selection when both sides are runs, and removes them on close', () => {
    mockMutation(
      emptyResponse({
        series: [
          {
            quantity: 'voltage',
            key: 'Bus_1_v',
            unit: 'pu',
            samples: 3,
            t_start: 0,
            t_end: 0.2,
            max_diff: 0.01,
            max_diff_t: 0.1,
            rms_diff: 0.005,
            swing_ref: 0.2,
            within_tolerance: false,
            tolerance: 0.001,
          },
        ],
      }),
    );
    useCompareViewStore.setState({
      referenceSource: { kind: 'run', runId: 'r1' },
      comparisonSource: { kind: 'run', runId: 'r2' },
    });
    render(<CompareView />);
    fireEvent.click(screen.getByTestId('compare-view-series-grid-row-voltage|Bus_1_v'));

    const traces = useExternalOverlaysStore.getState().traces;
    expect(traces.map((t) => t.id).sort()).toEqual(['compare-new', 'compare-ref']);
    expect(traces.find((t) => t.id === 'compare-ref')?.label).toContain('Base case');

    fireEvent.click(screen.getByTestId('compare-view-close'));
    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
    expect(useCompareViewStore.getState().open).toBe(false);
    expect(useCompareViewStore.getState().selectedSeriesKey).toBeNull();
  });

  it('renders the overlay chart instead when a side is a file', () => {
    mockMutation(
      emptyResponse({
        series: [
          {
            quantity: 'voltage',
            key: 'bus:7',
            unit: 'pu',
            samples: 3,
            t_start: 0,
            t_end: 0.2,
            max_diff: 0.01,
            max_diff_t: 0.1,
            rms_diff: 0.005,
            swing_ref: 0.2,
            within_tolerance: false,
            tolerance: 0.001,
          },
        ],
      }),
    );
    const file = new File(
      [
        JSON.stringify({
          tensa_results: 1,
          series: [{ quantity: 'voltage', of: 'bus:7', unit: 'pu', t: [0, 0.1], y: [1, 0.99] }],
        }),
      ],
      'base.json',
    );
    useCompareViewStore.setState({
      referenceSource: { kind: 'file', file },
      comparisonSource: { kind: 'run', runId: 'r2' },
    });
    render(<CompareView />);
    fireEvent.click(screen.getByTestId('compare-view-series-grid-row-voltage|bus:7'));
    expect(screen.getByTestId('compare-view-overlay-chart')).toBeDefined();
    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
  });

  it('swaps the two sides: the next compare sends the previous comparison as reference', async () => {
    const mutate = mockMutation();
    render(<CompareView />);
    fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByTestId('compare-view-select-b'), { target: { value: 'r2' } });
    fireEvent.click(screen.getByTestId('compare-view-swap'));

    expect(useCompareViewStore.getState().referenceSource).toEqual({ kind: 'run', runId: 'r2' });
    expect(useCompareViewStore.getState().comparisonSource).toEqual({ kind: 'run', runId: 'r1' });

    fireEvent.click(screen.getByTestId('compare-view-run'));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    // r2's document is the reference now: convertResult is called per side in
    // order, and the first call's document goes to reference.
    const body = mutate.mock.calls[0]![0] as { reference: unknown; comparison: unknown };
    expect(body.reference).toEqual(convertAnswer().document);
  });

  it('keeps the picked sides and tolerances across a close, with no series selected', () => {
    mockMutation();
    const { rerender } = render(<CompareView />);
    fireEvent.change(screen.getByTestId('compare-view-select-a'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByTestId('compare-view-tol-voltage'), {
      target: { value: '0.002' },
    });
    fireEvent.click(screen.getByTestId('compare-view-close'));

    expect(useCompareViewStore.getState().open).toBe(false);
    rerender(<CompareView />);
    expect(screen.queryByTestId('compare-view')).toBeNull();

    useCompareViewStore.getState().openCompareView();
    rerender(<CompareView />);
    expect(useCompareViewStore.getState().referenceSource).toEqual({ kind: 'run', runId: 'r1' });
    expect((screen.getByTestId('compare-view-tol-voltage') as HTMLInputElement).value).toBe(
      '0.002',
    );
    expect(useCompareViewStore.getState().selectedSeriesKey).toBeNull();
  });
});
