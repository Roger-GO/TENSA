/**
 * Tests for `<ThemeToggle />` (Unit 12 of the v2.0 polish plan).
 *
 * The toggle is a thin shell over the theme slice + ``useTheme`` hook.
 * Tests assert:
 *  - The icon swaps to match the current ``themePreference`` (NOT the
 *    resolved theme — the user always sees what they picked).
 *  - Clicking cycles light → dark → system → light via the slice.
 *  - The testid + accessible label are present.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { useThemeStore } from '@/store/theme';

function installLocalStorageShim(): void {
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
}

beforeEach(() => {
  installLocalStorageShim();
  document.documentElement.classList.remove('dark');
  useThemeStore.setState({
    themePreference: 'light',
    resolvedTheme: 'light',
    persistFailed: false,
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

describe('<ThemeToggle />', () => {
  it('renders with testid + accessible label', () => {
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label');
  });

  it('renders the sun icon when preference is "light"', () => {
    useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle-icon-light')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle-icon-dark')).not.toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle-icon-system')).not.toBeInTheDocument();
  });

  it('renders the moon icon when preference is "dark"', () => {
    useThemeStore.setState({ themePreference: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle-icon-dark')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle-icon-light')).not.toBeInTheDocument();
  });

  it('renders the laptop icon when preference is "system"', () => {
    useThemeStore.setState({ themePreference: 'system', resolvedTheme: 'light' });
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle-icon-system')).toBeInTheDocument();
  });

  it('exposes the current preference via data-theme-preference', () => {
    useThemeStore.setState({ themePreference: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'data-theme-preference',
      'dark',
    );
  });

  it('clicking cycles light → dark → system → light', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    expect(useThemeStore.getState().themePreference).toBe('light');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(useThemeStore.getState().themePreference).toBe('dark');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(useThemeStore.getState().themePreference).toBe('system');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(useThemeStore.getState().themePreference).toBe('light');
  });

  it('tooltip text describes the current + next state', () => {
    useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    const label = btn.getAttribute('aria-label') ?? '';
    expect(label.toLowerCase()).toContain('light');
    expect(label.toLowerCase()).toContain('dark');
  });
});
