/**
 * Tests for `<RecoveryActionButton />` (Unit 7).
 *
 * Asserts the routing switch: each `recovery.kind` fires the right side
 * effect via the existing store / query actions (mocked here so a click
 * maps to a single assertable call), and an unknown kind renders the label
 * as plain text with NO side effect.
 *
 * The stores are mocked at module scope so each action is a `vi.fn()` we can
 * assert on without standing up the real Zustand slices; `useReloadCase`
 * (a TanStack mutation) is mocked to expose its `.mutate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---- store / query mocks --------------------------------------------------

const reloadMutateMock = vi.fn();
const setActiveRoutineMock = vi.fn();
const setSubModeMock = vi.fn();
const setActiveBottomDrawerTabMock = vi.fn();
const setBottomDrawerCollapsedMock = vi.fn();
const setLeftSidebarCollapsedMock = vi.fn();
const setActivityPanelCollapsedMock = vi.fn();
const setActivityPanelTabMock = vi.fn();
const setSelectedJobIdMock = vi.fn();

let reloadPending = false;
let sessionIdValue: string | null = 'sess-1';

vi.mock('@/api/queries', () => ({
  useReloadCase: () => ({ mutate: reloadMutateMock, isPending: reloadPending }),
}));

vi.mock('@/store/session', () => ({
  useSessionStore: (selector: (s: { sessionId: string | null }) => unknown) =>
    selector({ sessionId: sessionIdValue }),
}));

vi.mock('@/store/runMode', () => ({
  useRunModeStore: (selector: (s: { setActiveRoutine: typeof setActiveRoutineMock }) => unknown) =>
    selector({ setActiveRoutine: setActiveRoutineMock }),
}));

vi.mock('@/store/analyze', () => ({
  useAnalyzeStore: (selector: (s: { setSubMode: typeof setSubModeMock }) => unknown) =>
    selector({ setSubMode: setSubModeMock }),
}));

vi.mock('@/store/layout', () => ({
  useLayoutStore: (
    selector: (s: {
      setActiveBottomDrawerTab: typeof setActiveBottomDrawerTabMock;
      setBottomDrawerCollapsed: typeof setBottomDrawerCollapsedMock;
      setLeftSidebarCollapsed: typeof setLeftSidebarCollapsedMock;
      setActivityPanelCollapsed: typeof setActivityPanelCollapsedMock;
      setActivityPanelTab: typeof setActivityPanelTabMock;
      setSelectedJobId: typeof setSelectedJobIdMock;
    }) => unknown,
  ) =>
    selector({
      setActiveBottomDrawerTab: setActiveBottomDrawerTabMock,
      setBottomDrawerCollapsed: setBottomDrawerCollapsedMock,
      setLeftSidebarCollapsed: setLeftSidebarCollapsedMock,
      setActivityPanelCollapsed: setActivityPanelCollapsedMock,
      setActivityPanelTab: setActivityPanelTabMock,
      setSelectedJobId: setSelectedJobIdMock,
    }),
}));

import { RecoveryActionButton } from '@/components/error/RecoveryActionButton';
import type { RecoveryDescriptor } from '@/lib/recovery';

function desc(kind: string, label = 'Do it'): RecoveryDescriptor {
  return { kind: kind as RecoveryDescriptor['kind'], label };
}

describe('<RecoveryActionButton />', () => {
  beforeEach(() => {
    reloadPending = false;
    sessionIdValue = 'sess-1';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('recovery=null renders nothing', () => {
    const { container } = render(<RecoveryActionButton recovery={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('kind="none" renders nothing (no CTA)', () => {
    const { container } = render(<RecoveryActionButton recovery={desc('none', 'No action')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reload-case → fires useReloadCase().mutate(sessionId)', async () => {
    render(<RecoveryActionButton recovery={desc('reload-case', 'Reload the case')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(reloadMutateMock).toHaveBeenCalledTimes(1);
    expect(reloadMutateMock).toHaveBeenCalledWith('sess-1');
    // No other route fired.
    expect(setActiveRoutineMock).not.toHaveBeenCalled();
  });

  it('reload-case with no session id → no-op (no mutate)', async () => {
    sessionIdValue = null;
    render(<RecoveryActionButton recovery={desc('reload-case', 'Reload the case')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(reloadMutateMock).not.toHaveBeenCalled();
  });

  it('reload-case while pending → button disabled', () => {
    reloadPending = true;
    render(<RecoveryActionButton recovery={desc('reload-case', 'Reloading…')} />);
    expect(screen.getByTestId('recovery-action')).toBeDisabled();
  });

  it('run-pflow → selects the PF run mode + Analyze PF sub-mode', async () => {
    render(<RecoveryActionButton recovery={desc('run-pflow', 'Run power flow first')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setActiveRoutineMock).toHaveBeenCalledWith('pflow');
    expect(setSubModeMock).toHaveBeenCalledWith('pflow');
    expect(reloadMutateMock).not.toHaveBeenCalled();
  });

  it('open-pf (readiness-only kind) → routes identically to run-pflow', async () => {
    render(<RecoveryActionButton recovery={desc('open-pf', 'Open PF view')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setActiveRoutineMock).toHaveBeenCalledWith('pflow');
    expect(setSubModeMock).toHaveBeenCalledWith('pflow');
  });

  it('retry → fires the onRetry callback', async () => {
    const onRetry = vi.fn();
    render(<RecoveryActionButton recovery={desc('retry', 'Try again')} onRetry={onRetry} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retry with no onRetry → no crash, no other route fired', async () => {
    render(<RecoveryActionButton recovery={desc('retry', 'Try again')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setActiveRoutineMock).not.toHaveBeenCalled();
    expect(reloadMutateMock).not.toHaveBeenCalled();
  });

  it('add-measurements → opens SE sub-mode + analysis drawer', async () => {
    render(<RecoveryActionButton recovery={desc('add-measurements', 'Add more measurements')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setSubModeMock).toHaveBeenCalledWith('se');
    expect(setActiveBottomDrawerTabMock).toHaveBeenCalledWith('analysis');
    expect(setBottomDrawerCollapsedMock).toHaveBeenCalledWith(false);
  });

  it('load-case → reveals the left sidebar (case picker)', async () => {
    render(<RecoveryActionButton recovery={desc('load-case', 'Load a case')} />);
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setLeftSidebarCollapsedMock).toHaveBeenCalledWith(false);
  });

  it('wait-for-job → opens the Activity panel + selects the job', async () => {
    render(
      <RecoveryActionButton
        recovery={desc('wait-for-job', 'Wait for the running operation')}
        jobId="job-42"
      />,
    );
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setActivityPanelCollapsedMock).toHaveBeenCalledWith(false);
    expect(setActivityPanelTabMock).toHaveBeenCalledWith('active');
    expect(setSelectedJobIdMock).toHaveBeenCalledWith('job-42');
  });

  it('wait-for-sweep → opens the Activity panel (no job id → no selection)', async () => {
    render(
      <RecoveryActionButton recovery={desc('wait-for-sweep', 'Wait for the sweep to finish')} />,
    );
    await userEvent.click(screen.getByTestId('recovery-action'));
    expect(setActivityPanelCollapsedMock).toHaveBeenCalledWith(false);
    expect(setActivityPanelTabMock).toHaveBeenCalledWith('active');
    expect(setSelectedJobIdMock).not.toHaveBeenCalled();
  });

  it('uses the descriptor label as the button text', () => {
    render(<RecoveryActionButton recovery={desc('reload-case', 'Reload the case')} />);
    expect(screen.getByTestId('recovery-action')).toHaveTextContent('Reload the case');
  });

  it('unknown kind (forward-compat) → renders label as PLAIN TEXT, no side effect', async () => {
    render(<RecoveryActionButton recovery={desc('teleport-to-mars', 'Teleport to Mars')} />);
    // No button — a span, instead.
    expect(screen.queryByTestId('recovery-action')).not.toBeInTheDocument();
    const text = screen.getByTestId('recovery-action-text');
    expect(text.tagName).toBe('SPAN');
    expect(text).toHaveTextContent('Teleport to Mars');
    // Clicking the plain text fires nothing.
    await userEvent.click(text);
    expect(reloadMutateMock).not.toHaveBeenCalled();
    expect(setActiveRoutineMock).not.toHaveBeenCalled();
    expect(setActivityPanelCollapsedMock).not.toHaveBeenCalled();
  });
});
