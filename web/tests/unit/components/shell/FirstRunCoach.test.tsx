/**
 * Tests for the first-run coach component (Unit 13).
 *
 * Strategy: install a real localStorage shim before each test and
 * ``vi.resetModules()`` so each test starts with a fresh slice
 * bootstrap. The component reads the slice + the case + pflow
 * stores, so we drive the auto-advance scenarios by mutating those
 * slices and asserting on the rendered ``data-step`` attribute.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installLocalStorageShim(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: shim,
  });
  return { store };
}

describe('<FirstRunCoach />', () => {
  let storage: { store: Map<string, string> };

  beforeEach(() => {
    storage = installLocalStorageShim();
    vi.resetModules();
  });

  afterEach(() => {
    storage.store.clear();
  });

  it('renders step 1 by default and exposes data-step="1"', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    render(<FirstRunCoach />);
    const card = screen.getByTestId('first-run-coach');
    expect(card).toBeInTheDocument();
    expect(card.getAttribute('data-step')).toBe('1');
    // Step 1 title is "Pick a case"; the body also contains the
    // phrase, so we anchor on the heading-weight title via getAllByText.
    const matches = screen.getAllByText(/Pick a case/i);
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.getByTestId('first-run-coach-step-indicator')).toHaveTextContent(/step 1 of 3/i);
  });

  it('advances 1 → 2 when the user clicks the CTA', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('1');
    await userEvent.click(screen.getByTestId('first-run-coach-cta'));
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('2');
    expect(screen.getByTestId('first-run-coach-step-indicator')).toHaveTextContent(/step 2 of 3/i);
  });

  it('auto-advances 1 → 2 when a case is loaded', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    const { useCaseStore } = await import('@/store/case');
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('1');
    act(() => {
      useCaseStore.setState({
        // Cast through unknown — the brand is enforced at the parse
        // boundary (parseWorkspacePath) but tests can construct the
        // shape directly without re-running the validator.
        selection: { primaryPath: 'kundur.xlsx' as unknown as never, addfiles: [] },
      });
    });
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('2');
  });

  it('auto-advances 2 → 3 when a converged PF result lands', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    const { useFirstRunStore } = await import('@/store/firstRun');
    const { usePflowStore } = await import('@/store/pflow');
    // Jump to step 2 manually so we can isolate the PF auto-advance.
    act(() => {
      useFirstRunStore.getState().nextStep();
    });
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('2');
    act(() => {
      usePflowStore.setState({
        lastRun: {
          converged: true,
          iterations: 4,
          mismatch: 1e-6,
          bus_voltages: {},
          line_flows: {},
        } as never,
      });
    });
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('3');
  });

  it('clicking × dismisses the coach forever (persists)', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    const { useFirstRunStore } = await import('@/store/firstRun');
    render(<FirstRunCoach />);
    await userEvent.click(screen.getByTestId('first-run-coach-dismiss'));
    expect(screen.queryByTestId('first-run-coach')).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    expect(localStorage.getItem('andes-app:first-run-coach-v1')).toBe('dismissed');
  });

  it('clicking Done on step 3 dismisses and persists', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    const { useFirstRunStore } = await import('@/store/firstRun');
    act(() => {
      useFirstRunStore.getState().nextStep();
      useFirstRunStore.getState().nextStep();
    });
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('3');
    expect(screen.getByTestId('first-run-coach-cta')).toHaveTextContent(/done/i);
    await userEvent.click(screen.getByTestId('first-run-coach-cta'));
    expect(screen.queryByTestId('first-run-coach')).toBeNull();
    expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    expect(localStorage.getItem('andes-app:first-run-coach-v1')).toBe('dismissed');
  });

  it('renders nothing when the persisted dismissal is set on first mount', async () => {
    localStorage.setItem('andes-app:first-run-coach-v1', 'dismissed');
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    render(<FirstRunCoach />);
    expect(screen.queryByTestId('first-run-coach')).toBeNull();
  });

  it('localStorage cleared between mounts → coach re-appears', async () => {
    // First lifecycle: dismiss.
    {
      const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
      const { useFirstRunStore } = await import('@/store/firstRun');
      render(<FirstRunCoach />);
      await userEvent.click(screen.getByTestId('first-run-coach-dismiss'));
      expect(screen.queryByTestId('first-run-coach')).toBeNull();
      expect(useFirstRunStore.getState().coachDismissed).toBe(true);
    }
    // Second lifecycle: clear storage + re-import. The slice's
    // bootstrap reads the now-empty storage and re-arms at step 1.
    localStorage.removeItem('andes-app:first-run-coach-v1');
    vi.resetModules();
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('1');
  });

  it('non-converged PF does not advance step 2', async () => {
    const { FirstRunCoach } = await import('@/components/shell/FirstRunCoach');
    const { useFirstRunStore } = await import('@/store/firstRun');
    const { usePflowStore } = await import('@/store/pflow');
    act(() => {
      useFirstRunStore.getState().nextStep();
    });
    render(<FirstRunCoach />);
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('2');
    act(() => {
      usePflowStore.setState({
        lastRun: {
          converged: false,
          iterations: 30,
          mismatch: 1.0,
          bus_voltages: {},
          line_flows: {},
        } as never,
      });
    });
    expect(screen.getByTestId('first-run-coach').getAttribute('data-step')).toBe('2');
  });
});
