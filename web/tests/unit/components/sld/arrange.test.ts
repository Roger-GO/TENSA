/**
 * Align and distribute (`arrange.ts`): which nodes move, and where to.
 *
 * A box is a node's position and the box that is lined up, relative to it:
 * the bar of a bus, or the box a device is drawn in.
 */
import { describe, expect, it } from 'vitest';
import {
  ALIGN_LABEL,
  DISTRIBUTE_LABEL,
  alignBoxes,
  distributeBoxes,
  type ArrangeBox,
} from '@/components/sld/arrange';

/** A bar: 92 long and 6 thick, at the node's own position. */
function bar(id: string, x: number, y: number): ArrangeBox {
  return { id, x, y, left: 0, top: 0, width: 92, height: 6 };
}

/** A device drawn in a 40 x 40 box. */
function device(id: string, x: number, y: number): ArrangeBox {
  return { id, x, y, left: 0, top: 0, width: 40, height: 40 };
}

describe('alignBoxes', () => {
  const boxes = [bar('a', 100, 50), bar('b', 30, 200), device('c', 260, 120)];

  it('brings the left edges onto the leftmost one', () => {
    expect(alignBoxes(boxes, 'left')).toEqual({ a: { x: 30, y: 50 }, c: { x: 30, y: 120 } });
  });

  it('brings the right edges onto the rightmost one', () => {
    // The device ends at 300: a bar of 92 then starts at 208.
    expect(alignBoxes(boxes, 'right')).toEqual({ a: { x: 208, y: 50 }, b: { x: 208, y: 200 } });
  });

  it('centres every box on the middle of the selection', () => {
    // The selection reaches from 30 to 300: its middle is 165.
    expect(alignBoxes(boxes, 'centre')).toEqual({
      a: { x: 119, y: 50 },
      b: { x: 119, y: 200 },
      c: { x: 145, y: 120 },
    });
  });

  it('brings the tops onto the topmost one, the bottoms onto the lowest', () => {
    expect(alignBoxes(boxes, 'top')).toEqual({ b: { x: 30, y: 50 }, c: { x: 260, y: 50 } });
    // The lowest bottom is that of bar b: 206.
    expect(alignBoxes(boxes, 'bottom')).toEqual({ a: { x: 100, y: 200 }, c: { x: 260, y: 166 } });
  });

  it('puts the middle of a device on the line of a bar', () => {
    // From 50 to 206: the middle is 128, where the bars' centre lines go.
    const moves = alignBoxes(boxes, 'middle');
    expect(moves.a).toEqual({ x: 100, y: 125 });
    expect(moves.b).toEqual({ x: 30, y: 125 });
    expect(moves.c).toEqual({ x: 260, y: 108 });
  });

  it('lines up the box, not the node, where the two differ', () => {
    const offset: ArrangeBox = { id: 'o', x: 0, y: 0, left: 20, top: 10, width: 30, height: 30 };
    expect(alignBoxes([offset, device('d', 100, 100)], 'left')).toEqual({ d: { x: 20, y: 100 } });
  });

  it('moves nothing with fewer than two boxes, or when they are in line already', () => {
    expect(alignBoxes([bar('a', 0, 0)], 'left')).toEqual({});
    expect(alignBoxes([bar('a', 10, 0), bar('b', 10, 80)], 'left')).toEqual({});
  });

  it('puts what it moves on the grid when asked to snap', () => {
    const moves = alignBoxes([bar('a', 35, 0), bar('b', 100, 80)], 'left', 16);
    expect(moves).toEqual({ b: { x: 32, y: 80 } });
  });
});

describe('distributeBoxes', () => {
  it('evens out the gaps between the boxes, and leaves the two outermost', () => {
    const boxes = [bar('a', 0, 0), bar('b', 100, 40), bar('c', 500, 80)];
    // From 0 to 592 with three bars of 92: two gaps of 158.
    expect(distributeBoxes(boxes, 'horizontal')).toEqual({ b: { x: 250, y: 40 } });
  });

  it('works down the page as well, on boxes of different heights', () => {
    const boxes = [bar('a', 0, 0), device('b', 0, 20), bar('c', 0, 200), bar('d', 0, 400)];
    // From 0 to 406: 406 - (6 + 40 + 6 + 6) = 348 in three gaps of 116.
    expect(distributeBoxes(boxes, 'vertical')).toEqual({
      b: { x: 0, y: 122 },
      c: { x: 0, y: 278 },
    });
  });

  it('takes the boxes in the order they stand in, whatever order they are given in', () => {
    const boxes = [bar('c', 500, 0), bar('a', 0, 0), bar('b', 100, 0)];
    expect(distributeBoxes(boxes, 'horizontal')).toEqual({ b: { x: 250, y: 0 } });
  });

  it('moves nothing with fewer than three boxes, or when they are even already', () => {
    expect(distributeBoxes([bar('a', 0, 0), bar('b', 300, 0)], 'horizontal')).toEqual({});
    expect(
      distributeBoxes([bar('a', 0, 0), bar('b', 200, 0), bar('c', 400, 0)], 'horizontal'),
    ).toEqual({});
  });

  it('puts what it moves on the grid when asked to snap', () => {
    const boxes = [bar('a', 0, 0), bar('b', 100, 0), bar('c', 500, 0)];
    expect(distributeBoxes(boxes, 'horizontal', 16)).toEqual({ b: { x: 256, y: 0 } });
  });
});

describe('the names of the arrangements', () => {
  it('names each alignment and each distribution', () => {
    expect(Object.values(ALIGN_LABEL)).toEqual([
      'Align left',
      'Align centre',
      'Align right',
      'Align top',
      'Align middle',
      'Align bottom',
    ]);
    expect(Object.values(DISTRIBUTE_LABEL)).toEqual([
      'Distribute horizontally',
      'Distribute vertically',
    ]);
  });
});
