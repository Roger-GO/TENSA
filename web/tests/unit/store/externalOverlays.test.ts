/**
 * The external overlays store: traces upserted by id, removed one by one, and
 * cleared with the case cascade; the dialog flag opens and closes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useExternalOverlaysStore } from '@/store/externalOverlays';
import type { ExternalOverlayTrace } from '@/store/externalOverlays';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import type { SessionId } from '@/api/types';
import type { CaseSelection } from '@/store/case';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';

/**
 * A case selection as the case store holds one: a file with no dynamic files.
 * The literal is narrower than the ``file`` variant's full shape (the store
 * fills the rest in), so it goes through ``unknown``: the cascade only
 * compares the reference, and the test never reads the other fields.
 */
function fileSelection(path: string): CaseSelection {
  return { kind: 'file', primaryPath: path, addfiles: [] } as unknown as CaseSelection;
}

function trace(id: string, axis: 'left' | 'right' = 'left'): ExternalOverlayTrace {
  const [source, name] = id.split(':') as ['tsat' | 'psse', string];
  return {
    id,
    source,
    name,
    label: `${source}: ${name}`,
    t: Float64Array.of(0, 1),
    y: Float64Array.of(1, NaN),
    axis,
  };
}

describe('external overlays store', () => {
  afterEach(() => {
    __resetCascadeForTests();
  });

  it('adds traces and removes one by id', () => {
    const store = useExternalOverlaysStore.getState();
    store.addTraces([trace('tsat:column 1'), trace('tsat:column 2', 'right')]);
    expect(useExternalOverlaysStore.getState().traces.map((t) => t.id)).toEqual([
      'tsat:column 1',
      'tsat:column 2',
    ]);

    useExternalOverlaysStore.getState().removeTrace('tsat:column 1');
    expect(useExternalOverlaysStore.getState().traces.map((t) => t.id)).toEqual(['tsat:column 2']);
    expect(useExternalOverlaysStore.getState().traces[0]?.axis).toBe('right');
  });

  it('upserts by id: importing the same series twice replaces the trace', () => {
    const store = useExternalOverlaysStore.getState();
    store.addTraces([trace('tsat:column 1')]);
    const replacement = { ...trace('tsat:column 1'), y: Float64Array.of(2, 3) };
    useExternalOverlaysStore.getState().addTraces([replacement]);

    const traces = useExternalOverlaysStore.getState().traces;
    expect(traces).toHaveLength(1);
    expect(Array.from(traces[0]!.y)).toEqual([2, 3]);
  });

  it('opens and closes the dialog on its flag', () => {
    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(false);
    useExternalOverlaysStore.getState().openDialog();
    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(true);
    useExternalOverlaysStore.getState().closeDialog();
    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(false);
  });

  it('clears the traces when the open case changes', () => {
    wireStoreCascade();
    useExternalOverlaysStore.getState().addTraces([trace('tsat:column 1')]);
    useExternalOverlaysStore.getState().openDialog();

    useCaseStore.setState({ selection: fileSelection('ieee14.xlsx') });

    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
    expect(useExternalOverlaysStore.getState().dialogOpen).toBe(false);
  });

  it('keeps the traces through a session recovery, which keeps the case', () => {
    useSessionStore.setState({ sessionId: 's1' as SessionId });
    useCaseStore.setState({ selection: fileSelection('ieee14.xlsx') });
    wireStoreCascade();
    useExternalOverlaysStore.getState().addTraces([trace('tsat:column 1')]);

    useSessionStore.setState({ sessionId: null, recoveryInProgress: true });

    expect(useExternalOverlaysStore.getState().traces.map((t) => t.id)).toEqual(['tsat:column 1']);
  });

  it('clears the traces when the session is discarded, which closes the case', () => {
    useSessionStore.setState({ sessionId: 's1' as SessionId });
    useCaseStore.setState({ selection: fileSelection('ieee14.xlsx') });
    wireStoreCascade();
    useExternalOverlaysStore.getState().addTraces([trace('tsat:column 1')]);

    useSessionStore.setState({ sessionId: null });

    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
  });

  it('clears the traces when the case is closed', () => {
    wireStoreCascade();
    useCaseStore.setState({ selection: fileSelection('ieee14.xlsx') });
    useExternalOverlaysStore.getState().addTraces([trace('psse:column 1')]);

    useCaseStore.setState({ selection: null });

    expect(useExternalOverlaysStore.getState().traces).toEqual([]);
  });
});
