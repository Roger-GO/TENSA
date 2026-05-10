/**
 * AddEventDialog — open/close, onSave, edit-mode prefill, save gating
 * on validity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AddEventDialog } from '@/components/disturbance/AddEventDialog';
import { blankFaultSpec } from '@/store/disturbance';
import type { DisturbanceSpec, FaultSpec, TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useAlterableParams: () => ({ data: { model: '', params: [] }, isLoading: false }),
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [
      { idx: '1', name: 'BUS1', kind: 'Bus', params: {} },
      { idx: '5', name: 'BUS5', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
});

describe('<AddEventDialog />', () => {
  it('renders nothing when open=false', () => {
    render(
      withQueryClient(<AddEventDialog open={false} onOpenChange={() => {}} onSave={() => {}} />),
    );
    expect(screen.queryByTestId('add-event-dialog')).toBeNull();
  });

  it('opens with a blank Fault spec by default and shows the kind picker', () => {
    render(withQueryClient(<AddEventDialog open onOpenChange={() => {}} onSave={() => {}} />));
    expect(screen.getByTestId('add-event-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('disturbance-kind')).toBeInTheDocument();
    expect(screen.getByTestId('fault-spec-form')).toBeInTheDocument();
  });

  it('save is disabled while the form is invalid (e.g., empty bus)', async () => {
    render(withQueryClient(<AddEventDialog open onOpenChange={() => {}} onSave={() => {}} />));
    const save = screen.getByTestId('add-event-save');
    // Default Fault spec has bus_idx='', which is invalid.
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('save fires onSave + closes the dialog on a valid spec', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    render(withQueryClient(<AddEventDialog open onOpenChange={onOpenChange} onSave={onSave} />));
    // Pick a bus to make the form valid.
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    await waitFor(() => expect(screen.getByTestId('add-event-save')).not.toBeDisabled());
    await user.click(screen.getByTestId('add-event-save'));
    expect(onSave).toHaveBeenCalled();
    const arg = (onSave.mock.calls[0]?.[0] ?? null) as DisturbanceSpec | null;
    expect(arg?.kind).toBe('fault');
    // Numeric bus idxes are coerced to int so ANDES exact-type-match works
    // at setup time. Most cases (IEEE 14, IEEE 39, etc.) use integer Bus.idx.
    expect((arg as FaultSpec).bus_idx).toBe(5);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel closes without firing onSave', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    render(withQueryClient(<AddEventDialog open onOpenChange={onOpenChange} onSave={onSave} />));
    await user.click(screen.getByTestId('add-event-cancel'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens in edit mode pre-filled with initialSpec; hides the kind picker', () => {
    const initial: FaultSpec = { ...blankFaultSpec(), bus_idx: '5', tf: 2.0, tc: 2.1 };
    render(
      withQueryClient(
        <AddEventDialog open onOpenChange={() => {}} onSave={() => {}} initialSpec={initial} />,
      ),
    );
    // Edit mode hides the kind picker (the Plan: edit doesn't change kind).
    expect(screen.queryByTestId('disturbance-kind')).toBeNull();
    // Title: "Edit disturbance".
    expect(screen.getByText(/Edit disturbance/i)).toBeInTheDocument();
  });
});
