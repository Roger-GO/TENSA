/**
 * Tests for ``<EIGScatter />`` (Unit 6).
 *
 * Coverage:
 * - Empty-state branches: result=null + result with mode_count=0.
 * - Renders one circle per visible mode (filter applied).
 * - Click on a point updates the analyze store's selectedModeId.
 * - Filter widening surfaces previously-hidden modes.
 * - Selected point gets the data-selected="true" attribute.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EIGScatter } from '@/components/analyze/EIGScatter';
import {
  DEFAULT_EIG_FILTER,
  useAnalyzeStore,
} from '@/store/analyze';
import type { EigResult } from '@/api/types';

function resetAnalyzeStore() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
  });
}

const RESULT: EigResult = {
  eigenvalues: [
    { real: -0.1, imag: 2.0 }, // visible (damping 0.05, |Re|=0.1)
    { real: -0.5, imag: 0.0 }, // hidden (damping 1.0)
    { real: -10.0, imag: 1.0 }, // hidden (|Re|=10)
    { real: -0.05, imag: -2.0 }, // visible
  ],
  damping_ratios: [0.05, 1.0, 0.995, 0.025],
  frequencies_hz: [0.318, 0, 0.159, 0.318],
  mode_count: 4,
  state_count: 4,
  state_names: ['delta_1', 'omega_1', 'delta_2', 'omega_2'],
  tds_initialized: true,
};

describe('<EIGScatter />', () => {
  beforeEach(() => {
    resetAnalyzeStore();
  });
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('renders the empty-state when no result is set', () => {
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-empty')).toBeInTheDocument();
  });

  it('renders the no-dynamic-states empty state when mode_count=0', () => {
    const empty: EigResult = {
      eigenvalues: [],
      damping_ratios: [],
      frequencies_hz: [],
      mode_count: 0,
      state_count: 0,
      state_names: [],
      tds_initialized: true,
    };
    render(<EIGScatter result={empty} />);
    const empt = screen.getByTestId('eig-empty');
    expect(empt).toBeInTheDocument();
    expect(empt.textContent).toMatch(/no dynamic states/i);
  });

  it('renders a circle for each visible mode under the default filter', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-scatter')).toBeInTheDocument();
    // Default filter shows modes 0 and 3 only.
    expect(screen.getByTestId('eig-scatter-point-0')).toBeInTheDocument();
    expect(screen.getByTestId('eig-scatter-point-3')).toBeInTheDocument();
    expect(screen.queryByTestId('eig-scatter-point-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eig-scatter-point-2')).not.toBeInTheDocument();
  });

  it('clicking a point sets the selected mode id', async () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    render(<EIGScatter />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('eig-scatter-point-3'));
    expect(useAnalyzeStore.getState().selectedModeId).toBe(3);
  });

  it('selected point carries data-selected="true"', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    useAnalyzeStore.getState().setSelectedModeId(0);
    render(<EIGScatter />);
    expect(screen.getByTestId('eig-scatter-point-0')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('eig-scatter-point-3')).toHaveAttribute(
      'data-selected',
      'false',
    );
  });

  it('widening the filter surfaces previously hidden modes', () => {
    useAnalyzeStore.getState().setEigResult(RESULT);
    useAnalyzeStore
      .getState()
      .setFilter({ dampingMax: 1.5, realAbsMax: 100 });
    render(<EIGScatter />);
    for (const i of [0, 1, 2, 3]) {
      expect(
        screen.getByTestId(`eig-scatter-point-${i}`),
      ).toBeInTheDocument();
    }
  });
});
