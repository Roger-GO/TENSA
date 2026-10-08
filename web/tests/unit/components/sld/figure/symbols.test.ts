/**
 * The symbols of the diagram as shapes of a figure: read from the same files
 * and the same table the screen draws.
 */
import { describe, expect, it } from 'vitest';
import { iconManifest } from '@/icons/iec60617/manifest';
import type { ControllerSubKind } from '@/lib/controllers';
import {
  controllerSymbol,
  parseSymbol,
  placeSteps,
  symbolForModel,
} from '@/components/sld/figure/symbols';
import { CONTROLLER_GLYPH_PARTS } from '@/components/sld/nodes/controllerGlyphShapes';

describe('symbolForModel', () => {
  it('draws every symbol the manifest has, whole', () => {
    // A file with an element or a path command a figure cannot draw throws
    // here, and not when someone makes a figure of a case that has one.
    for (const model of Object.keys(iconManifest)) {
      const symbol = symbolForModel(model);
      expect(symbol.shapes.length, model).toBeGreaterThan(0);
      expect(symbol.width, model).toBe(24);
      for (const shape of symbol.shapes) {
        expect(shape.steps[0]?.op, model).toBe('M');
        for (const step of shape.steps) {
          if (step.op === 'Z') continue;
          expect(Number.isFinite(step.x) && Number.isFinite(step.y), model).toBe(true);
          expect(step.x, model).toBeGreaterThanOrEqual(0);
          expect(step.x, model).toBeLessThanOrEqual(symbol.width);
          expect(step.y, model).toBeGreaterThanOrEqual(0);
          expect(step.y, model).toBeLessThanOrEqual(symbol.height);
        }
      }
    }
  });

  it('gives the symbol the screen shows for a model, and the same one for the models that share it', () => {
    // A circle (four curves, closed) and the tilde in it.
    const generator = symbolForModel('PV');
    expect(generator.shapes).toHaveLength(2);
    expect(generator.shapes[0]!.steps.map((s) => s.op)).toEqual(['M', 'C', 'C', 'C', 'C', 'Z']);
    expect(symbolForModel('Slack')).toBe(generator);
    // The machine has a second wave under the first.
    expect(symbolForModel('GENROU').shapes).toHaveLength(3);
    expect(symbolForModel('GENROU')).not.toBe(generator);
    // The load: a stem and a triangle.
    expect(symbolForModel('PQ').shapes.map((s) => s.steps.map((step) => step.op).join(''))).toEqual(
      ['ML', 'MLLZ'],
    );
  });

  it('falls back to the bus symbol for a model the manifest does not know, as the screen does', () => {
    expect(symbolForModel('NoSuchModel')).toBe(symbolForModel('Bus'));
    expect(symbolForModel('Bus').height).toBe(6);
  });
});

describe('parseSymbol', () => {
  it('reads how heavy a stroke is against the stroke of the symbol, and what is filled', () => {
    const symbol = parseSymbol(
      '<svg viewBox="0 0 24 6" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<line x1="2" y1="3" x2="22" y2="3" stroke-width="3" />' +
        '<line x1="2" y1="1" x2="2" y2="5" />' +
        '<circle cx="3" cy="3" r="1" fill="currentColor" stroke="none" />' +
        '</svg>',
    );
    expect(symbol).toMatchObject({ width: 24, height: 6 });
    expect(symbol.shapes.map(({ weight, filled }) => ({ weight, filled }))).toEqual([
      { weight: 2, filled: false },
      { weight: 1, filled: false },
      { weight: 0, filled: true },
    ]);
  });

  it('refuses an element it cannot draw', () => {
    expect(() => parseSymbol('<svg viewBox="0 0 24 24"><text x="1" y="1">G</text></svg>')).toThrow(
      /<text> is not supported/,
    );
  });
});

describe('controllerSymbol', () => {
  it('draws the glyph of every sub-kind from the parts the screen draws', () => {
    for (const subKind of Object.keys(CONTROLLER_GLYPH_PARTS) as ControllerSubKind[]) {
      const symbol = controllerSymbol(subKind);
      expect(symbol.shapes, subKind).toHaveLength(CONTROLLER_GLYPH_PARTS[subKind].length);
      expect(symbol.width, subKind).toBe(24);
      for (const shape of symbol.shapes) {
        expect(shape.weight, subKind).toBe(1);
        expect(shape.steps.length, subKind).toBeGreaterThan(1);
      }
    }
  });
});

describe('placeSteps', () => {
  it('scales a symbol and puts its corner where it is asked', () => {
    expect(
      placeSteps(
        [
          { op: 'M', x: 0, y: 0 },
          { op: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 24, y: 12 },
          { op: 'Z' },
        ],
        100,
        50,
        0.5,
      ),
    ).toEqual([
      { op: 'M', x: 100, y: 50 },
      { op: 'C', x1: 100.5, y1: 51, x2: 101.5, y2: 52, x: 112, y: 56 },
      { op: 'Z' },
    ]);
  });
});
