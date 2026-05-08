import { describe, expect, it } from 'vitest';
import { fallbackIconUrl, iconForModel, iconManifest } from '@/icons/iec60617/manifest';

// Models the IEEE 14 / 39 / 118 / 300 + Kundur stock cases produce. The SLD
// canvas (Unit 8) must find an icon for every one of these — a missing key
// here would render the canvas blank for that element kind.
const STOCK_CASE_MODEL_CLASSES = [
  'Bus',
  'Line',
  'Transformer',
  'Trafo',
  'Trafo2',
  'Trafo3',
  'PV',
  'Slack',
  'SW',
  'GENROU',
  'GENCLS',
  'PQ',
  'ZIP',
  'Shunt',
  'ShuntCap',
  'ShuntC',
  'ShuntL',
  'ShuntReactor',
  'Ground',
] as const;

describe('IEC 60617 icon manifest', () => {
  it('maps every stock-case ANDES model class to a non-empty asset URL', () => {
    for (const model of STOCK_CASE_MODEL_CLASSES) {
      const url = iconForModel(model);
      expect(url, `missing icon for ${model}`).toBeTruthy();
      expect(url, `icon for ${model} should be a string`).toBeTypeOf('string');
    }
  });

  it('returns the fallback (bus) icon for unknown model kinds', () => {
    expect(iconForModel('TotallyMadeUpModel')).toBe(fallbackIconUrl);
    expect(iconForModel('')).toBe(fallbackIconUrl);
  });

  it('routes static and dynamic generators to distinct icons', () => {
    expect(iconForModel('PV')).not.toBe(iconForModel('GENROU'));
    expect(iconForModel('Slack')).not.toBe(iconForModel('GENCLS'));
  });

  it('routes capacitive and inductive shunts to distinct icons', () => {
    expect(iconForModel('ShuntCap')).not.toBe(iconForModel('ShuntReactor'));
  });

  it('routes 2-winding and 3-winding transformers to distinct icons', () => {
    expect(iconForModel('Trafo2')).not.toBe(iconForModel('Trafo3'));
  });

  it('exposes the raw manifest as a frozen object', () => {
    expect(Object.isFrozen(iconManifest)).toBe(true);
  });
});
