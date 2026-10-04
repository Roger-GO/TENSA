/**
 * The buttons that repeat a keyboard shortcut in their tooltip name the key of
 * the user's platform: Ctrl+B off macOS, ⌘B on it. They used to say ⌘ everywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { BottomDrawerToggle } from '@/components/shell/BottomDrawerToggle';
import { InspectorToggle } from '@/components/shell/InspectorToggle';
import { ResultsViewToggle } from '@/components/shell/ResultsViewToggle';
import { SidebarToggle } from '@/components/shell/SidebarToggle';
import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useThemeStore } from '@/store/theme';

const ORIGINAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function stubPlatform(platform: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent: '' } as unknown as Navigator,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useThemeStore.setState({ themePreference: 'light', resolvedTheme: 'light' });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  if (ORIGINAL_NAVIGATOR) Object.defineProperty(globalThis, 'navigator', ORIGINAL_NAVIGATOR);
});

const CASES: ReadonlyArray<{
  name: string;
  testId: string;
  ui: () => React.ReactElement;
  text: string;
  mac: string;
  other: string;
}> = [
  {
    name: 'left sidebar',
    testId: 'top-bar-toggle-sidebar',
    ui: () => <SidebarToggle />,
    text: 'Hide left sidebar',
    mac: '⌘B',
    other: 'Ctrl+B',
  },
  {
    name: 'inspector',
    testId: 'top-bar-toggle-inspector',
    ui: () => <InspectorToggle />,
    text: 'Hide inspector',
    mac: '⌘\\',
    other: 'Ctrl+\\',
  },
  {
    name: 'bottom drawer',
    testId: 'top-bar-toggle-drawer',
    ui: () => <BottomDrawerToggle />,
    text: 'Hide bottom drawer',
    mac: '⌘J',
    other: 'Ctrl+J',
  },
  {
    name: 'results view',
    testId: 'top-bar-toggle-results-view',
    ui: () => <ResultsViewToggle />,
    text: 'Maximize results',
    mac: '⌘⇧M',
    other: 'Ctrl+Shift+M',
  },
  {
    name: 'theme',
    testId: 'theme-toggle',
    ui: () => <ThemeToggle />,
    text: 'Theme: light',
    mac: '⌘⇧L',
    other: 'Ctrl+Shift+L',
  },
];

describe('tooltips name the platform key', () => {
  for (const c of CASES) {
    it(`${c.name}: ⌘ on macOS`, () => {
      stubPlatform('MacIntel');
      render(c.ui());
      const button = screen.getByTestId(c.testId);
      expect(button.getAttribute('title')).toContain(c.text);
      expect(button.getAttribute('title')).toContain(`(${c.mac})`);
      expect(button.getAttribute('aria-label')).toContain(`(${c.mac})`);
    });

    it(`${c.name}: Ctrl elsewhere, and never a ⌘`, () => {
      stubPlatform('Linux x86_64');
      render(c.ui());
      const button = screen.getByTestId(c.testId);
      expect(button.getAttribute('title')).toContain(`(${c.other})`);
      expect(button.getAttribute('title')).not.toContain('⌘');
      expect(button.getAttribute('aria-label')).toContain(`(${c.other})`);
    });
  }
});
