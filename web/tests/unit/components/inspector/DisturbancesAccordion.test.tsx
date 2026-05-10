/**
 * Tests for ``<DisturbancesAccordion />`` (v3 Unit 10).
 *
 * Pins the per-element filter logic, the delete propagation back to the
 * shared disturbance slice, and the "+ Add" CTA opening the existing
 * AddEventDialog.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { DisturbancesAccordion } from '@/components/inspector/DisturbancesAccordion';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  useDisturbanceStore.getState().clearDisturbances();
});

afterEach(() => {
  cleanup();
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  useDisturbanceStore.getState().clearDisturbances();
});

describe('<DisturbancesAccordion />', () => {
  it('shows a "no selection" empty state when nothing is selected', () => {
    render(withQueryClient(<DisturbancesAccordion />));
    expect(screen.getByTestId('disturbances-accordion')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('shows the per-element empty state copy when a bus is selected with no faults', () => {
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<DisturbancesAccordion />));
    expect(screen.getByText(/no disturbances on this element\. add one/i)).toBeInTheDocument();
  });

  it('renders both faults targeting the selected bus', () => {
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    const add = useDisturbanceStore.getState().addDisturbance;
    add({ kind: 'fault', bus_idx: '5', tf: 1.0, tc: 1.1, xf: 0.05, rf: 0 });
    add({ kind: 'fault', bus_idx: '5', tf: 2.0, tc: 2.1, xf: 0.05, rf: 0 });
    add({ kind: 'fault', bus_idx: '7', tf: 1.0, tc: 1.1, xf: 0.05, rf: 0 });
    render(withQueryClient(<DisturbancesAccordion />));
    const list = screen.getByTestId('disturbances-accordion-list');
    expect(list.querySelectorAll('li').length).toBe(2);
  });

  it('clicking delete drops the disturbance from the store', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    const add = useDisturbanceStore.getState().addDisturbance;
    const fault = add({ kind: 'fault', bus_idx: '5', tf: 1.0, tc: 1.1, xf: 0.05, rf: 0 });
    render(withQueryClient(<DisturbancesAccordion />));
    await user.click(screen.getByTestId(`disturbances-accordion-delete-${fault.id}`));
    expect(useDisturbanceStore.getState().disturbances.length).toBe(0);
  });

  it('clicking + Add opens the AddEventDialog', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<DisturbancesAccordion />));
    expect(screen.queryByTestId('add-event-dialog')).toBeNull();
    await user.click(screen.getByTestId('disturbances-accordion-add'));
    expect(screen.getByTestId('add-event-dialog')).toBeInTheDocument();
  });

  it('toggle on a Line matches the selected line', () => {
    useCaseStore.setState({ selectedElement: { kind: 'line', idx: 'L1' } });
    const add = useDisturbanceStore.getState().addDisturbance;
    add({ kind: 'toggle', model: 'Line', dev_idx: 'L1', t: 1.5 });
    add({ kind: 'toggle', model: 'Line', dev_idx: 'L2', t: 1.5 });
    render(withQueryClient(<DisturbancesAccordion />));
    const list = screen.getByTestId('disturbances-accordion-list');
    expect(list.querySelectorAll('li').length).toBe(1);
  });

  it('alter on a generator matches the selected generator', () => {
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    const add = useDisturbanceStore.getState().addDisturbance;
    add({ kind: 'alter', model: 'PV', dev_idx: 'G1', src: 'p0', t: 1.0, value: 1.2 });
    add({ kind: 'alter', model: 'PQ', dev_idx: 'G1', src: 'p0', t: 1.0, value: 1.2 });
    render(withQueryClient(<DisturbancesAccordion />));
    const list = screen.getByTestId('disturbances-accordion-list');
    expect(list.querySelectorAll('li').length).toBe(1);
  });
});
