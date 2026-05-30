import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentDropZone } from '@/components/sld/ComponentDropZone';
import { COMPONENT_DND_MIME } from '@/components/shell/ComponentLibrary';

/**
 * ComponentDropZone is the fix for "drag-and-drop not really working" on
 * the EMPTY canvas states: before it, only the loaded canvas accepted a
 * Component Library tile, so the advertised "drag a component onto the
 * canvas to start a blank system" gesture was a silent no-op.
 *
 * A DataTransfer carrying our custom MIME must reach `onDropComponent`;
 * an unrelated drag (a file, plain text) must be ignored so the browser
 * keeps its default behaviour.
 */
function dataTransferWith(entries: Record<string, string>): DataTransfer {
  const store = new Map(Object.entries(entries));
  return {
    types: [...store.keys()],
    getData: (k: string) => store.get(k) ?? '',
    setData: (k: string, v: string) => store.set(k, v),
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

describe('ComponentDropZone', () => {
  it('calls onDropComponent with the dropped kind for a component payload', () => {
    const onDrop = vi.fn();
    render(
      <ComponentDropZone onDropComponent={onDrop} data-testid="zone">
        <span>drop here</span>
      </ComponentDropZone>,
    );
    const zone = screen.getByTestId('zone');
    const dt = dataTransferWith({ [COMPONENT_DND_MIME]: 'Generator' });
    fireEvent.dragOver(zone, { dataTransfer: dt });
    fireEvent.drop(zone, { dataTransfer: dt, clientX: 120, clientY: 80 });
    expect(onDrop).toHaveBeenCalledTimes(1);
    // The kind is the contract that matters for the empty states. (Coords
    // are forwarded too, but jsdom's synthetic drop event is a plain
    // Event with no clientX/clientY, so only a real browser carries real
    // geometry — verified live.)
    expect(onDrop.mock.calls[0][0]).toBe('Generator');
  });

  it('ignores drags that do not carry a component payload', () => {
    const onDrop = vi.fn();
    render(
      <ComponentDropZone onDropComponent={onDrop} data-testid="zone">
        <span>drop here</span>
      </ComponentDropZone>,
    );
    const zone = screen.getByTestId('zone');
    const dt = dataTransferWith({ 'text/plain': 'hello' });
    fireEvent.dragOver(zone, { dataTransfer: dt });
    fireEvent.drop(zone, { dataTransfer: dt });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('forwards arbitrary div attributes (role, data-testid) to the surface', () => {
    render(
      <ComponentDropZone onDropComponent={() => {}} role="status" data-testid="zone">
        child
      </ComponentDropZone>,
    );
    const zone = screen.getByTestId('zone');
    expect(zone).toHaveAttribute('role', 'status');
  });

  it('marks the surface active while a component drag hovers', () => {
    render(
      <ComponentDropZone onDropComponent={() => {}} data-testid="zone">
        child
      </ComponentDropZone>,
    );
    const zone = screen.getByTestId('zone');
    expect(zone).not.toHaveAttribute('data-drop-active');
    fireEvent.dragOver(zone, { dataTransfer: dataTransferWith({ [COMPONENT_DND_MIME]: 'Bus' }) });
    expect(zone).toHaveAttribute('data-drop-active');
  });
});
