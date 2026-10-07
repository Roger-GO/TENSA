/**
 * Tests for `<LeftSidebar />` (v3 Unit 3).
 *
 * Concerns:
 *  - Two tabs, Project and Components, each with the panel it names.
 *  - Project mounts the sections (Case, Saved cases) with stable testids, and
 *    a Disturbances section between the two once a case is loaded; each
 *    renders its uppercase heading. Components mounts the palette.
 *  - The tab shown is the one kept in the layout store, so it is the same
 *    after a reload, and a value the store should not hold shows Project.
 *  - The panel that is not shown stays mounted and hidden, so what it holds
 *    (the search of the palette, a load in flight) is there on the way back.
 *
 * Network is stubbed via the api/queries mock so SavedCasesList +
 * CaseNav (which both consume `useListWorkspaceFiles`) don't fire real
 * fetches in jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { LeftSidebar } from '@/components/shell/LeftSidebar';
import { useCaseStore } from '@/store/case';
import { DEFAULT_LAYOUT, useLayoutStore, type LeftSidebarTab } from '@/store/layout';
import { useSessionStore } from '@/store/session';
import { parseWorkspacePath } from '@/api/types';

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useListWorkspaceFiles: () => ({
      data: { files: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useListSnapshots: () => ({
      data: { snapshots: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useLoadCase: () => ({
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
    useRestoreSnapshot: () => ({
      mutateAsync: vi.fn(),
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
      error: null,
    }),
    useDeleteSession: () => ({
      mutate: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    }),
  };
});

function withClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const projectTab = () => screen.getByRole('tab', { name: 'Project' });
const componentsTab = () => screen.getByRole('tab', { name: 'Components' });
const projectPanel = () => screen.getByTestId('left-sidebar-tab-content-project');
const componentsPanel = () => screen.getByTestId('left-sidebar-tab-content-components');

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
});

afterEach(() => {
  cleanup();
});

describe('<LeftSidebar />', () => {
  it('mounts the root container with the testid', () => {
    render(withClient(<LeftSidebar />));
    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument();
  });

  describe('tabs', () => {
    it('has a Project tab and a Components tab, in that order, in a named tab list', () => {
      render(withClient(<LeftSidebar />));
      const list = screen.getByRole('tablist', { name: 'Left sidebar tabs' });
      expect(within(list).getAllByRole('tab')).toEqual([projectTab(), componentsTab()]);
      expect(projectTab()).toBe(screen.getByTestId('left-sidebar-tab-project'));
      expect(componentsTab()).toBe(screen.getByTestId('left-sidebar-tab-components'));
    });

    it('opens on Project, with the palette mounted but hidden', () => {
      render(withClient(<LeftSidebar />));
      expect(projectTab()).toHaveAttribute('aria-selected', 'true');
      expect(componentsTab()).toHaveAttribute('aria-selected', 'false');
      expect(projectPanel()).toBeVisible();
      expect(screen.getByTestId('saved-cases-list')).toBeVisible();
      expect(componentsPanel()).not.toBeVisible();
      expect(screen.getByTestId('component-library')).not.toBeVisible();
    });

    it('shows the palette, and hides the project, on a click of Components', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      await user.click(componentsTab());
      expect(componentsTab()).toHaveAttribute('aria-selected', 'true');
      expect(projectTab()).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByTestId('component-library')).toBeVisible();
      expect(screen.getByRole('textbox', { name: 'Search components' })).toBeVisible();
      expect(projectPanel()).not.toBeVisible();
      expect(screen.getByTestId('saved-cases-list')).not.toBeVisible();

      await user.click(projectTab());
      expect(screen.getByTestId('saved-cases-list')).toBeVisible();
      expect(screen.getByTestId('component-library')).not.toBeVisible();
    });

    it('names each panel after its tab', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      expect(screen.getByRole('tabpanel', { name: 'Project' })).toBe(projectPanel());
      await user.click(componentsTab());
      expect(screen.getByRole('tabpanel', { name: 'Components' })).toBe(componentsPanel());
      // The hidden panel is out of the accessibility tree.
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    });

    it('switches with the arrow keys from a focused tab', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      // Radix moves its roving tab stop as the tab takes the focus.
      act(() => projectTab().focus());
      await user.keyboard('{ArrowRight}');
      expect(componentsTab()).toHaveFocus();
      expect(componentsTab()).toHaveAttribute('aria-selected', 'true');
      expect(useLayoutStore.getState().leftSidebarTab).toBe('components');
      await user.keyboard('{ArrowLeft}');
      expect(projectTab()).toHaveAttribute('aria-selected', 'true');
      expect(useLayoutStore.getState().leftSidebarTab).toBe('project');
    });

    it('says in a tooltip what each tab holds', () => {
      render(withClient(<LeftSidebar />));
      expect(projectTab().getAttribute('title')).toMatch(/case.*saved cases.*snapshots/);
      expect(componentsTab().getAttribute('title')).toMatch(/search.*click or drag to add/);
    });
  });

  describe('the tab is remembered', () => {
    it('writes the tab that was clicked to the layout the browser keeps', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      await user.click(componentsTab());
      expect(useLayoutStore.getState().leftSidebarTab).toBe('components');
      const kept = JSON.parse(window.localStorage.getItem('tensa:layout-v1') ?? '{}') as {
        state?: { leftSidebarTab?: string };
      };
      expect(kept.state?.leftSidebarTab).toBe('components');
    });

    it('opens on the tab that was kept', () => {
      useLayoutStore.setState({ leftSidebarTab: 'components' });
      render(withClient(<LeftSidebar />));
      expect(componentsTab()).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('component-library')).toBeVisible();
      expect(projectPanel()).not.toBeVisible();
    });

    it('follows the store when something else sends the user to a tab', () => {
      render(withClient(<LeftSidebar />));
      act(() => useLayoutStore.getState().showLeftSidebarTab('components'));
      expect(screen.getByTestId('component-library')).toBeVisible();
      act(() => useLayoutStore.getState().showLeftSidebarTab('project'));
      expect(screen.getByTestId('saved-cases-list')).toBeVisible();
    });

    it('shows Project for a kept value that is not a tab, rather than neither panel', () => {
      useLayoutStore.setState({ leftSidebarTab: 'library' as unknown as LeftSidebarTab });
      render(withClient(<LeftSidebar />));
      expect(projectTab()).toHaveAttribute('aria-selected', 'true');
      expect(projectPanel()).toBeVisible();
      expect(componentsPanel()).not.toBeVisible();
    });
  });

  describe('both panels stay mounted', () => {
    it('keeps what was typed in the search of the palette across a visit to Project', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      await user.click(componentsTab());
      await user.type(screen.getByTestId('component-library-search'), 'exciter');
      await user.click(projectTab());
      await user.click(componentsTab());
      expect(screen.getByTestId('component-library-search')).toHaveValue('exciter');
      expect(screen.getByTestId('component-library-item-SEXS')).toBeVisible();
      expect(screen.queryByTestId('component-library-item-Bus')).toBeNull();
    });

    it('keeps the same Project panel in the tree while Components is shown', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      const list = screen.getByTestId('saved-cases-list');
      await user.click(componentsTab());
      expect(screen.getByTestId('saved-cases-list')).toBe(list);
      expect(list).toBeInTheDocument();
    });
  });

  describe('Project', () => {
    it('renders the section containers in order', () => {
      render(withClient(<LeftSidebar />));
      const caseSection = screen.getByTestId('left-sidebar-section-case');
      const savedSection = screen.getByTestId('left-sidebar-section-saved-cases');
      expect(projectPanel()).toContainElement(caseSection);
      expect(projectPanel()).toContainElement(savedSection);
      // Order check — DOM position guarantees the visual stack matches
      // the IA spec.
      expect(
        caseSection.compareDocumentPosition(savedSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('renders each section heading with the uppercase label', () => {
      render(withClient(<LeftSidebar />));
      expect(screen.getByTestId('left-sidebar-section-case-heading').textContent).toBe('Case');
      expect(screen.getByTestId('left-sidebar-section-saved-cases-heading').textContent).toBe(
        'Saved cases',
      );
    });

    it('holds the case card and the saved cases, and not the palette', () => {
      render(withClient(<LeftSidebar />));
      // CaseNav (no case loaded) renders its hint; SavedCasesList renders
      // its own EmptyState ("No case files").
      expect(projectPanel()).toContainElement(screen.getByTestId('case-nav-empty'));
      expect(projectPanel()).toContainElement(screen.getByTestId('saved-cases-list'));
      expect(projectPanel()).not.toContainElement(screen.getByTestId('component-library'));
      expect(screen.queryByTestId('left-sidebar-section-component-library')).toBeNull();
    });

    it('opens the Components tab from the hint of the empty case card', async () => {
      const user = userEvent.setup();
      render(withClient(<LeftSidebar />));
      await user.click(screen.getByRole('button', { name: 'Components tab' }));
      expect(componentsTab()).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('component-library')).toBeVisible();
    });
  });

  describe('Components', () => {
    it('holds the palette', () => {
      render(withClient(<LeftSidebar />));
      expect(componentsPanel()).toContainElement(screen.getByTestId('component-library'));
    });
  });

  describe('Disturbances section', () => {
    it('is not there before a case is loaded: there is nothing to disturb', () => {
      render(withClient(<LeftSidebar />));
      expect(screen.queryByTestId('left-sidebar-section-disturbances')).toBeNull();
      expect(screen.queryByTestId('scheduled-disturbances')).toBeNull();
    });

    it('sits between the case and the saved cases once a case is loaded', () => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      });
      render(withClient(<LeftSidebar />));
      const caseSection = screen.getByTestId('left-sidebar-section-case');
      const disturbances = screen.getByTestId('left-sidebar-section-disturbances');
      const saved = screen.getByTestId('left-sidebar-section-saved-cases');
      expect(projectPanel()).toContainElement(disturbances);
      expect(screen.getByTestId('left-sidebar-section-disturbances-heading').textContent).toBe(
        'Disturbances',
      );
      expect(
        caseSection.compareDocumentPosition(disturbances) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        disturbances.compareDocumentPosition(saved) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // With nothing scheduled it offers the first fault.
      expect(screen.getByRole('button', { name: 'Add fault' })).toBeInTheDocument();
    });
  });
});
