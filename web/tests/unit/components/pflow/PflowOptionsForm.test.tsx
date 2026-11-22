/**
 * Tests for `<PflowOptionsForm />`: the settings of the next power flow.
 *
 * What is pinned: what a field commits to the options store (and what it does
 * not, when the text is not a valid value), that the form follows the store when
 * something else changes it (a retry on the non-convergence banner, a case change),
 * and that its Run PF button sends the options the form holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { PflowOptionsForm } from '@/components/pflow/PflowOptionsForm';
import { DEFAULT_PFLOW_OPTIONS } from '@/lib/pflowOptions';
import { makeQueryClient } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useSessionStore } from '@/store/session';
import type { EngineCapabilities, EngineList } from '@/api/types';

function siennaEngines(): EngineList {
  const sienna: EngineCapabilities = {
    name: 'sienna',
    available: true,
    unavailable_reason: null,
    versions: {},
    formats: { read: ['psse-raw'], write: [] },
    routines: ['matrices', 'pflow', 'eig', 'tds'],
    routine_options: { pflow: { methods: ['ac', 'dc', 'ptdf-dc'] } },
    ops: ['network_matrix'],
    editing: false,
  };
  return { engines: [sienna] };
}

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

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  usePflowOptionsStore.getState().resetForNewCase();
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useSessionStore.setState({ sessionId: null, engine: null, engines: null });
  useCaseStore.setState({ selection: null, loadingPath: null });
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
});

describe('<PflowOptionsForm /> fields', () => {
  it('starts blank, with ANDES’s defaults as placeholders and the switches at ANDES’s own', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(field('pflow-tolerance')).toHaveValue('');
    expect(field('pflow-tolerance')).toHaveAttribute('placeholder', '1e-6');
    expect(field('pflow-max-iterations')).toHaveValue('');
    expect(field('pflow-max-iterations')).toHaveAttribute('placeholder', '25');
    expect(screen.getByTestId('pflow-flat-start')).not.toBeChecked();
    expect(screen.getByTestId('pflow-enforce-q-limits')).not.toBeChecked();
    expect(screen.getByTestId('pflow-method-default')).toBeChecked();
    expect(screen.getByTestId('pflow-method-nr')).not.toBeChecked();
    expect(screen.getByTestId('pflow-method-dishonest')).not.toBeChecked();
    expect(screen.getByTestId('pflow-method-nk')).not.toBeChecked();
    expect(field('pflow-n-factorize')).toHaveValue('');
    expect(field('pflow-n-factorize')).toHaveAttribute('placeholder', '4');
    // Untouched, a switch shows ANDES's own, and ANDES's line search is on.
    expect(screen.getByTestId('pflow-linesearch')).toBeChecked();
    expect(screen.queryByTestId('pflow-nk-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('pflow-options-reset')).toBeDisabled();
  });

  it('groups the methods under one name, with a legend and the hint', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    const group = screen.getByRole('group', { name: 'Solver method' });
    expect(group).toHaveAttribute('aria-describedby', 'pflow-method-hint');
    expect(document.getElementById('pflow-method-hint')).toHaveTextContent(/ANDES: NR/);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    for (const radio of radios) expect(radio).toHaveAttribute('name', 'pflow-method');
    expect(screen.getByRole('radio', { name: /Dishonest Newton-Raphson/ })).toHaveAttribute(
      'value',
      'dishonest',
    );
  });

  it('moves between the methods with the arrow keys, as a radio group does', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-method-nr'));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('pflow-method-dishonest')).toHaveFocus();
    expect(usePflowOptionsStore.getState().options.method).toBe('dishonest');
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

  it('commits a chosen solver method to the store, and the default choice clears it', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('pflow-method-dishonest'));
    expect(usePflowOptionsStore.getState().options.method).toBe('dishonest');

    await user.click(screen.getByTestId('pflow-method-default'));
    expect(usePflowOptionsStore.getState().options.method).toBeNull();
  });

  it('commits a typed refactorisation count to the store', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.type(field('pflow-n-factorize'), '10');
    expect(usePflowOptionsStore.getState().options.nFactorize).toBe(10);
    expect(screen.queryByTestId('error-pflow-n-factorize')).not.toBeInTheDocument();

    await user.clear(field('pflow-n-factorize'));
    expect(usePflowOptionsStore.getState().options.nFactorize).toBeNull();
  });

  it.each(['2.5', '0'])(
    'says what is wrong with a refactorisation count of %s, and does not send it',
    async (text) => {
      const user = userEvent.setup();
      render(<PflowOptionsForm />, { wrapper: Wrapper });

      await user.type(field('pflow-n-factorize'), text);

      const error = screen.getByTestId('error-pflow-n-factorize');
      expect(error).toHaveTextContent(/1 to 100/);
      expect(error).toHaveTextContent(/case's own count is used/i);
      expect(field('pflow-n-factorize')).toHaveAttribute('aria-invalid', 'true');
      expect(usePflowOptionsStore.getState().options.nFactorize).toBeNull();
    },
  );

  it('commits the line-search checkbox either way', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    // Shown on (ANDES's own), so the first click turns it off.
    await user.click(screen.getByTestId('pflow-linesearch'));
    expect(usePflowOptionsStore.getState().options.linesearch).toBe(false);
    expect(screen.getByTestId('pflow-linesearch')).not.toBeChecked();

    await user.click(screen.getByTestId('pflow-linesearch'));
    expect(usePflowOptionsStore.getState().options.linesearch).toBe(true);
    expect(screen.getByTestId('pflow-linesearch')).toBeChecked();
  });

  it('under Newton-Krylov says that tolerance, iterations and line search do not apply', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('pflow-method-nk'));

    const note = screen.getByTestId('pflow-nk-note');
    expect(note).toHaveTextContent(/tolerance, iteration limit and line search do not apply/i);
    expect(note).toHaveTextContent(/0 iterations/i);
    expect(document.getElementById('pflow-tolerance-hint')).toHaveTextContent(
      /does not apply under Newton-Krylov/i,
    );
    expect(document.getElementById('pflow-max-iterations-hint')).toHaveTextContent(
      /does not apply under Newton-Krylov/i,
    );
    expect(screen.getByTestId('pflow-linesearch').parentElement).toHaveTextContent(
      /does not apply under Newton-Krylov/i,
    );

    expect(screen.getByRole('group', { name: 'Solver method' })).toHaveAttribute(
      'aria-describedby',
      'pflow-method-hint pflow-nk-note',
    );

    await user.click(screen.getByTestId('pflow-method-nr'));
    expect(screen.queryByTestId('pflow-nk-note')).not.toBeInTheDocument();
    expect(document.getElementById('pflow-tolerance-hint')).not.toHaveTextContent(/Newton-Krylov/i);

    await user.click(screen.getByTestId('pflow-method-dishonest'));
    expect(screen.queryByTestId('pflow-nk-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('pflow-linesearch').parentElement).not.toHaveTextContent(
      /Newton-Krylov/i,
    );
  });

  it('lists the methods the session’s engine publishes, with their labels', () => {
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('pflow-method-ac')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'AC power flow' })).toHaveAttribute('value', 'ac');
    expect(screen.getByRole('radio', { name: 'DC power flow' })).toHaveAttribute('value', 'dc');
    expect(
      screen.getByRole('radio', { name: 'DC power flow from the PTDF matrix' }),
    ).toHaveAttribute('value', 'ptdf-dc');
    expect(screen.queryByTestId('pflow-method-nr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-method-dishonest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-method-nk')).not.toBeInTheDocument();
    // The default radio stays, so the case's own setting can be kept.
    expect(screen.getByTestId('pflow-method-default')).toBeChecked();
  });

  it('falls back to the ANDES list while the engines list has not arrived', () => {
    useSessionStore.setState({ engine: 'sienna', engines: null });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('pflow-method-nr')).toBeInTheDocument();
    expect(screen.getByTestId('pflow-method-dishonest')).toBeInTheDocument();
    expect(screen.getByTestId('pflow-method-nk')).toBeInTheDocument();
  });

  it('commits a DC method to the store', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-method-dc'));
    expect(usePflowOptionsStore.getState().options.method).toBe('dc');
  });

  it('under a DC method disables tolerance and iterations with the note, and keeps their values', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.type(field('pflow-tolerance'), '1e-4');
    await user.click(screen.getByTestId('pflow-method-dc'));

    expect(screen.getByTestId('pflow-dc-note')).toHaveTextContent(
      'A DC power flow is solved directly; it has no tolerance or iteration limit.',
    );
    expect(screen.queryByTestId('pflow-nk-note')).not.toBeInTheDocument();
    expect(document.getElementById('pflow-tolerance-hint')).toHaveTextContent(
      /does not apply under a DC method/i,
    );
    expect(document.getElementById('pflow-max-iterations-hint')).toHaveTextContent(
      /does not apply under a DC method/i,
    );
    expect(field('pflow-tolerance')).toBeDisabled();
    expect(field('pflow-max-iterations')).toBeDisabled();
    // Set for when the user switches back.
    expect(field('pflow-tolerance')).toHaveValue('1e-4');
    expect(usePflowOptionsStore.getState().options.tolerance).toBe(1e-4);
    expect(screen.getByRole('group', { name: 'Solver method' })).toHaveAttribute(
      'aria-describedby',
      'pflow-method-hint pflow-dc-note',
    );

    await user.click(screen.getByTestId('pflow-method-ac'));
    expect(screen.queryByTestId('pflow-dc-note')).not.toBeInTheDocument();
    expect(field('pflow-tolerance')).toBeEnabled();
  });

  it('hides the ANDES-only options on a Sienna session', () => {
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.queryByTestId('field-pflow-n-factorize')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-flat-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-enforce-q-limits')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pflow-linesearch')).not.toBeInTheDocument();
  });

  it('shows the ANDES-only options on an ANDES session', () => {
    useSessionStore.setState({ engine: 'andes' });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('field-pflow-n-factorize')).toBeInTheDocument();
    expect(screen.getByTestId('pflow-flat-start')).toBeInTheDocument();
    expect(screen.getByTestId('pflow-enforce-q-limits')).toBeInTheDocument();
    expect(screen.getByTestId('pflow-linesearch')).toBeInTheDocument();
  });

  it('Reset clears a DC method back to the case’s own', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-method-dc'));
    expect(screen.getByTestId('pflow-options-reset')).toBeEnabled();

    await user.click(screen.getByTestId('pflow-options-reset'));

    expect(usePflowOptionsStore.getState().options.method).toBeNull();
    expect(screen.getByTestId('pflow-method-default')).toBeChecked();
    expect(screen.queryByTestId('pflow-dc-note')).not.toBeInTheDocument();
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

  it('follows a solver change made elsewhere', () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    act(() => {
      usePflowOptionsStore.getState().setOptions({ method: 'NK', nFactorize: 20 });
    });
    expect(screen.getByTestId('pflow-method-nk')).toBeChecked();
    expect(field('pflow-n-factorize')).toHaveValue('20');
    expect(screen.getByTestId('pflow-nk-note')).toBeInTheDocument();
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
      flatStart: null,
      enforceQLimits: null,
      method: null,
      nFactorize: null,
      linesearch: null,
    });
  });

  it('Reset blanks the solver settings too', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-method-dishonest'));
    await user.type(field('pflow-n-factorize'), '10');
    await user.click(screen.getByTestId('pflow-linesearch'));
    expect(screen.getByTestId('pflow-linesearch')).not.toBeChecked();

    await user.click(screen.getByTestId('pflow-options-reset'));

    expect(field('pflow-n-factorize')).toHaveValue('');
    expect(screen.getByTestId('pflow-method-default')).toBeChecked();
    // Back to the case's own, which the box shows as ANDES's: on.
    expect(screen.getByTestId('pflow-linesearch')).toBeChecked();
    expect(screen.getByTestId('pflow-options-reset')).toBeDisabled();
    expect(usePflowOptionsStore.getState().options).toEqual({
      ...DEFAULT_PFLOW_OPTIONS,
      method: null,
      nFactorize: null,
      linesearch: null,
    });
  });

  it('Reset clears a refactorisation count that was refused', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    // A refused value stays as typed when the field loses focus.
    await user.type(field('pflow-n-factorize'), '0');
    expect(screen.getByTestId('pflow-options-reset')).toBeEnabled();

    await user.click(screen.getByTestId('pflow-options-reset'));

    expect(field('pflow-n-factorize')).toHaveValue('');
    expect(screen.queryByTestId('error-pflow-n-factorize')).not.toBeInTheDocument();
    expect(screen.getByTestId('pflow-options-reset')).toBeDisabled();
  });

  it('Reset is offered for a solver setting alone', async () => {
    const user = userEvent.setup();
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-linesearch'));
    expect(screen.getByTestId('pflow-options-reset')).toBeEnabled();
  });
});

describe('<PflowOptionsForm /> a case that sets the switches itself', () => {
  it('shows a switch the case turns on as ticked, and says so', () => {
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true, flatStart: false });
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    expect(screen.getByTestId('pflow-enforce-q-limits')).toBeChecked();
    expect(screen.getByTestId('pflow-enforce-q-limits-case-note')).toHaveTextContent(
      /case itself turns this on/i,
    );
    expect(screen.getByTestId('pflow-flat-start')).not.toBeChecked();
    expect(screen.queryByTestId('pflow-flat-start-case-note')).not.toBeInTheDocument();
    // Nothing was chosen: the form still sends nothing and has nothing to reset.
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBeNull();
    expect(screen.getByTestId('pflow-options-reset')).toBeDisabled();
  });

  it('unticking it commits an explicit off, which a run then sends', async () => {
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
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });
    render(<PflowOptionsForm />, { wrapper: Wrapper });

    await user.click(screen.getByTestId('pflow-enforce-q-limits'));

    expect(screen.getByTestId('pflow-enforce-q-limits')).not.toBeChecked();
    expect(screen.getByTestId('pflow-enforce-q-limits-case-note')).toHaveTextContent(
      /go without it while this is unticked/i,
    );
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(false);
    await user.click(screen.getByTestId('pflow-options-run'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enforce_q_limits: false });
  });

  it('goes back to showing the case’s own after Reset', async () => {
    const user = userEvent.setup();
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('pflow-enforce-q-limits'));
    expect(screen.getByTestId('pflow-enforce-q-limits')).not.toBeChecked();

    await user.click(screen.getByTestId('pflow-options-reset'));

    expect(screen.getByTestId('pflow-enforce-q-limits')).toBeChecked();
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBeNull();
  });

  it("tells that a time-domain run that solves the power flow itself keeps the case's own settings", () => {
    render(<PflowOptionsForm />, { wrapper: Wrapper });
    expect(screen.getByTestId('pflow-options-form')).toHaveTextContent(
      /run PF first.*uses the case's own settings/i,
    );
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

  it('sends an empty body when nothing was touched', async () => {
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

    await user.click(screen.getByTestId('pflow-options-run'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('sends the solver settings the form holds', async () => {
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
    await user.click(screen.getByTestId('pflow-method-dishonest'));
    await user.type(field('pflow-n-factorize'), '10');
    await user.click(screen.getByTestId('pflow-linesearch'));

    await user.click(screen.getByTestId('pflow-options-run'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The line search was shown on and unticked: an explicit off is sent.
    expect(JSON.parse(String(init.body))).toEqual({
      method: 'dishonest',
      n_factorize: 10,
      linesearch: false,
    });
  });

  it('under a DC method sends the method and leaves the tolerance and the limit out', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({
      sessionId: parseSessionId('sess-1'),
      engine: 'sienna',
      engines: siennaEngines(),
    });
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
    await user.click(screen.getByTestId('pflow-method-dc'));

    await user.click(screen.getByTestId('pflow-options-run'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ method: 'dc' });
  });

  it('under Newton-Krylov still sends a typed tolerance and limit; the server ignores them', async () => {
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
    await user.click(screen.getByTestId('pflow-method-nk'));
    await user.type(field('pflow-tolerance'), '1e-8');
    await user.type(field('pflow-max-iterations'), '40');

    await user.click(screen.getByTestId('pflow-options-run'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      method: 'NK',
      tolerance: 1e-8,
      max_iterations: 40,
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
