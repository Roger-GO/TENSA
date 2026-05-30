/**
 * Tests for `<DynamicContentBadge />` (v3.1 Unit 24, R18).
 *
 * Three states driven by the loaded topology's controllers, derived
 * client-side: loading (topology not yet resolved), dynamic (≥1 controller),
 * static-only (0 controllers). Renders nothing when no case is loaded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useCaseStore } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { DynamicContentBadge } from '@/components/case/DynamicContentBadge';

const DYNAMIC: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
  controllers: [
    { idx: 'EXST1_1', name: 'e', kind: 'EXST1', params: {} },
    { idx: 'EXST1_2', name: 'e', kind: 'EXST1', params: {} },
    { idx: 'TGOV1_1', name: 't', kind: 'TGOV1', params: {} },
    { idx: 'IEEEST_1', name: 'p', kind: 'IEEEST', params: {} },
  ],
};

function loadCase(topology: TopologySummary | null) {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    topology,
  });
}

describe('<DynamicContentBadge />', () => {
  beforeEach(() => {
    useCaseStore.setState({ selection: null, topology: null });
  });
  afterEach(() => {
    cleanup();
    useCaseStore.setState({ selection: null, topology: null });
  });

  it('renders nothing when no case is loaded', () => {
    const { container } = render(<DynamicContentBadge />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the loading state while the topology has not resolved', () => {
    loadCase(null);
    render(<DynamicContentBadge />);
    const badge = screen.getByTestId('dynamic-content-badge');
    expect(badge).toHaveAttribute('data-state', 'loading');
    expect(badge).toHaveTextContent(/loading/i);
  });

  it('shows the dynamic state with a category breakdown in the tooltip label', () => {
    loadCase(DYNAMIC);
    render(<DynamicContentBadge />);
    const badge = screen.getByTestId('dynamic-content-badge');
    expect(badge).toHaveAttribute('data-state', 'dynamic');
    expect(badge).toHaveTextContent(/dynamic/i);
    // Breakdown is in the accessible name: "2 exciter, 1 governor, 1 pss".
    expect(badge.getAttribute('aria-label')).toMatch(/2 exciter/);
    expect(badge.getAttribute('aria-label')).toMatch(/1 governor/);
    expect(badge.getAttribute('aria-label')).toMatch(/1 pss/);
  });

  it('shows the static-only state nudging toward a .dyr addfile', () => {
    loadCase({ ...DYNAMIC, controllers: [] });
    render(<DynamicContentBadge />);
    const badge = screen.getByTestId('dynamic-content-badge');
    expect(badge).toHaveAttribute('data-state', 'static-only');
    expect(badge).toHaveTextContent(/static-only/i);
    expect(badge.getAttribute('aria-label')).toMatch(/load a \.dyr addfile/i);
  });

  it('compact mode hides the text label but keeps the accessible name', () => {
    loadCase(DYNAMIC);
    render(<DynamicContentBadge compact />);
    const badge = screen.getByTestId('dynamic-content-badge');
    expect(badge).not.toHaveTextContent(/dynamic/i); // no visible label
    expect(badge.getAttribute('aria-label')).toMatch(/dynamic/i); // still named
  });
});
