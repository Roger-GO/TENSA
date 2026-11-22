/**
 * DisturbanceForm — discriminated dispatcher swaps sub-forms by spec.kind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DisturbanceForm } from '@/components/disturbance/DisturbanceForm';
import { allowedSpecKinds } from '@/lib/engines';
import { blankAlterSpec, blankFaultSpec, blankToggleSpec } from '@/store/disturbance';
import { useSessionStore } from '@/store/session';
import type { DisturbanceSpec, EngineCapabilities, EngineList, TopologySummary } from '@/api/types';

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

/** The capabilities block of a Sienna engine, as `GET /engines` carries it. */
function siennaEngines(): EngineList {
  const sienna = {
    name: 'sienna',
    available: true,
    unavailable_reason: null,
    versions: {},
    formats: { read: [], write: [] },
    routines: ['matrices', 'pflow', 'eig', 'tds'],
    ops: [],
    editing: false,
    routine_options: {
      tds: {
        streaming: true,
        abort: true,
        disturbances: ['branch_trip', 'bus_fault', 'gen_trip'],
        options: { load_model: ['impedance', 'power', 'as-case'] },
      },
    },
  } as unknown as EngineCapabilities;
  return { engines: [sienna] };
}

beforeEach(() => {
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [{ idx: '1', name: 'BUS1', kind: 'Bus', params: {} }],
    lines: [{ idx: '7', name: 'LINE7', kind: 'Line', params: {} }],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useSessionStore.setState({ engine: null, engines: null });
});

describe('<DisturbanceForm />', () => {
  it('renders the FaultSpecForm when kind=fault', () => {
    render(
      withQueryClient(
        <DisturbanceForm spec={{ ...blankFaultSpec(), bus_idx: '1' }} onChange={() => {}} />,
      ),
    );
    expect(screen.getByTestId('fault-spec-form')).toBeInTheDocument();
    expect(screen.queryByTestId('toggle-spec-form')).toBeNull();
  });

  it('renders the ToggleSpecForm when kind=toggle', () => {
    render(
      withQueryClient(
        <DisturbanceForm spec={{ ...blankToggleSpec(), dev_idx: '7' }} onChange={() => {}} />,
      ),
    );
    expect(screen.getByTestId('toggle-spec-form')).toBeInTheDocument();
    expect(screen.queryByTestId('fault-spec-form')).toBeNull();
  });

  it('changing the kind picker swaps to a fresh blank spec for the new kind', async () => {
    const user = userEvent.setup();
    let current: DisturbanceSpec = { ...blankFaultSpec(), bus_idx: '1' };
    const onChange = vi.fn((next: DisturbanceSpec) => {
      current = next;
    });
    render(withQueryClient(<DisturbanceForm spec={current} onChange={onChange} />));
    await user.selectOptions(screen.getByTestId('disturbance-kind'), 'toggle');
    // The dispatcher fires onChange with a blank Toggle spec — the
    // previous Fault spec data is discarded by design.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'toggle' }));
  });

  it('hides the kind picker when hideKindPicker=true', () => {
    render(
      withQueryClient(
        <DisturbanceForm
          spec={{ ...blankFaultSpec(), bus_idx: '1' }}
          onChange={() => {}}
          hideKindPicker
        />,
      ),
    );
    expect(screen.queryByTestId('disturbance-kind')).toBeNull();
    expect(screen.getByTestId('fault-spec-form')).toBeInTheDocument();
  });

  it('an ANDES session offers Fault, Toggle and Alter', () => {
    render(
      withQueryClient(
        <DisturbanceForm spec={{ ...blankFaultSpec(), bus_idx: '1' }} onChange={() => {}} />,
      ),
    );
    const select = screen.getByTestId('disturbance-kind') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['fault', 'toggle', 'alter']);
  });

  it('a Sienna session offers Fault and Toggle only', () => {
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(
      withQueryClient(
        <DisturbanceForm spec={{ ...blankFaultSpec(), bus_idx: '1' }} onChange={() => {}} />,
      ),
    );
    const select = screen.getByTestId('disturbance-kind') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['fault', 'toggle']);
  });

  it('a Sienna session with an alter draft says the kind is not available and renders no sub-form', () => {
    useSessionStore.setState({ engine: 'sienna', engines: siennaEngines() });
    render(withQueryClient(<DisturbanceForm spec={blankAlterSpec()} onChange={() => {}} />));
    expect(screen.getByTestId('disturbance-kind-not-available')).toHaveTextContent(
      'not available with the Sienna engine',
    );
    expect(screen.queryByTestId('alter-spec-form')).toBeNull();
    expect(screen.queryByTestId('fault-spec-form')).toBeNull();
    expect(screen.queryByTestId('toggle-spec-form')).toBeNull();
  });
});

describe('allowedSpecKinds', () => {
  it('null allows all three kinds', () => {
    expect([...allowedSpecKinds(null)].sort()).toEqual(['alter', 'fault', 'toggle']);
  });

  it('the Sienna list allows fault and toggle', () => {
    expect([...allowedSpecKinds(['branch_trip', 'bus_fault', 'gen_trip'])].sort()).toEqual([
      'fault',
      'toggle',
    ]);
  });

  it('a bus-fault-only list allows only fault', () => {
    expect([...allowedSpecKinds(['bus_fault'])]).toEqual(['fault']);
  });
});
