/**
 * <DaeVariablePicker />: choosing ANDES variables to record in the next run.
 * The list comes from the substrate; the hook is replaced by a stand-in that
 * records what it was asked for and answers from a fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProblemDetailsError } from '@/api/client';
import type { DaeVariableInfo } from '@/api/types';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { DaeVariablePicker, DAE_PICKER_PAGE_SIZE } from '@/components/tds/DaeVariablePicker';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { DEFAULT_TDS_CONFIG, MAX_TDS_DAE_VARS, useUiStore } from '@/store/ui';

type Answer = {
  data?: { total: number; items: DaeVariableInfo[] };
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  // Set while a fetch that failed is being tried again.
  failureCount?: number;
  failureReason?: Error | null;
};

let answer: Answer;
const asked: { q: string; limit: number }[] = [];

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useDaeVariables: (q: string, limit: number) => {
      asked.push({ q, limit });
      return answer;
    },
  };
});

function variable(name: string, kind: 'x' | 'y' = 'x', extra: Partial<DaeVariableInfo> = {}) {
  const [var_, model, idx] = name.split(' ');
  return { name, kind, model: model!, var: var_!, idx: idx!, ...extra } as DaeVariableInfo;
}

const OMEGAS = [1, 2, 3].map((i) => variable(`omega GENROU ${i}`));

function listing(items: DaeVariableInfo[], total = items.length): Answer {
  return { data: { total, items }, isPending: false, isError: false, error: null };
}

function loadCase() {
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
  });
}

function picked(): readonly string[] {
  return useUiStore.getState().tdsConfig.daeVars;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  asked.length = 0;
  answer = listing(OMEGAS);
  useUiStore.setState({ tdsConfig: { ...DEFAULT_TDS_CONFIG } });
  loadCase();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null });
});

describe('<DaeVariablePicker />', () => {
  it('lists the variables the substrate returns, each with its kind', () => {
    render(<DaeVariablePicker />);

    const results = screen.getByTestId('tds-config-dae-results');
    expect(within(results).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(results).getByText('omega GENROU 2')).toBeInTheDocument();
    expect(within(results).getAllByText('state')).toHaveLength(3);
    expect(screen.getByTestId('tds-config-dae-shown')).toHaveTextContent('3 matches');
  });

  it('says whether a variable is a state or algebraic, and what ANDES says of it, on hover', () => {
    answer = listing([variable('vf GENROU 1', 'y', { info: 'Excitation voltage', unit: 'pu' })]);
    render(<DaeVariablePicker />);

    expect(screen.getByText('algebraic')).toBeInTheDocument();
    expect(screen.getByText('vf GENROU 1').closest('label')).toHaveAttribute(
      'title',
      'Algebraic variable: Excitation voltage, in pu',
    );
  });

  it('asks for the first page with no words, and for what was typed once the typing stops', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DaeVariablePicker />);
    expect(asked.at(-1)).toEqual({ q: '', limit: DAE_PICKER_PAGE_SIZE });

    await user.type(screen.getByTestId('tds-config-dae-search'), 'omega gen');
    // Each keystroke is not a request: the search is sent a moment after the last one.
    expect(asked.every((a) => a.q === '')).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(asked.at(-1)).toEqual({ q: 'omega gen', limit: DAE_PICKER_PAGE_SIZE });
  });

  it('adds a variable to the run when its box is ticked, and takes it off when it is cleared', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DaeVariablePicker />);

    await user.click(screen.getByTestId('tds-config-dae-omega GENROU 2'));
    expect(picked()).toEqual(['omega GENROU 2']);
    await user.click(screen.getByTestId('tds-config-dae-omega GENROU 1'));
    expect(picked()).toEqual(['omega GENROU 2', 'omega GENROU 1']);
    expect(screen.getByTestId('tds-config-dae-count')).toHaveTextContent('2 selected');

    await user.click(screen.getByTestId('tds-config-dae-omega GENROU 2'));
    expect(picked()).toEqual(['omega GENROU 1']);
  });

  it('shows what is picked as chips that take their variable off, and Clear takes all off', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 1', 'vf GENROU 2'] });
    render(<DaeVariablePicker />);

    await user.click(screen.getByRole('button', { name: 'Remove omega GENROU 1' }));
    expect(picked()).toEqual(['vf GENROU 2']);

    await user.click(screen.getByTestId('tds-config-dae-clear'));
    expect(picked()).toEqual([]);
    expect(screen.queryByTestId('tds-config-dae-picked')).toBeNull();
  });

  it('keeps a pick that the current search no longer lists', () => {
    useUiStore.getState().setTdsConfig({ daeVars: ['vf GENROU 2'] });
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-chip-vf GENROU 2')).toBeInTheDocument();
    expect(screen.getByTestId('tds-config-dae-omega GENROU 1')).not.toBeChecked();
  });

  it('ticks the boxes of what is already picked', () => {
    useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 3'] });
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-omega GENROU 3')).toBeChecked();
    expect(screen.getByTestId('tds-config-dae-omega GENROU 1')).not.toBeChecked();
  });

  it('adds every match at once when they are all shown, without repeating a pick', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 2'] });
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-add-shown')).toHaveTextContent('Add all 2');
    await user.click(screen.getByTestId('tds-config-dae-add-shown'));

    expect(picked()).toEqual(['omega GENROU 2', 'omega GENROU 1', 'omega GENROU 3']);
    expect(screen.getByTestId('tds-config-dae-add-shown')).toBeDisabled();
  });

  it('says when more match than are shown, and adds only the ones shown', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    answer = listing(OMEGAS, 120);
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-shown')).toHaveTextContent(
      'Showing 3 of 120. Narrow the search for the rest.',
    );
    expect(screen.getByTestId('tds-config-dae-add-shown')).toHaveTextContent('Add the 3 shown');
    await user.click(screen.getByTestId('tds-config-dae-add-shown'));
    expect(picked()).toHaveLength(3);
  });

  it('stops at the most a run records', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useUiStore.getState().setTdsConfig({
      daeVars: Array.from({ length: MAX_TDS_DAE_VARS }, (_, i) => `omega GENROU ${i + 10}`),
    });
    render(<DaeVariablePicker />);

    expect(screen.getByRole('alert')).toHaveTextContent(`at most ${MAX_TDS_DAE_VARS}`);
    expect(screen.getByTestId('tds-config-dae-add-shown')).toBeDisabled();
    await user.click(screen.getByTestId('tds-config-dae-omega GENROU 1'));
    expect(picked()).toHaveLength(MAX_TDS_DAE_VARS);
  });

  it('says so when nothing matches', () => {
    answer = listing([]);
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent('No variable matches.');
    expect(screen.queryByTestId('tds-config-dae-results')).toBeNull();
  });

  it('says it is loading, before the list arrives', () => {
    answer = { isPending: true, isError: false, error: null };
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent('Loading variables');
  });

  const BUSY = new ProblemDetailsError({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'busy',
  });

  it('says the session is busy while a run streams, and that the list returns after', () => {
    // The list is asked for again for as long as the run refuses it, so the
    // query is loading all the while, with the refusals counted.
    answer = { isPending: true, isError: false, error: null, failureCount: 4, failureReason: BUSY };
    const { rerender } = render(<DaeVariablePicker />);

    const busy = 'The session is busy with a run. The list is back when the run ends.';
    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent(busy);

    // Refused again two seconds on: the same message, not "Loading".
    answer = { ...answer, failureCount: 5 };
    rerender(<DaeVariablePicker />);
    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent(busy);

    // A fetch given up while refused says the same.
    answer = { isPending: false, isError: true, error: BUSY };
    rerender(<DaeVariablePicker />);
    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent(busy);
  });

  it('is still loading through a refusal or two, which another list asked for at once explains', () => {
    answer = { isPending: true, isError: false, error: null, failureCount: 2, failureReason: BUSY };
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent('Loading variables');
  });

  it('shows any other failure as it is', () => {
    answer = { isPending: false, isError: true, error: new Error('network down') };
    render(<DaeVariablePicker />);

    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent(
      'Could not list the variables: network down',
    );
  });

  it('does not ask the substrate without a case, and says to load one', () => {
    useCaseStore.setState({ selection: null });
    render(<DaeVariablePicker />);

    expect(asked).toEqual([]);
    expect(screen.getByTestId('tds-config-dae-status')).toHaveTextContent('Load a case');
    expect(screen.getByTestId('tds-config-dae-search')).toBeDisabled();
  });

  it('does not ask without a session either', () => {
    useSessionStore.setState({ sessionId: null });
    render(<DaeVariablePicker />);

    expect(asked).toEqual([]);
    expect(screen.getByTestId('tds-config-dae-search')).toBeDisabled();
  });

  it('keeps what is picked visible, and removable, when there is no case to list from', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 1'] });
    useCaseStore.setState({ selection: null });
    render(<DaeVariablePicker />);

    await user.click(screen.getByRole('button', { name: 'Remove omega GENROU 1' }));

    expect(picked()).toEqual([]);
  });
});
