/**
 * Tests for `<ComponentLibrary />` (v3 Unit 5).
 *
 * Concerns:
 *  - Six tile testids render (Bus, Generator, Load, Shunt, Line,
 *    Transformer).
 *  - Each tile is `draggable` (HTML5 attribute reflected to the DOM).
 *  - Firing a `dragstart` event on a tile sets the
 *    `application/andes-component-type` MIME on the DataTransfer to
 *    the tile's kind string + sets `effectAllowed='copy'`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { COMPONENT_DND_MIME, ComponentLibrary } from '@/components/shell/ComponentLibrary';

afterEach(() => {
  cleanup();
});

describe('<ComponentLibrary />', () => {
  it('mounts the library container with the testid', () => {
    render(<ComponentLibrary />);
    expect(screen.getByTestId('component-library')).toBeInTheDocument();
  });

  it('renders all six tiles with stable testids', () => {
    render(<ComponentLibrary />);
    for (const kind of ['Bus', 'Generator', 'Load', 'Shunt', 'Line', 'Transformer']) {
      expect(screen.getByTestId(`component-library-tile-${kind}`)).toBeInTheDocument();
    }
  });

  it('marks each tile as draggable', () => {
    render(<ComponentLibrary />);
    const busTile = screen.getByTestId('component-library-tile-Bus');
    expect(busTile.getAttribute('draggable')).toBe('true');
    const genTile = screen.getByTestId('component-library-tile-Generator');
    expect(genTile.getAttribute('draggable')).toBe('true');
  });

  it('dragstart writes the kind to the andes-component-type MIME + effectAllowed=copy', () => {
    render(<ComponentLibrary />);
    const tile = screen.getByTestId('component-library-tile-Generator');

    // Build a minimal DataTransfer-shaped stub. jsdom's synthetic drag
    // events expose a real DataTransfer, but we want assertion-friendly
    // setData calls so we replace it with a spy stub.
    const setData = vi.fn();
    const dataTransfer = {
      setData,
      getData: vi.fn(),
      effectAllowed: 'none' as DataTransfer['effectAllowed'],
      dropEffect: 'none' as DataTransfer['dropEffect'],
      types: [] as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    fireEvent.dragStart(tile, { dataTransfer });

    expect(setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, 'Generator');
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('each tile sets its own kind on dragstart', () => {
    render(<ComponentLibrary />);
    const cases: Array<['Bus' | 'Load' | 'Shunt' | 'Line' | 'Transformer', string]> = [
      ['Bus', 'Bus'],
      ['Load', 'Load'],
      ['Shunt', 'Shunt'],
      ['Line', 'Line'],
      ['Transformer', 'Transformer'],
    ];
    for (const [kind, payload] of cases) {
      const tile = screen.getByTestId(`component-library-tile-${kind}`);
      const setData = vi.fn();
      const dataTransfer = {
        setData,
        getData: vi.fn(),
        effectAllowed: 'none' as DataTransfer['effectAllowed'],
        dropEffect: 'none' as DataTransfer['dropEffect'],
        types: [] as ReadonlyArray<string>,
        files: [] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
        clearData: vi.fn(),
        setDragImage: vi.fn(),
      };
      fireEvent.dragStart(tile, { dataTransfer });
      expect(setData).toHaveBeenCalledWith(COMPONENT_DND_MIME, payload);
    }
  });
});
