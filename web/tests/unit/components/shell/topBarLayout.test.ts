/**
 * The top bar's responsive classes carry their thresholds in their names, because
 * Tailwind has to see them written out. These tests keep the names and the numbers
 * beside them from drifting apart.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INLINE_FROM_MEDIUM,
  INLINE_FROM_NARROW,
  INLINE_FROM_WIDE,
  MEDIUM_PX,
  MORE_BELOW_MEDIUM,
  MORE_BELOW_NARROW,
  MORE_BELOW_WIDE,
  NARROW_PX,
  WIDE_PX,
} from '@/components/shell/topBarLayout';

/** The width, in px, that a `max-` or a `min-` class of the bar has in its brackets. */
function widthOf(cls: string): number {
  const match = /^(?:max|min)-\[(\d+)px\]:hidden$/.exec(cls);
  if (match === null) throw new Error(`not a width class: ${cls}`);
  return Number(match[1]);
}

describe('topBarLayout', () => {
  it('names each inline class for the width its constant gives', () => {
    expect(widthOf(INLINE_FROM_WIDE)).toBe(WIDE_PX);
    expect(widthOf(INLINE_FROM_MEDIUM)).toBe(MEDIUM_PX);
    expect(widthOf(INLINE_FROM_NARROW)).toBe(NARROW_PX);
  });

  it('hides an inline control below its width (max) and its More stand-in from it (min)', () => {
    expect(INLINE_FROM_WIDE.startsWith('max-')).toBe(true);
    expect(INLINE_FROM_MEDIUM.startsWith('max-')).toBe(true);
    expect(INLINE_FROM_NARROW.startsWith('max-')).toBe(true);
    expect(MORE_BELOW_WIDE.startsWith('min-')).toBe(true);
    expect(MORE_BELOW_MEDIUM.startsWith('min-')).toBe(true);
    expect(MORE_BELOW_NARROW.startsWith('min-')).toBe(true);
    // The pairs swap at the same width, so there is no width at which both show, or neither.
    expect(widthOf(MORE_BELOW_WIDE)).toBe(widthOf(INLINE_FROM_WIDE));
    expect(widthOf(MORE_BELOW_MEDIUM)).toBe(widthOf(INLINE_FROM_MEDIUM));
    expect(widthOf(MORE_BELOW_NARROW)).toBe(widthOf(INLINE_FROM_NARROW));
  });

  it('hands over in order: Search, Theme and History first, then the pane toggles, then Labels and Units', () => {
    expect(WIDE_PX).toBeGreaterThan(MEDIUM_PX);
    expect(MEDIUM_PX).toBeGreaterThan(NARROW_PX);
  });
});

/** Every `.ts` and `.tsx` file under a directory of `web/`, where Vitest runs. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(path.resolve(process.cwd(), dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(dir, name));
}

describe('width classes anywhere in the sources', () => {
  // Tailwind makes a rule of every class-like word it finds, in a comment or a test as
  // much as in a `className`. A width variant whose brackets hold a placeholder gives a
  // media query that is not CSS: the rule ships in the stylesheet and the build warns.
  it('have a length in their brackets, in comments too', () => {
    const variant = /\b(?:min|max)-\[([^\]\s]*)\]:/g;
    const strays: string[] = [];
    for (const file of [...sourcesUnder('src'), ...sourcesUnder('tests')]) {
      const text = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      for (const match of text.matchAll(variant)) {
        if (!/^\d+(?:\.\d+)?(?:px|rem|em)$/.test(match[1] ?? '')) {
          strays.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });
});
