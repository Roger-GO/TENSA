/**
 * The Messages tab: what it lists, how the levels and the filter narrow it, what
 * Copy and Clear do, and what it says when there is nothing to list.
 *
 * The store is filled directly; the server calls (`pullMessages`,
 * `clearSessionMessages`) are mocked, since ``sessionMessages.test.tsx`` covers them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionMessage, SessionMessages } from '@/api/types';
import { parseSessionId } from '@/api/types';

const api = vi.hoisted(() => ({
  pullMessages: vi.fn(async () => undefined),
  clearSessionMessages: vi.fn(async () => true),
}));
vi.mock('@/api/useSessionMessages', () => api);

// The note about generators past a limit reads the violation report (a query over the
// topology), the run's readiness and the run action; each is stood in for here.
const power = vi.hoisted(() => ({
  report: null as import('@/lib/violations').ViolationReport | null,
  readiness: { ready: true, disabledReason: null as string | null },
  run: vi.fn(),
}));
vi.mock('@/lib/useViolationReport', () => ({ useViolationReport: () => power.report }));
vi.mock('@/lib/useRunReadiness', () => ({
  useRunReadiness: () => ({ ...power.readiness, recovery: null }),
}));
vi.mock('@/lib/usePflowRunAction', () => ({ usePflowRunAction: () => power.run }));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { MessagesPanel } from '@/components/messages/MessagesPanel';
import { collectViolations } from '@/lib/violations';
import { useLayoutStore } from '@/store/layout';
import { DEFAULT_SHOWN_LEVELS, useMessagesStore } from '@/store/messages';
import { usePflowStore } from '@/store/pflow';
import { DEFAULT_PFLOW_OPTIONS } from '@/lib/pflowOptions';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useSessionStore } from '@/store/session';
import { LIMITS_TOPOLOGY, limitsPflow } from '../../helpers/limitsCase';

function message(overrides: Partial<SessionMessage> & { seq: number }): SessionMessage {
  return {
    time: new Date(2026, 9, 5, 14, 3, 2).getTime() / 1000,
    level: 'info',
    logger: 'andes.routines.pflow',
    source: 'run_pflow',
    text: `message ${overrides.seq}`,
    repeat: 1,
    ...overrides,
  };
}

function fill(messages: SessionMessage[], overrides: Partial<SessionMessages> = {}): void {
  const last = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
  useMessagesStore.getState().receive('sess-1', {
    messages,
    first_seq: messages.length > 0 ? messages[0]!.seq : 1,
    last_seq: last,
    next_after: last,
    dropped: 0,
    ...overrides,
  });
}

const SAMPLE = [
  message({
    seq: 1,
    level: 'info',
    text: 'Parsing input file "ieee14.raw"...',
    source: 'load_case',
  }),
  message({ seq: 2, level: 'info', text: 'Converged in 6 iterations' }),
  message({
    seq: 3,
    level: 'warning',
    text: 'PV.qlim: adjusted limit <lower>\n| Idx | Input |\n| 4   | 1.2   |',
    source: 'run_tds',
    logger: 'andes.core.discrete',
  }),
  message({ seq: 4, level: 'error', text: 'Power flow failed after 25 iterations' }),
];

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('message-row');
}

function shownTexts(): string[] {
  return rows().map((row) => within(row).getByTestId('message-text').textContent ?? '');
}

beforeEach(() => {
  api.pullMessages.mockClear();
  api.clearSessionMessages.mockClear().mockResolvedValue(true);
  Object.values(toastMock).forEach((fn) => fn.mockClear());
  useMessagesStore.getState().reset();
  useMessagesStore.setState({ shownLevels: DEFAULT_SHOWN_LEVELS, query: '' });
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
  power.report = null;
  power.readiness = { ready: true, disabledReason: null };
  power.run.mockClear();
  usePflowStore.getState().clearPflow();
  usePflowOptionsStore.getState().resetForNewCase();
});

afterEach(() => {
  cleanup();
  useMessagesStore.getState().reset();
  useSessionStore.setState({ sessionId: null });
  usePflowStore.getState().clearPflow();
  usePflowOptionsStore.getState().resetForNewCase();
});

describe('<MessagesPanel /> the list', () => {
  it('lists warnings and errors, and keeps the information messages out of the way', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);

    expect(rows().map((row) => row.getAttribute('data-level'))).toEqual(['warning', 'error']);
    expect(shownTexts()[1]).toBe('Power flow failed after 25 iterations');
  });

  it('gives each message its time, its level, and the command that was running', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);

    const [warning, error] = rows() as [HTMLElement, HTMLElement];
    expect(warning).toHaveTextContent('14:03:02');
    expect(warning).toHaveTextContent('Warning');
    expect(within(warning).getByTestId('message-source')).toHaveTextContent('Time domain');
    expect(within(warning).getByTestId('message-source')).toHaveAttribute(
      'title',
      'andes.core.discrete',
    );
    expect(error).toHaveTextContent('Error');
    expect(within(error).getByTestId('message-source')).toHaveTextContent('Power flow');
  });

  it('keeps the lines of a table, in a monospace block that wraps', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);

    const text = within(rows()[0]!).getByTestId('message-text');
    expect(text.textContent).toBe(
      'PV.qlim: adjusted limit <lower>\n| Idx | Input |\n| 4   | 1.2   |',
    );
    expect(text.className).toContain('whitespace-pre-wrap');
    expect(screen.getByTestId('messages-list').className).toContain('font-mono');
  });

  it('says how often a message repeated, and only when it did', () => {
    fill([
      message({ seq: 1, level: 'warning', text: 'once' }),
      message({ seq: 2, level: 'warning', text: 'again and again', repeat: 12 }),
    ]);
    render(<MessagesPanel />);

    const [once, repeated] = rows() as [HTMLElement, HTMLElement];
    expect(within(once).queryByTestId('message-repeat')).not.toBeInTheDocument();
    expect(within(repeated).getByTestId('message-repeat')).toHaveTextContent('×12');
  });

  it('is a log region that does not announce every message that arrives', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);
    const list = screen.getByRole('log', { name: 'Messages from ANDES' });
    expect(list).toHaveAttribute('aria-live', 'off');
  });

  it('shows messages that arrive after it was drawn', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);
    expect(rows()).toHaveLength(2);

    act(() => {
      fill([message({ seq: 5, level: 'warning', text: 'a late one' })], { first_seq: 1 });
    });
    // The store adds it after what it holds, so the panel follows without a reload.
    expect(shownTexts().at(-1)).toBe('a late one');
  });
});

describe('<MessagesPanel /> scrolling', () => {
  /** jsdom lays nothing out: give the list a size and a place so the panel can read it. */
  function sizeTheList(scrollTop: number): HTMLElement {
    const list = screen.getByTestId('messages-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: scrollTop,
    });
    fireEvent.scroll(list);
    return list;
  }

  const arrive = () =>
    act(() => {
      fill([message({ seq: 5, level: 'warning', text: 'a late one' })], { first_seq: 1 });
    });

  it('follows the newest message while it is scrolled to the end', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);
    const list = sizeTheList(800);

    arrive();

    expect(list.scrollTop).toBe(1000);
  });

  it('leaves the reader where they are when they have scrolled up', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);
    const list = sizeTheList(100);

    arrive();

    expect(list.scrollTop).toBe(100);
  });
});

describe('<MessagesPanel /> levels', () => {
  it('counts each level on its toggle, whether it is shown or not', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);

    expect(screen.getByTestId('messages-level-error-count')).toHaveTextContent('1');
    expect(screen.getByTestId('messages-level-warning-count')).toHaveTextContent('1');
    expect(screen.getByTestId('messages-level-info-count')).toHaveTextContent('2');
    expect(screen.getByTestId('messages-level-info')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('messages-level-error')).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds the information messages when their toggle is turned on, in the order they came', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-level-info'));

    expect(screen.getByTestId('messages-level-info')).toHaveAttribute('aria-pressed', 'true');
    expect(rows().map((row) => row.getAttribute('data-seq'))).toEqual(['1', '2', '3', '4']);
  });

  it('hides a level when its toggle is turned off', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-level-error'));

    expect(rows().map((row) => row.getAttribute('data-level'))).toEqual(['warning']);
  });

  it('keeps the choice when the tab is closed and opened again', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    const { unmount } = render(<MessagesPanel />);
    await user.click(screen.getByTestId('messages-level-info'));
    unmount();

    render(<MessagesPanel />);
    expect(rows()).toHaveLength(4);
  });
});

describe('<MessagesPanel /> the filter', () => {
  it('narrows the list to the messages that hold every word typed', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    useMessagesStore.getState().setLevelShown('info', true);
    render(<MessagesPanel />);

    await user.type(screen.getByTestId('messages-filter'), 'power flow');

    // The error holds both words; the info message "Converged" is from the power flow
    // command but lacks "flow" in its text, and the label of its command does hold it.
    expect(rows().map((row) => row.getAttribute('data-seq'))).toEqual(['2', '4']);
    expect(screen.getByTestId('messages-filter-count')).toHaveTextContent('2 shown');
  });

  it('says so when nothing matches, and Esc clears the filter', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);
    const box = screen.getByTestId('messages-filter');

    await user.type(box, 'nothing like this');
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('No message matches the filter')).toBeInTheDocument();

    await user.type(box, '{Escape}');
    expect(box).toHaveValue('');
    expect(rows()).toHaveLength(2);
  });

  it('has a button that clears it', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);
    await user.type(screen.getByTestId('messages-filter'), 'failed');
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByTestId('messages-filter-clear'));
    expect(rows()).toHaveLength(2);
  });

  it('is not offered while there is nothing to filter', () => {
    render(<MessagesPanel />);
    expect(screen.queryByTestId('messages-filter')).not.toBeInTheDocument();
  });
});

describe('<MessagesPanel /> copy and clear', () => {
  it('copies the messages on show as text', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-copy'));

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain(
      'WARNING  Time domain  PV.qlim: adjusted limit <lower>\n| Idx | Input |',
    );
    expect(text).toContain('ERROR  Power flow  Power flow failed after 25 iterations');
    // Only what is on show: the information messages are hidden.
    expect(text).not.toContain('Converged');
    expect(toastMock.success).toHaveBeenCalledWith('Copied 2 messages.');
  });

  it('says so when the browser will not copy', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-copy'));

    expect(toastMock.error).toHaveBeenCalledWith('The browser did not let the messages be copied.');
  });

  it('asks the server to forget the messages, the hidden ones too', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-clear'));

    expect(api.clearSessionMessages).toHaveBeenCalledWith('sess-1');
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('says so when the messages could not be cleared', async () => {
    const user = userEvent.setup();
    api.clearSessionMessages.mockResolvedValue(false);
    fill(SAMPLE);
    render(<MessagesPanel />);

    await user.click(screen.getByTestId('messages-clear'));

    expect(toastMock.error).toHaveBeenCalledWith('The messages could not be cleared.');
  });

  it('offers neither with nothing to copy or clear', () => {
    render(<MessagesPanel />);
    expect(screen.getByTestId('messages-copy')).toBeDisabled();
    expect(screen.getByTestId('messages-clear')).toBeDisabled();
  });

  it('can still clear when the filter hides everything', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);
    await user.type(screen.getByTestId('messages-filter'), 'zzz');

    expect(screen.getByTestId('messages-copy')).toBeDisabled();
    expect(screen.getByTestId('messages-clear')).toBeEnabled();
  });
});

describe('<MessagesPanel /> when there is nothing to list', () => {
  it('says there is no session before one exists', () => {
    useSessionStore.setState({ sessionId: null });
    render(<MessagesPanel />);
    expect(screen.getByText('No session yet')).toBeInTheDocument();
    expect(api.pullMessages).not.toHaveBeenCalled();
  });

  it('says ANDES has not said anything yet', () => {
    render(<MessagesPanel />);
    expect(screen.getByText('ANDES has not said anything yet')).toBeInTheDocument();
  });

  it('says there are no warnings or errors when only information was logged, and offers it', async () => {
    const user = userEvent.setup();
    fill([message({ seq: 1 }), message({ seq: 2 })]);
    render(<MessagesPanel />);

    expect(screen.getByText('No warnings or errors')).toBeInTheDocument();
    expect(screen.getByText('2 information messages are hidden.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show information messages' }));
    expect(rows()).toHaveLength(2);
  });

  it('says it in the singular for one hidden message', () => {
    fill([message({ seq: 1 })]);
    render(<MessagesPanel />);
    expect(screen.getByText('1 information message is hidden.')).toBeInTheDocument();
  });

  it('says so when every level is turned off', async () => {
    const user = userEvent.setup();
    fill(SAMPLE);
    render(<MessagesPanel />);
    await user.click(screen.getByTestId('messages-level-warning'));
    await user.click(screen.getByTestId('messages-level-error'));

    expect(screen.getByText('Nothing at the levels shown')).toBeInTheDocument();
  });
});

describe('<MessagesPanel /> the log it reads', () => {
  it('reads the log when it opens, so it is current whatever the sync did before', () => {
    render(<MessagesPanel />);
    expect(api.pullMessages).toHaveBeenCalledWith('sess-1');
  });

  it('says how many older messages the server dropped', () => {
    fill(SAMPLE, { dropped: 37 });
    render(<MessagesPanel />);
    expect(screen.getByTestId('messages-hint')).toHaveTextContent(
      '37 older messages were dropped.',
    );
  });

  it('says nothing about dropped messages when none were', () => {
    fill(SAMPLE);
    render(<MessagesPanel />);
    expect(screen.getByTestId('messages-hint')).toHaveTextContent('');
  });
});

describe('<MessagesPanel /> generators past a limit that no warning names', () => {
  /** A converged power flow with one generator past its qmax, run with or without Q limits enforced. */
  function powerFlow(enforceQLimits: boolean, overrides = {}): void {
    const result = limitsPflow({
      settings: {
        tolerance: 1e-6,
        max_iterations: 25,
        flat_start: false,
        enforce_q_limits: enforceQLimits,
      },
      ...overrides,
    });
    usePflowStore.getState().setLastRun(result);
    power.report = collectViolations(result, LIMITS_TOPOLOGY);
  }

  it('explains why there is no warning, and counts the generators', () => {
    fill([message({ seq: 1 })]);
    powerFlow(false);
    render(<MessagesPanel />);

    const note = screen.getByTestId('messages-qlimit-note');
    expect(note).toHaveAccessibleName('Generators past a reactive limit');
    expect(note).toHaveTextContent('1 generator is past a reactive limit (see the Violations tab)');
    expect(note).toHaveTextContent('this power flow did not enforce Q limits');
  });

  it('is not there before a power flow has run', () => {
    fill([message({ seq: 1 })]);
    render(<MessagesPanel />);
    expect(screen.queryByTestId('messages-qlimit-note')).toBeNull();
  });

  it('is not there when the power flow enforced Q limits', () => {
    fill([message({ seq: 1 })]);
    powerFlow(true);
    render(<MessagesPanel />);
    expect(screen.queryByTestId('messages-qlimit-note')).toBeNull();
  });

  it('is not there when no generator is past a limit', () => {
    fill([message({ seq: 1 })]);
    powerFlow(false, { generator_outputs: {} });
    render(<MessagesPanel />);
    expect(screen.queryByTestId('messages-qlimit-note')).toBeNull();
  });

  it('is not there when the power flow did not converge', () => {
    fill([message({ seq: 1 })]);
    powerFlow(false, { converged: false });
    render(<MessagesPanel />);
    expect(screen.queryByTestId('messages-qlimit-note')).toBeNull();
  });

  it('turns Q limits on and runs the power flow from its button', async () => {
    const user = userEvent.setup();
    fill([message({ seq: 1 })]);
    powerFlow(false);
    render(<MessagesPanel />);

    await user.click(screen.getByRole('button', { name: 'Run PF with Q limits enforced' }));
    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(true);
    expect(power.run).toHaveBeenCalledTimes(1);
  });

  it('opens the power flow options from its other button', async () => {
    const user = userEvent.setup();
    fill([message({ seq: 1 })]);
    powerFlow(false);
    useLayoutStore.setState({ activeBottomDrawerTab: 'messages', activeAnalysisSubTab: 'eig' });
    render(<MessagesPanel />);

    await user.click(screen.getByRole('button', { name: 'Power flow options' }));
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('pf');
    expect(usePflowOptionsStore.getState().options).toEqual(DEFAULT_PFLOW_OPTIONS);
  });

  it('says why the run is not available, and does not offer it, while it cannot run', async () => {
    const user = userEvent.setup();
    fill([message({ seq: 1 })]);
    powerFlow(false);
    power.readiness = { ready: false, disabledReason: 'Reset the run before running PF.' };
    render(<MessagesPanel />);

    const run = screen.getByRole('button', { name: 'Run PF with Q limits enforced' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Reset the run before running PF.');
    expect(screen.getByTestId('messages-qlimit-disabled')).toHaveTextContent(
      'Run PF is not available: Reset the run before running PF.',
    );
    await user.click(run);
    expect(power.run).not.toHaveBeenCalled();
  });
});

describe('<MessagesPanel /> what each level holds', () => {
  it('says on the warnings toggle what a warning can be, the Q-limit and impedance notices included', () => {
    render(<MessagesPanel />);
    const title = screen.getByTestId('messages-level-warning').getAttribute('title') ?? '';
    expect(title).toContain('Hide the warnings');
    expect(title).toContain('held at a Q limit');
    expect(title).toContain('constant impedance');
  });
});
