/**
 * Tests for ``runIdToColor`` + friends.
 *
 * The hash → palette-slot logic is deterministic, so we assert exact
 * outputs for fixed inputs. Unit 20 added the optional ``override``
 * parameter — when set, the function must short-circuit the hash and
 * return the override verbatim.
 */
import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  PALETTE_SIZE,
  runIdToColor,
  runIdToDash,
  runIdToPaletteSlot,
  runIdToStrokeStyle,
} from '@/lib/runIdToColor';

describe('runIdToColor — hash + palette', () => {
  it('fnv1a32 is deterministic', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'));
  });

  it('runIdToPaletteSlot returns a value in [0, PALETTE_SIZE)', () => {
    for (const id of ['r1', 'r2', 'r3', 'abcdef1234']) {
      const slot = runIdToPaletteSlot(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PALETTE_SIZE);
    }
  });

  it('runIdToColor returns an hsl() string by default', () => {
    expect(runIdToColor('r1')).toMatch(/^hsl\(\d+, 70%, 45%\)$/);
  });

  it('runIdToColor is stable for the same runId', () => {
    expect(runIdToColor('r1')).toBe(runIdToColor('r1'));
  });

  it('runIdToDash returns either an empty array or a [on, off, ...] pattern', () => {
    for (const id of ['r1', 'r2', 'r3', 'abcdef']) {
      const dash = runIdToDash(id);
      expect(Array.isArray(dash)).toBe(true);
      // Either solid (length 0) or an even-length on/off pattern.
      expect(dash.length % 2 === 0 || dash.length === 0).toBe(true);
    }
  });
});

describe('runIdToColor — colour override (Unit 20 v2.0)', () => {
  it('returns the override verbatim when provided', () => {
    expect(runIdToColor('r1', '#3366ff')).toBe('#3366ff');
    expect(runIdToColor('r1', 'oklch(0.55 0.20 28)')).toBe('oklch(0.55 0.20 28)');
  });

  it('falls back to the hash colour when override is empty / null / undefined', () => {
    const hashColor = runIdToColor('r1');
    expect(runIdToColor('r1', undefined)).toBe(hashColor);
    expect(runIdToColor('r1', null)).toBe(hashColor);
    expect(runIdToColor('r1', '')).toBe(hashColor);
  });

  it('runIdToStrokeStyle propagates the override into the colour field', () => {
    const style = runIdToStrokeStyle('r1', '#ff00aa');
    expect(style.color).toBe('#ff00aa');
    // Dash pattern still comes from the runId hash — overriding the
    // colour does NOT change the dash family.
    expect(style.dash).toEqual(runIdToDash('r1'));
  });

  it('runIdToStrokeStyle without an override matches the hash', () => {
    const style = runIdToStrokeStyle('r1');
    expect(style.color).toBe(runIdToColor('r1'));
    expect(style.dash).toEqual(runIdToDash('r1'));
  });
});
