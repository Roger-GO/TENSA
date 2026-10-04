/**
 * The always-visible "why can't I run this yet" line under an Analyze Run
 * button. It renders the reason `useRunReadiness` gives, with the one-click
 * recovery beside it, and nothing at all once the routine can run. The panel
 * tests reach it through the Analyze buttons; this pins what it does itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RunReadinessNote } from '@/components/analyze/RunReadinessNote';
import { makeQueryClient } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { PflowResult } from '@/api/types';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';

const CONVERGED_PF: PflowResult = {
  converged: true,
  iterations: 3,
  mismatch: 0,
  bus_voltages: { '1': 1.0 },
  bus_angles: { '1': 0 },
} as unknown as PflowResult;

function withQueryClient(node: ReactNode) {
  return <QueryClientProvider client={makeQueryClient()}>{node}</QueryClientProvider>;
}

function resetStores(): void {
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null, loadingPath: null, topology: null });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useAnalyzeStore.setState({ eigResult: null, seMeasurementsCount: null });
  useRunsStore.getState().clearRuns();
}

/** A case is open and the session is live, so only a routine's own prerequisites are left. */
function openCase(): void {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
  });
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

describe('RunReadinessNote', () => {
  it('says why the routine cannot run, under an id and test id derived from the button', () => {
    render(withQueryClient(<RunReadinessNote routine="pflow" testId="analyze-run-pflow" />));

    const note = screen.getByTestId('analyze-run-pflow-hint');
    expect(note).toHaveTextContent('No case loaded.');
    // The Run button names this id in aria-describedby.
    expect(note).toHaveAttribute('id', 'analyze-run-pflow-hint');
    // A reason with nothing to do about it has no action beside it.
    expect(screen.queryByTestId('analyze-run-pflow-hint-action')).not.toBeInTheDocument();
  });

  it('renders nothing once the routine can run', () => {
    openCase();
    const { container } = render(
      withQueryClient(<RunReadinessNote routine="pflow" testId="analyze-run-pflow" />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the routine-specific guidance after the reason, in the same line', () => {
    render(
      withQueryClient(
        <RunReadinessNote
          routine="se"
          testId="analyze-se-run"
          extra={<strong data-testid="note-extra">Then click Run SE.</strong>}
        />,
      ),
    );
    const note = screen.getByTestId('analyze-se-run-hint');
    expect(note).toHaveTextContent('No case loaded.');
    expect(screen.getByTestId('note-extra')).toBeInTheDocument();
    expect(note.textContent).toMatch(/No case loaded\. Then click Run SE\./);
  });

  it('offers the recovery as a button when there is one: Run power flow before EIG', () => {
    openCase();
    render(withQueryClient(<RunReadinessNote routine="eig" testId="analyze-run-eig" />));

    expect(screen.getByTestId('analyze-run-eig-hint')).toHaveTextContent(
      'Run PFlow first; EIG requires a converged operating point.',
    );
    expect(screen.getByTestId('analyze-run-eig-hint-action')).toHaveTextContent('Run power flow');
  });

  it('offers Reset run once a time-domain run has left the model in a dynamic state', () => {
    openCase();
    usePflowStore.setState({ lastRun: CONVERGED_PF });
    useRunsStore.getState().startRun({ runId: 'r1', tf: 5, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().markRunDone('r1', 5, true);

    render(withQueryClient(<RunReadinessNote routine="eig" testId="analyze-run-eig" />));

    expect(screen.getByTestId('analyze-run-eig-hint')).toHaveTextContent(/Reset the run first/);
    expect(screen.getByRole('button', { name: 'Reset run' })).toBeInTheDocument();
  });

  it('follows the stores: the note goes away when the prerequisite is met', () => {
    openCase();
    const { rerender } = render(
      withQueryClient(<RunReadinessNote routine="cpf" testId="analyze-run-cpf" />),
    );
    expect(screen.getByTestId('analyze-run-cpf-hint')).toBeInTheDocument();

    usePflowStore.setState({ lastRun: CONVERGED_PF });
    rerender(withQueryClient(<RunReadinessNote routine="cpf" testId="analyze-run-cpf" />));

    expect(screen.queryByTestId('analyze-run-cpf-hint')).not.toBeInTheDocument();
  });

  it("takes the caller's class name", () => {
    render(
      withQueryClient(
        <RunReadinessNote routine="pflow" testId="analyze-run-pflow" className="mt-2" />,
      ),
    );
    expect(screen.getByTestId('analyze-run-pflow-hint').className).toContain('mt-2');
  });
});
