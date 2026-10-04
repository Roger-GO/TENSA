/**
 * Tests for `<PflowOptionsForm />`: the settings of the next power flow.
 *
 * What is pinned: what a field commits to the options store (and what it does
 * not, when the text is not a valid value), that the form follows the store when
 * something else changes it (a retry on the non-convergence banner, a case change),
 * and that its Run PF button sends the options the form holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { PflowOptionsForm } from '@/components/pflow/PflowOptionsForm';
import { makeQueryClient } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useSessionStore } from '@/store/session';

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => makeQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function field(id: string): HTMLInputElement {
  return screen.getByTestId(`field-${id}`) as HTMLInputElement;
}

const CONVERGED = {
  run_id: 'run-9',
  converged: true,
  iterations: 4,
  mismatch: 1e-8,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
    typeof vi.spyOn
  >;
  usePflowOptionsStore.getState().resetOptions();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null, loadingPath: null });
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
});

describe('<PflowOptionsForm /> fields', () => {
  it('starts blank, with ANDES’s defaults as placeholders and nothing ticked', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(field('pflow-tolerance')).toHaveValue('');
    expect(field('pflow-tolerance')).toHaveAttribute('placeholder', '1e-6');
    expect(field('pflow-max-iterations')).toHaveValue('');
    expect(field('pflow-max-iterations')).toHaveAttribute('placeholder', '25');
    expect(screen.getByTestId('pflow-flat-start')).not.toBeChecked();
    expect(screen.getByTestId('pflow-enforce-q-limits')).not.toBeChecked();
    expect(screen.getByTestId('pflow-options-reset')).toBeDisabled();
  });

  it('commits a typed tolerance and iteration limit to the store', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.type(field('pflow-tolerance'), '1e-8');
    await user.type(field('pflow-max-iterations'), '60');

    expect(usePflowOptionsStore.getState().options).toMatchObject({
      tolerance: 1e-8,
      maxIterations: 60,
    });
    expect(screen.queryByTestId('error-pflow-tolerance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-pflow-max-iterations')).not.toBeInTheDocument();
  });

  it('commits the two checkboxes', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('pflow-flat-start'));
    await user.click(screen.getByTestId('pflow-enforce-q-limits'));
    expect(usePflowOptionsStore.getState().options).toMatchObject({
      flatStart: true,
      enforceQLimits: true,
    });

    await user.click(screen.getByTestId('pflow-flat-start'));
    expect(usePflowOptionsStore.getState().options.flatStart).toBe(false);
  });

  it('says what is wrong with a tolerance out of range, and does not send it', async () => {
    const user = userEvent.setup();
    usePflowOptionsStore.getState().setOptions({ tolerance: 1e-4 });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(field('pflow-tolerance')).toHaveValue('1e-4');

    await user.clear(field('pflow-tolerance'));
    await user.type(field('pflow-tolerance'), '0.5');

    const error = screen.getByTestId('error-pflow-tolerance');
    expect(error).toHaveTextContent(/1e-12 to 1e-2/);
    expect(error).toHaveTextContent(/case's own tolerance is used/i);
    expect(field('pflow-tolerance')).toHaveAttribute('aria-invalid', 'true');
    // Not the old 1e-4 and not the bad 0.5: the case's own.
    expect(usePflowOptionsStore.getState().options.tolerance).toBeNull();
  });

  it('says what is wrong with an iteration limit that is not a whole number in range', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.type(field('pflow-max-iterations'), '2.5');
    expect(screen.getByTestId('error-pflow-max-iterations')).toHaveTextContent(/1 to 1000/);
    expect(usePflowOptionsStore.getState().options.maxIterations).toBeNull();

    await user.clear(field('pflow-max-iterations'));
    await user.type(field('pflow-max-iterations'), '2000');
    expect(screen.getByTestId('error-pflow-max-iterations')).toBeInTheDocument();

    await user.clear(field('pflow-max-iterations'));
    await user.type(field('pflow-max-iterations'), '40');
    expect(screen.queryByTestId('error-pflow-max-iterations')).not.toBeInTheDocument();
    expect(usePflowOptionsStore.getState().options.maxIterations).toBe(40);
  });

  it('clearing a field goes back to the case’s own value', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-max-iterations'), '40');
    await user.clear(field('pflow-max-iterations'));
    expect(usePflowOptionsStore.getState().options.maxIterations).toBeNull();
  });

  it('keeps what was typed while focus is in the field, and tidies it on leaving', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-tolerance'), '0.0001');
    expect(field('pflow-tolerance')).toHaveValue('0.0001');
    await user.tab();
    expect(field('pflow-tolerance')).toHaveValue('1e-4');
  });
});

describe('<PflowOptionsForm /> and the store', () => {
  it('follows a change made elsewhere, as a retry on the banner makes', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    act(() => {
      usePflowOptionsStore
        .getState()
        .setOptions({ maxIterations: 50, flatStart: true, tolerance: 1e-5 });
    });
    expect(field('pflow-max-iterations')).toHaveValue('50');
    expect(field('pflow-tolerance')).toHaveValue('1e-5');
    expect(screen.getByTestId('pflow-flat-start')).toBeChecked();
  });

  it('follows a change made elsewhere even after the user typed in the field', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-max-iterations'), '30');
    act(() => usePflowOptionsStore.getState().setOptions({ maxIterations: 100 }));
    expect(field('pflow-max-iterations')).toHaveValue('100');
  });

  it('blanks the fields when the options are reset elsewhere (a case change)', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-tolerance'), '1e-3');
    act(() => usePflowOptionsStore.getState().resetOptions());
    expect(field('pflow-tolerance')).toHaveValue('');
  });

  it('Reset puts the form and the store back to the defaults', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-max-iterations'), '80');
    await user.click(screen.getByTestId('pflow-enforce-q-limits'));
    expect(screen.getByTestId('pflow-options-reset')).toBeEnabled();

    await user.click(screen.getByTestId('pflow-options-reset'));

    expect(field('pflow-max-iterations')).toHaveValue('');
    expect(screen.getByTestId('pflow-enforce-q-limits')).not.toBeChecked();
    expect(usePflowOptionsStore.getState().options).toEqual({
      tolerance: null,
      maxIterations: null,
      flatStart: false,
      enforceQLimits: false,
    });
  });
});

describe('<PflowOptionsForm /> Run PF', () => {
  it('is disabled with the reason while no case is open', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('pflow-options-run')).toBeDisabled();
    expect(screen.getByTestId('pflow-options-run-hint')).toHaveTextContent(/no case loaded/i);
  });

  it('runs a power flow with the options the form holds', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    useCaseStore.getState().setCase({
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    });
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(CONVERGED), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-enforce-q-limits'));
    await user.type(field('pflow-max-iterations'), '40');

    const run = screen.getByTestId('pflow-options-run');
    expect(run).toBeEnabled();
    await user.click(run);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/sess-1\/pflow$/);
    expect(JSON.parse(String(init.body))).toEqual({
      max_iterations: 40,
      enforce_q_limits: true,
    });
  });

  it('is disabled while a power flow is running', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    useCaseStore.getState().setCase({
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    });
    usePflowStore.setState({ isRunning: true });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('pflow-options-run')).toBeDisabled();
    expect(screen.getByTestId('pflow-options-run')).toHaveTextContent('Running PF…');
  });
});
