/**
 * Tests for ``<EigSweepPanel />``: the parameter sweep form of the EIG
 * sub-mode (pickers fed from the topology and the alterable-params hook, the
 * linear value list, the cap and inline validation), the root locus plot, its
 * legend and the per-value table of a result, and the error surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EigSweepPanel, sweepValues, valueOpacity } from '@/components/analyze/EigSweepPanel';
import { queryKeys } from '@/api/queries';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useSweepStore } from '@/store/sweep';
import { useJobsStore } from '@/store/jobs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EigSweepResponse, PflowResult, TopologySummary } from '@/api/types';

const SESSION_ID = parseSessionId('sess-1');

// The GENROU idxs are numbers, as a case file read by ANDES holds them; the
// server takes an idx as text.
const TOPOLOGY = {
  state: 'committed',
  buses: [{ idx: 1, name: 'B1', kind: 'Bus', params: {} }],
  lines: [],
  transformers: [],
  generators: [
    { idx: 1, name: 'G1', kind: 'GENROU', params: {} },
    { idx: 2, name: 'G2', kind: 'GENROU', params: {} },
    { idx: 'PV_1', name: 'PV1', kind: 'PV', params: {} },
  ],
  loads: [{ idx: 'PQ_1', name: 'L1', kind: 'PQ', params: {} }],
  shunts: [{ idx: 'SH_1', name: 'S1', kind: 'Shunt', params: {} }],
  controllers: [{ idx: 'EX_1', name: 'E1', kind: 'EXDC2', params: {} }],
} as unknown as TopologySummary;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The topology and the alterable params come from the query cache: seed both
  // so the pickers are fed without a fetch.
  client.setQueryData(queryKeys.topology(SESSION_ID), TOPOLOGY);
  client.setQueryData(queryKeys.alterableParams(SESSION_ID, 'GENROU'), {
    model: 'GENROU',
    params: ['M', 'D', 'ra'],
  });
  client.setQueryData(queryKeys.alterableParams(SESSION_ID, 'PQ'), {
    model: 'PQ',
    params: ['p0', 'q0', 'Ppf'],
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const FAKE_PFLOW_RESULT: PflowResult = {
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-6,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
  generator_outputs: {},
  load_consumption: {},
};

/**
 * Three values, three modes each. Every point has the zero eigenvalue the
 * server returns as exactly ``{0, 0}`` (damping 1). The smallest damping ratio
 * is first at one point and last at another, and only the third point has a
 * mode with a positive real part (and one exactly on the axis).
 */
const SWEEP_RESULT: EigSweepResponse = {
  model: 'GENROU',
  idx: '1',
  param: 'M',
  points: [
    {
      value: 1,
      eigenvalues: [
        { real: -0.2, imag: 3 },
        { real: 0, imag: 0 },
        { real: -1, imag: -2 },
      ],
      damping_ratios: [0.0665, 1, 0.447],
      frequencies_hz: [0.477, 0, 0.318],
    },
    {
      value: 2,
      eigenvalues: [
        { real: -1.5, imag: 0 },
        { real: 0, imag: 0 },
        { real: -0.05, imag: 2.5 },
      ],
      damping_ratios: [1, 1, 0.02],
      frequencies_hz: [0, 0, 0.398],
    },
    {
      value: 3,
      eigenvalues: [
        { real: 0.05, imag: 2 },
        { real: 0, imag: 0 },
        { real: 0, imag: 4 },
      ],
      damping_ratios: [-0.025, 1, 0],
      frequencies_hz: [0.318, 0, 0.637],
    },
  ],
  mode_count: 3,
  tds_initialized: false,
  job_id: null,
};

function resetStores() {
  useAnalyzeStore.setState({ eigSweepResult: null });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useSessionStore.setState({
    sessionId: SESSION_ID,
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
  });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    topology: TOPOLOGY,
  });
  useSweepStore.setState({ sweeps: {}, activeSweepId: null });
  useJobsStore.setState({ jobs: {} });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockSweepAnswer(fetchSpy: MockInstance<typeof fetch>, body: unknown, status = 200) {
  fetchSpy.mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes('/eig/sweep')) return Promise.resolve(jsonResponse(body, status));
    if (url.endsWith('/topology')) return Promise.resolve(jsonResponse(TOPOLOGY, 200));
    return Promise.resolve(jsonResponse({ model: 'GENROU', params: ['M', 'D', 'ra'] }, 200));
  });
}

function sweepCalls(fetchSpy: MockInstance<typeof fetch>) {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/eig/sweep'));
}

function sentBody(fetchSpy: MockInstance<typeof fetch>): unknown {
  const call = sweepCalls(fetchSpy)[0];
  if (call === undefined) throw new Error('no sweep request was sent');
  return JSON.parse(String((call[1] as RequestInit).body));
}

async function fillForm(
  start: string,
  end: string,
  points: string,
  { model = 'GENROU', idx = '1', param = 'M' } = {},
) {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByTestId('eig-sweep-model'), model);
  await user.selectOptions(screen.getByTestId('eig-sweep-idx'), idx);
  await user.selectOptions(screen.getByTestId('eig-sweep-param'), param);
  if (start !== '') await user.type(screen.getByTestId('field-eig-sweep-start'), start);
  if (end !== '') await user.type(screen.getByTestId('field-eig-sweep-end'), end);
  if (points !== '') await user.type(screen.getByTestId('field-eig-sweep-points'), points);
  return user;
}

function optionValues(testId: string): string[] {
  return Array.from((screen.getByTestId(testId) as HTMLSelectElement).options)
    .map((o) => o.value)
    .filter((v) => v !== '');
}

function dot(pointIdx: number, modeIdx: number): Element {
  return screen.getByTestId(`eig-sweep-locus-point-${pointIdx}-${modeIdx}`);
}

describe('sweepValues', () => {
  it('spaces n values evenly from start to end, both included', () => {
    expect(sweepValues(1, 3, 3)).toEqual([1, 2, 3]);
    expect(sweepValues(2, 10, 5)).toEqual([2, 4, 6, 8, 10]);
  });

  it('gives [start] for one point and [start, end] for two', () => {
    expect(sweepValues(4, 9, 1)).toEqual([4]);
    expect(sweepValues(4, 9, 2)).toEqual([4, 9]);
  });

  it('runs downwards for a start above the end, and repeats a start equal to the end', () => {
    expect(sweepValues(3, 1, 3)).toEqual([3, 2, 1]);
    expect(sweepValues(2, 2, 3)).toEqual([2, 2, 2]);
  });

  it('ends on the end exactly, whatever the rounding of the steps', () => {
    const values = sweepValues(0.1, 0.7, 7);
    expect(values).toHaveLength(7);
    expect(values[6]).toBe(0.7);
    expect(values[0]).toBe(0.1);
  });
});

describe('valueOpacity', () => {
  it('grows with the value from 0.25 at the smallest to 1 at the largest', () => {
    expect(valueOpacity(1, 1, 3)).toBe(0.25);
    expect(valueOpacity(2, 1, 3)).toBe(0.625);
    expect(valueOpacity(3, 1, 3)).toBe(1);
  });

  it('draws a sweep of one value at full opacity', () => {
    expect(valueOpacity(5, 5, 5)).toBe(1);
  });
});

describe('<EigSweepPanel />', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    resetStores();
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    mockSweepAnswer(fetchSpy, SWEEP_RESULT);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    resetStores();
  });

  it('renders the disclosure, the labelled fields and the empty state, says no error yet and sends nothing', () => {
    render(withQueryClient(<EigSweepPanel />));
    expect(screen.getByText('Parameter sweep')).toBeInTheDocument();
    for (const name of ['model', 'device (idx)', 'param', 'start', 'end', 'points']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByTestId('eig-sweep-empty')).toHaveTextContent(
      'Run a sweep to see the root locus.',
    );
    expect(document.getElementById('eig-sweep-points-hint')).toHaveTextContent(
      'At most 200 points: each one costs a power flow and an eigenvalue analysis of the case.',
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(sweepCalls(fetchSpy)).toHaveLength(0);
  });

  it('disables Run sweep with the readiness reason of the eigenvalue routine without a power flow', () => {
    render(withQueryClient(<EigSweepPanel />));
    expect(screen.getByTestId('analyze-run-eig-sweep')).toBeDisabled();
    expect(screen.getByTestId('analyze-run-eig-sweep-hint')).toHaveTextContent(
      'Run PFlow first; EIG requires a converged operating point.',
    );
  });

  it('enables Run sweep once a power flow has converged', () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    expect(screen.getByTestId('analyze-run-eig-sweep')).toBeEnabled();
  });

  it('lists every model of the topology, then the devices and the alterable params of the one picked', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EigSweepPanel />));
    expect(optionValues('eig-sweep-model')).toEqual([
      'Bus',
      'EXDC2',
      'GENROU',
      'PQ',
      'PV',
      'Shunt',
    ]);
    expect(screen.getByTestId('eig-sweep-idx')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('eig-sweep-model'), 'GENROU');
    expect(optionValues('eig-sweep-idx')).toEqual(['1', '2']);
    await waitFor(() => expect(optionValues('eig-sweep-param')).toEqual(['M', 'D', 'ra']));

    await user.selectOptions(screen.getByTestId('eig-sweep-idx'), '2');
    await user.selectOptions(screen.getByTestId('eig-sweep-param'), 'D');
    // Another model starts the device and the parameter over.
    await user.selectOptions(screen.getByTestId('eig-sweep-model'), 'PQ');
    expect(screen.getByTestId('eig-sweep-idx')).toHaveValue('');
    expect(screen.getByTestId('eig-sweep-param')).toHaveValue('');
    expect(optionValues('eig-sweep-idx')).toEqual(['PQ_1']);
    await waitFor(() => expect(optionValues('eig-sweep-param')).toEqual(['p0', 'q0', 'Ppf']));
  });

  it('sends the model, the idx as text, the parameter and the linear list of values', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3', { idx: '2' });
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    await waitFor(() => expect(sweepCalls(fetchSpy)).toHaveLength(1));
    expect(String(sweepCalls(fetchSpy)[0]![0])).toBe('/api/sessions/sess-1/eig/sweep');
    expect(sentBody(fetchSpy)).toStrictEqual({
      model: 'GENROU',
      idx: '2',
      param: 'M',
      values: [1, 2, 3],
    });
  });

  it('sends one value for one point and a falling list for a start above the end', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    const first = render(withQueryClient(<EigSweepPanel />));
    let user = await fillForm('2.5', '9', '1');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    await waitFor(() => expect(sweepCalls(fetchSpy)).toHaveLength(1));
    expect((sentBody(fetchSpy) as { values: number[] }).values).toEqual([2.5]);
    first.unmount();

    fetchSpy.mockClear();
    render(withQueryClient(<EigSweepPanel />));
    user = await fillForm('8', '2', '4');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    await waitFor(() => expect(sweepCalls(fetchSpy)).toHaveLength(1));
    expect((sentBody(fetchSpy) as { values: number[] }).values).toEqual([8, 6, 4, 2]);
  });

  it('takes 200 points, the most the server takes', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '200', '200');
    expect(screen.queryByTestId('error-eig-sweep-points')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    await waitFor(() => expect(sweepCalls(fetchSpy)).toHaveLength(1));
    const values = (sentBody(fetchSpy) as { values: number[] }).values;
    expect(values).toHaveLength(200);
    expect(values[199]).toBe(200);
  });

  it('refuses 0, 201, 2.5 and -3 points inline with the cap, and sends nothing', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '');
    const field = screen.getByTestId('field-eig-sweep-points');
    for (const bad of ['0', '201', '2.5', '-3']) {
      await user.clear(field);
      await user.type(field, bad);
      const error = screen.getByTestId('error-eig-sweep-points');
      expect(error).toHaveTextContent('Enter a whole number of points from 1 to 200.');
      expect(error).toHaveAttribute('role', 'alert');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      await user.click(screen.getByTestId('analyze-run-eig-sweep'));
      expect(sweepCalls(fetchSpy)).toHaveLength(0);
    }
  });

  it('refuses a bound that is not a finite number, and sends nothing', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('abc', 'Infinity', '3');
    expect(screen.getByTestId('error-eig-sweep-start')).toHaveTextContent('Enter a finite number.');
    expect(screen.getByTestId('error-eig-sweep-end')).toHaveTextContent('Enter a finite number.');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    expect(sweepCalls(fetchSpy)).toHaveLength(0);
  });

  it('names every missing field once Run is pressed, and sends nothing', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    const user = userEvent.setup();
    render(withQueryClient(<EigSweepPanel />));
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    expect(screen.getByTestId('error-eig-sweep-model')).toHaveTextContent('Choose a model.');
    expect(screen.getByTestId('error-eig-sweep-idx')).toHaveTextContent('Choose a device.');
    expect(screen.getByTestId('error-eig-sweep-param')).toHaveTextContent('Choose a parameter.');
    expect(screen.getByTestId('error-eig-sweep-start')).toHaveTextContent('Enter a number.');
    expect(screen.getByTestId('error-eig-sweep-end')).toHaveTextContent('Enter a number.');
    expect(screen.getByTestId('error-eig-sweep-points')).toHaveTextContent(
      'Enter a whole number of points from 1 to 200.',
    );
    expect(sweepCalls(fetchSpy)).toHaveLength(0);
  });

  it('sends no device of the model picked before, once another model is picked', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3', { idx: '2', param: 'D' });
    await user.selectOptions(screen.getByTestId('eig-sweep-model'), 'PQ');
    await user.selectOptions(screen.getByTestId('eig-sweep-param'), 'p0');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    expect(screen.getByTestId('error-eig-sweep-idx')).toHaveTextContent('Choose a device.');
    expect(sweepCalls(fetchSpy)).toHaveLength(0);
  });

  it('registers the sweep as a job of kind eig for the Activity panel', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    await waitFor(() => expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(1));
    const job = Object.values(useJobsStore.getState().jobs)[0]!;
    expect(job.kind).toBe('eig');
    expect(job.request_summary).toEqual({
      model: 'GENROU',
      idx: '1',
      param: 'M',
      values: [1, 2, 3],
    });
  });

  it('draws one dot per eigenvalue of every point, every one inside the plot', () => {
    useAnalyzeStore.getState().setEigSweepResult(SWEEP_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const dots = screen
      .getByTestId('eig-sweep-locus')
      .querySelectorAll('[data-testid^="eig-sweep-locus-point-"]');
    expect(dots).toHaveLength(9);
    for (const d of Array.from(dots)) {
      const cx = Number(d.getAttribute('cx'));
      const cy = Number(d.getAttribute('cy'));
      // The plot area is 28 px in from each side of the 320 x 240 view box.
      expect(cx).toBeGreaterThanOrEqual(28);
      expect(cx).toBeLessThanOrEqual(292);
      expect(cy).toBeGreaterThanOrEqual(28);
      expect(cy).toBeLessThanOrEqual(212);
    }
    // The farthest dots are not on the edge: the view reaches 10% past them.
    expect(Number(dot(1, 0).getAttribute('cx'))).toBeGreaterThan(28 + 5);
    expect(Number(dot(2, 2).getAttribute('cy'))).toBeGreaterThan(28 + 5);
  });

  it('draws the zero eigenvalue at the origin, where the two axes cross', () => {
    useAnalyzeStore.getState().setEigSweepResult(SWEEP_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const imagAxis = screen.getByTestId('eig-sweep-imag-axis');
    const realAxis = screen.getByTestId('eig-sweep-real-axis');
    for (const pointIdx of [0, 1, 2]) {
      expect(dot(pointIdx, 1).getAttribute('cx')).toBe(imagAxis.getAttribute('x1'));
      expect(dot(pointIdx, 1).getAttribute('cy')).toBe(realAxis.getAttribute('y1'));
    }
    // The imaginary axis is the vertical line at Re = 0, in the middle of the
    // view the scatter fits symmetrically about the origin.
    expect(imagAxis.getAttribute('x1')).toBe('160');
    expect(imagAxis.getAttribute('x2')).toBe('160');
  });

  it('puts an eigenvalue with a positive real part right of the imaginary axis, a negative one left', () => {
    useAnalyzeStore.getState().setEigSweepResult(SWEEP_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    expect(Number(dot(2, 0).getAttribute('cx'))).toBeGreaterThan(160);
    expect(Number(dot(0, 0).getAttribute('cx'))).toBeLessThan(160);
    // A positive imaginary part is drawn above the real axis (smaller y).
    expect(Number(dot(0, 0).getAttribute('cy'))).toBeLessThan(120);
    expect(Number(dot(0, 2).getAttribute('cy'))).toBeGreaterThan(120);
  });

  it('fades the dots from 1 at the largest value to 0.25 at the smallest', () => {
    useAnalyzeStore.getState().setEigSweepResult(SWEEP_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    for (const modeIdx of [0, 1, 2]) {
      expect(dot(0, modeIdx)).toHaveAttribute('opacity', '0.25');
      expect(dot(1, modeIdx)).toHaveAttribute('opacity', '0.625');
      expect(dot(2, modeIdx)).toHaveAttribute('opacity', '1');
    }
  });

  it('keeps the ramp on the value for a sweep that ran downwards', () => {
    useAnalyzeStore.getState().setEigSweepResult({
      ...SWEEP_RESULT,
      points: [...SWEEP_RESULT.points].reverse(),
    });
    render(withQueryClient(<EigSweepPanel />));
    expect(dot(0, 0)).toHaveAttribute('opacity', '1');
    expect(dot(2, 0)).toHaveAttribute('opacity', '0.25');
    expect(screen.getByTestId('eig-sweep-legend-min')).toHaveTextContent('1');
    expect(screen.getByTestId('eig-sweep-legend-max')).toHaveTextContent('3');
  });

  it('names the parameter and the range of values in the legend', () => {
    useAnalyzeStore.getState().setEigSweepResult({ ...SWEEP_RESULT, param: 'D', idx: '4' });
    render(withQueryClient(<EigSweepPanel />));
    expect(screen.getByTestId('eig-sweep-legend-name')).toHaveTextContent('D of GENROU 4');
    expect(screen.getByTestId('eig-sweep-legend-min')).toHaveTextContent(/^1$/);
    expect(screen.getByTestId('eig-sweep-legend-max')).toHaveTextContent(/^3$/);
    // The faint end of the ramp is at the smallest value.
    const legend = screen.getByTestId('eig-sweep-legend');
    const order = Array.from(legend.children).map((c) => c.getAttribute('data-testid'));
    expect(order.indexOf('eig-sweep-legend-min')).toBeLessThan(
      order.indexOf('eig-sweep-legend-ramp'),
    );
    expect(order.indexOf('eig-sweep-legend-ramp')).toBeLessThan(
      order.indexOf('eig-sweep-legend-max'),
    );
    expect(screen.getByRole('img', { name: /Root locus of D of GENROU 4/ })).toBeInTheDocument();
  });

  it('lists per value the unstable modes, not counting the zero eigenvalue, and the smallest damping ratio', () => {
    useAnalyzeStore.getState().setEigSweepResult(SWEEP_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const table = screen.getByTestId('eig-sweep-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const cells = rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent));
    expect(cells).toEqual([
      ['1', '0', '0.0665'],
      ['2', '0', '0.02'],
      ['3', '1', '-0.025'],
    ]);
    expect(within(table).getByRole('columnheader', { name: 'M' })).toBeInTheDocument();
  });

  it('shows the detail of a 422 that names the value at which a point failed', async () => {
    mockSweepAnswer(
      fetchSpy,
      {
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        detail: 'eigenvalue sweep failed at value 2.0 (point 1): the power flow did not converge',
      },
      422,
    );
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    const banner = await screen.findByTestId('eig-sweep-error');
    expect(banner).toHaveTextContent(
      'eigenvalue sweep failed at value 2.0 (point 1): the power flow did not converge',
    );
    expect(screen.getByTestId('eig-sweep-empty')).toBeInTheDocument();
  });

  it('shows the server detail of a parameter it does not take', async () => {
    mockSweepAnswer(
      fetchSpy,
      { type: 'about:blank', title: 'Not Found', status: 404, detail: "PQ has no parameter 'Ppf'" },
      404,
    );
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('0.1', '0.2', '2', { model: 'PQ', idx: 'PQ_1', param: 'Ppf' });
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    expect(await screen.findByTestId('eig-sweep-error')).toHaveTextContent(
      "PQ has no parameter 'Ppf'",
    );
  });

  it('shows the prerequisite banner with the Run power flow recovery on a 409', async () => {
    mockSweepAnswer(
      fetchSpy,
      {
        type: 'about:blank',
        title: 'Prerequisite not met',
        status: 409,
        detail: 'the session has no converged power flow',
        recovery: { kind: 'run-pflow', label: 'Run power flow' },
      },
      409,
    );
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    const banner = await screen.findByTestId('eig-sweep-prerequisite-error');
    expect(banner).toHaveTextContent('the session has no converged power flow');
    expect(within(banner).getByRole('button', { name: /run power flow/i })).toBeInTheDocument();
  });

  it('draws the answer of a run, and the empty state again once the store drops it', async () => {
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    render(withQueryClient(<EigSweepPanel />));
    const user = await fillForm('1', '3', '3');
    await user.click(screen.getByTestId('analyze-run-eig-sweep'));
    expect(await screen.findByTestId('eig-sweep-locus')).toBeInTheDocument();
    act(() => {
      useAnalyzeStore.getState().clearEigSweepResult();
    });
    expect(screen.getByTestId('eig-sweep-empty')).toBeInTheDocument();
  });
});
