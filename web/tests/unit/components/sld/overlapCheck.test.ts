/**
 * The overlap checker (`overlapCheck.ts`): what counts as two things of the
 * diagram being drawn on each other, one rule at a time, each with the
 * nearest drawing that keeps the rule beside the one that breaks it.
 *
 * A bar is given by its two tips and the height of its centre line, a line
 * by the points it runs through and what it is drawn from and to, and a box
 * by its edges. `noOverlap.test.ts` holds the example cases to the same
 * checker, drawn whole.
 */
import { describe, expect, it } from 'vitest';
import { BEND_CLEAR, type Point } from '@/components/sld/connections';
import {
  LINE_GAP,
  countCrossings,
  describeOverlaps,
  findOverlaps,
  type DrawnBar,
  type DrawnBox,
  type DrawnDiagram,
  type DrawnLine,
} from '@/components/sld/overlapCheck';

function line(id: string, points: Point[], from = `${id}:from`, to = `${id}:to`): DrawnLine {
  return { id, points, from, to };
}

function bar(id: string, left: number, right: number, y: number): DrawnBar {
  return { id, left, right, y };
}

function box(
  id: string,
  kind: DrawnBox['kind'],
  [left, top, right, bottom]: [number, number, number, number],
  of?: string[],
): DrawnBox {
  return { id, kind, box: { left, top, right, bottom }, ...(of ? { of } : {}) };
}

function check(drawn: Partial<DrawnDiagram>, options?: Parameters<typeof findOverlaps>[1]) {
  return findOverlaps({ lines: [], bars: [], boxes: [], ...drawn }, options).map(
    ({ kind, a, b }) => `${kind} ${a} ${b}`,
  );
}

describe('findOverlaps: two lines', () => {
  it('finds one line drawn on top of another, however short the stretch they share', () => {
    const a = line('a', [
      [0, 0],
      [0, 100],
    ]);
    expect(
      check({
        lines: [
          a,
          line('b', [
            [0, 90],
            [0, 200],
          ]),
        ],
      }),
    ).toEqual(['line-line a b']);
    // End to end they share no stretch, and with nothing between the two
    // ends they still read as one line.
    const below = (from: number): string[] =>
      check({
        lines: [
          a,
          line('b', [
            [0, from],
            [0, 200],
          ]),
        ],
      });
    expect(below(100.5)).toEqual(['line-line a b']);
    expect(below(100 + BEND_CLEAR)).toEqual([]);
  });

  it('finds two runs side by side nearer than the gap, and none at the gap', () => {
    const beside = (apart: number): string[] =>
      check({
        lines: [
          line('a', [
            [0, 0],
            [200, 0],
          ]),
          line('b', [
            [50, apart],
            [150, apart],
          ]),
        ],
      });
    expect(beside(LINE_GAP - 2)).toEqual(['line-line a b']);
    expect(beside(4)).toEqual(['line-line a b']);
    expect(beside(LINE_GAP)).toEqual([]);
    expect(beside(16)).toEqual([]);
  });

  it('takes two runs that pass each other end to end, without a stretch side by side, as apart', () => {
    expect(
      check({
        lines: [
          line('a', [
            [0, 0],
            [100, 0],
          ]),
          line('b', [
            [100.5, 6],
            [200, 6],
          ]),
        ],
      }),
    ).toEqual([]);
  });

  it('finds two lines at an angle that lie on each other, and not two that only run the same way', () => {
    const slanted = (shift: number): string[] =>
      check({
        lines: [
          line('a', [
            [0, 0],
            [100, 50],
          ]),
          line('b', [
            [20 + shift, 10],
            [80 + shift, 40],
          ]),
        ],
      });
    expect(slanted(0)).toEqual(['line-line a b']);
    expect(slanted(40)).toEqual([]);
  });

  it('takes a crossing, each line in the middle of a run, as no overlap', () => {
    const lines = [
      line('a', [
        [0, 50],
        [100, 50],
      ]),
      line('b', [
        [50, 0],
        [50, 100],
      ]),
    ];
    expect(check({ lines })).toEqual([]);
    expect(countCrossings(lines)).toBe(1);
  });

  it('finds a line that ends on another, and one that turns on another', () => {
    const through = line('a', [
      [0, 50],
      [100, 50],
    ]);
    // A T: it would read as a junction.
    expect(
      check({
        lines: [
          through,
          line('b', [
            [50, 0],
            [50, 50],
          ]),
        ],
      }),
    ).toEqual(['line-line a b']);
    // A corner laid on the other line.
    expect(
      check({
        lines: [
          through,
          line('b', [
            [50, 0],
            [50, 50.5],
            [51, 120],
          ]),
        ],
      }),
    ).toEqual(['line-line a b']);
    // The corner a clear way past it: a crossing.
    expect(
      check({
        lines: [
          through,
          line('b', [
            [50, 0],
            [50, 70],
            [120, 70],
          ]),
        ],
      }),
    ).toEqual([]);
  });

  it('finds a bend right beside another line, short of it or just past it, and none a clear way off', () => {
    const upright = line('a', [
      [48, 0],
      [48, 200],
    ]);
    // The point of a `<` at `x`: with its corner by the upright it reads as
    // a line that joins it there, a `K`.
    const corner = (x: number): string[] =>
      describeOverlaps(
        findOverlaps({
          lines: [
            upright,
            line('b', [
              [160, 30],
              [x, 100],
              [160, 170],
            ]),
          ],
          bars: [],
          boxes: [],
        }),
      );
    expect(corner(50)).toEqual(['line-line: a / b: the second turns 2.0 px from the other']);
    // Past it by a pixel the two runs cross it, one right after the other.
    expect(corner(47)).toEqual(['line-line: a / b: the second turns 1.0 px from the other']);
    expect(corner(48 + BEND_CLEAR - 1)).toHaveLength(1);
    expect(corner(48 - BEND_CLEAR + 1)).toHaveLength(1);
    // A clear way short of it, and a clear way past it, where it crosses twice.
    expect(corner(48 + BEND_CLEAR)).toEqual([]);
    expect(corner(48 - BEND_CLEAR)).toEqual([]);
    expect(corner(20)).toEqual([]);
  });

  it('finds two lines that turn corner to corner, and says which one where only one turns', () => {
    // Each turns just short of the other: together the two bends read as a crossing.
    expect(
      describeOverlaps(
        findOverlaps({
          lines: [
            line('a', [
              [0, 103],
              [96, 103],
              [96, 200],
            ]),
            line('b', [
              [97.5, 0],
              [97.5, 100],
              [200, 100],
            ]),
          ],
          bars: [],
          boxes: [],
        }),
      ),
    ).toEqual(['line-line: a / b: the first turns 3.4 px from the other']);
    // Corner to corner, a clear way apart.
    expect(
      check({
        lines: [
          line('a', [
            [0, 106],
            [90, 106],
            [90, 200],
          ]),
          line('b', [
            [97.5, 0],
            [97.5, 100],
            [200, 100],
          ]),
        ],
      }),
    ).toEqual([]);
  });

  it('finds an end that is on no bar right beside another line, and holds an end on a bar to the taps instead', () => {
    const b = bar('bus', 0, 92, 103);
    const passing = line('a', [
      [-40, 60],
      [140, 60],
    ]);
    // The connector of a device, out of the face of its symbol at 46, 64.
    const connector = (from: number): DrawnLine =>
      line(
        'b',
        [
          [46, from],
          [46, 103],
        ],
        'device',
        'bus',
      );
    expect(
      describeOverlaps(findOverlaps({ lines: [passing, connector(64)], bars: [b], boxes: [] })),
    ).toEqual(['line-line: a / b: the second ends 4.0 px from the other']);
    expect(check({ lines: [passing, connector(60 + BEND_CLEAR)], bars: [b] })).toEqual([]);
    // The end of a line on its bar is beside the lines that end next to it
    // there: what holds it is the spacing of the taps.
    expect(
      check({
        lines: [
          line(
            'a',
            [
              [40, 103],
              [40, 0],
            ],
            'bus',
          ),
          line(
            'b',
            [
              [54, 103],
              [54, 200],
            ],
            'bus',
          ),
        ],
        bars: [b],
      }),
    ).toEqual([]);
  });

  it('never holds a line against itself', () => {
    expect(
      check({
        lines: [
          line('a', [
            [0, 0],
            [0, 50],
            [6, 50],
            [6, 0],
          ]),
        ],
      }),
    ).toEqual([]);
  });
});

describe('findOverlaps: the ends on a bar', () => {
  const b = bar('bus', 0, 92, 3);
  const down = (id: string, x: number): DrawnLine =>
    line(
      id,
      [
        [x, -60],
        [x, 3],
      ],
      `${id}:device`,
      'bus',
    );
  const up = (id: string, x: number): DrawnLine =>
    line(
      id,
      [
        [x, 3],
        [x, 80],
      ],
      'bus',
      `${id}:far`,
    );

  it('finds two that come to one place from above and from below', () => {
    expect(check({ bars: [b], lines: [down('a', 40), up('b', 40)] })).toEqual(['shared-tap a b']);
  });

  it('finds two nearer than the spacing, whichever face each comes to', () => {
    expect(check({ bars: [b], lines: [down('a', 40), up('b', 50)] })).toEqual(['shared-tap a b']);
    // On one face the two lines also run side by side, too close.
    expect(check({ bars: [b], lines: [down('a', 40), down('b', 48)] })).toEqual([
      'line-line a b',
      'shared-tap a b',
    ]);
  });

  it('takes ends a spacing apart, on one face or on two, as each in its own place', () => {
    expect(check({ bars: [b], lines: [down('a', 40), up('b', 54)] })).toEqual([]);
    expect(check({ bars: [b], lines: [down('a', 40), down('b', 54)] })).toEqual([]);
    // The spacing can be set.
    expect(check({ bars: [b], lines: [down('a', 40), up('b', 54)] }, { tapSpacing: 20 })).toEqual([
      'shared-tap a b',
    ]);
  });

  it('finds a line that passes over the dot of the end beside its own on the way to its tap', () => {
    // From the side, across the end of `b` a spacing along the bar: it reads
    // as ending there, and it lies along its own bar as well.
    const across = line(
      'a',
      [
        [-20, -17],
        [54, 3],
      ],
      'a:device',
      'bus',
    );
    const found = findOverlaps({ bars: [b], lines: [across, down('b', 40)], boxes: [] });
    expect(found.map(({ kind, a, b: other }) => `${kind} ${a} ${other}`)).toEqual([
      'line-tap a b',
      'line-bar a bus',
    ]);
    expect(describeOverlaps(found)[0]).toMatch(/passes 3\.\d px from the end of the other/);
    // The same from under the bar, over the dot of an end that comes from above.
    const under = line(
      'a',
      [
        [54, 3],
        [-20, 23],
      ],
      'bus',
      'a:far',
    );
    expect(check({ bars: [b], lines: [under, down('b', 40)] })).toEqual([
      'line-tap a b',
      'line-bar a bus',
    ]);
    // Down to its own tap at a slant that keeps off the dot: each in its own place.
    const clear = line(
      'a',
      [
        [84, -57],
        [54, 3],
      ],
      'a:device',
      'bus',
    );
    expect(check({ bars: [b], lines: [clear, down('b', 40)] })).toEqual([]);
  });

  it('finds an end that is not on its bar', () => {
    expect(check({ bars: [b], lines: [down('a', 120)] })).toEqual(['loose-end a bus']);
    expect(
      check({
        bars: [b],
        lines: [
          line(
            'a',
            [
              [40, -60],
              [40, -8],
            ],
            'a:device',
            'bus',
          ),
        ],
      }),
    ).toEqual(['loose-end a bus']);
  });
});

describe('findOverlaps: a line and a bar', () => {
  const b = bar('bus', 100, 192, 53);

  it('finds a line that runs through a bar it has nothing to do with, or close along it', () => {
    const across = (y: number): string[] =>
      check({
        bars: [b],
        lines: [
          line('a', [
            [0, y],
            [300, y],
          ]),
        ],
      });
    expect(across(53)).toEqual(['line-bar a bus']);
    // Just over the bar: it reads as running along it.
    expect(across(46)).toEqual(['line-bar a bus']);
    expect(across(30)).toEqual([]);
    // Straight through.
    expect(
      check({
        bars: [b],
        lines: [
          line('a', [
            [150, 0],
            [150, 120],
          ]),
        ],
      }),
    ).toEqual(['line-bar a bus']);
    // Past the tip, clear of it.
    expect(
      check({
        bars: [b],
        lines: [
          line('a', [
            [200, 0],
            [200, 120],
          ]),
        ],
      }),
    ).toEqual([]);
  });

  it('finds a level run that comes up to the tip of a bar in line with it', () => {
    const upTo = (x: number): string[] =>
      check({
        bars: [b],
        lines: [
          line('a', [
            [x, 53],
            [400, 53],
            [400, 200],
          ]),
        ],
      });
    expect(upTo(200)).toEqual(['line-bar a bus']);
    expect(upTo(240)).toEqual([]);
  });

  it('finds a branch that leaves its own bar in line with it', () => {
    const other = bar('other', 300, 392, 53);
    expect(
      check({
        bars: [b, other],
        lines: [
          line(
            'a',
            [
              [189, 53],
              [303, 53],
            ],
            'bus',
            'other',
          ),
        ],
      }),
    ).toEqual(['line-bar a bus', 'line-bar a other']);
    // By the faces, bridging over, it keeps the rule.
    expect(
      check({
        bars: [b, other],
        lines: [
          line(
            'a',
            [
              [180, 53],
              [180, 20],
              [310, 20],
              [310, 53],
            ],
            'bus',
            'other',
          ),
        ],
      }),
    ).toEqual([]);
  });

  it('lets the connector of a device beside its bar run into the tip, and no further', () => {
    const intoTip = line(
      'stub',
      [
        [240, 53],
        [189, 53],
      ],
      'device',
      'bus',
    );
    expect(check({ bars: [b], lines: [intoTip] })).toEqual([]);
    const alongBar = line(
      'stub',
      [
        [240, 53],
        [150, 53],
      ],
      'device',
      'bus',
    );
    expect(check({ bars: [b], lines: [alongBar] })).toEqual(['line-bar stub bus']);
  });

  it('finds a line that comes to its own bar too flat and runs along it, from either face', () => {
    /** The connector of a device that ends in the middle of the bar, come from `dx` to the side and `dy` over it. */
    const slanted = (dx: number, dy: number): string[] =>
      check({
        bars: [b],
        lines: [
          line(
            'stub',
            [
              [146 + dx, 53 - dy],
              [146, 53],
            ],
            'device',
            'bus',
          ),
        ],
      });
    // 12 degrees: next to the bar for most of its length.
    expect(slanted(96, 20)).toEqual(['line-bar stub bus']);
    expect(slanted(-96, 20)).toEqual(['line-bar stub bus']);
    expect(slanted(72, -11)).toEqual(['line-bar stub bus']);
    // 30 degrees and steeper: it comes to the bar.
    expect(slanted(52, 30)).toEqual([]);
    expect(slanted(30, 30)).toEqual([]);
    expect(slanted(-30, -30)).toEqual([]);
    expect(slanted(0, 40)).toEqual([]);
    // A branch is held to it at both of its ends.
    const branch = line(
      'a',
      [
        [146, 53],
        [240, 70],
        [240, 200],
      ],
      'bus',
      'a:far',
    );
    expect(check({ bars: [b], lines: [branch] })).toEqual(['line-bar a bus']);
  });

  it('lets a line come to the tip of its bar from beyond it at any angle', () => {
    // Beside the bar only for its last few pixels: it does not run along it.
    const fromBeyond = (dy: number): string[] =>
      check({
        bars: [b],
        lines: [
          line(
            'stub',
            [
              [260, 53 - dy],
              [189, 53],
            ],
            'device',
            'bus',
          ),
        ],
      });
    expect(fromBeyond(12)).toEqual([]);
    expect(fromBeyond(-12)).toEqual([]);
    expect(fromBeyond(40)).toEqual([]);
  });

  it('finds a line that comes back through its own bar after it has left it', () => {
    expect(
      check({
        bars: [b],
        lines: [
          line(
            'a',
            [
              [120, 53],
              [120, 100],
              [170, 100],
              [170, 0],
            ],
            'bus',
            'a:far',
          ),
        ],
      }),
    ).toEqual(['line-bar a bus']);
  });
});

describe('findOverlaps: boxes', () => {
  const across = line(
    'a',
    [
      [0, 50],
      [200, 50],
    ],
    'device',
    'a:to',
  );

  it('finds a line through a symbol, a block, a label or a readout', () => {
    for (const kind of ['symbol', 'block', 'label', 'readout'] as const) {
      expect(check({ lines: [across], boxes: [box('box', kind, [80, 30, 120, 70])] })).toEqual([
        'line-box a box',
      ]);
    }
  });

  it('takes a line along the edge of a box, or past it, as clear of it', () => {
    expect(check({ lines: [across], boxes: [box('box', 'symbol', [80, 50, 120, 90])] })).toEqual(
      [],
    );
    expect(check({ lines: [across], boxes: [box('box', 'symbol', [80, 60, 120, 90])] })).toEqual(
      [],
    );
  });

  it('lets a line run into the device it is drawn from, and through what is drawn on it', () => {
    // Its own device, where it starts.
    expect(check({ lines: [across], boxes: [box('device', 'symbol', [-20, 30, 20, 70])] })).toEqual(
      [],
    );
    // Its own label, and the symbol of a transformer on it.
    expect(
      check({ lines: [across], boxes: [box('flow', 'label', [80, 41, 120, 59], ['a'])] }),
    ).toEqual([]);
    // The label of another line is in its way all the same.
    expect(
      check({ lines: [across], boxes: [box('flow', 'label', [80, 41, 120, 59], ['b'])] }),
    ).toEqual(['line-box a flow']);
  });

  it('finds two boxes that reach into each other, and not two that touch', () => {
    const one = box('one', 'label', [0, 0, 60, 20]);
    expect(check({ boxes: [one, box('two', 'readout', [50, 10, 110, 30])] })).toEqual([
      'box-box one two',
    ]);
    expect(check({ boxes: [one, box('two', 'readout', [60, 0, 120, 20])] })).toEqual([]);
    expect(check({ boxes: [one, box('two', 'readout', [0, 20, 60, 40])] })).toEqual([]);
  });

  it('lets a box reach into what it is drawn against', () => {
    const symbol = box('unit', 'symbol', [0, 0, 80, 40]);
    expect(check({ boxes: [symbol, box('chain', 'block', [70, 0, 150, 40], ['unit'])] })).toEqual(
      [],
    );
    expect(check({ boxes: [symbol, box('chain', 'block', [70, 0, 150, 40])] })).toEqual([
      'box-box chain unit',
    ]);
  });

  it('finds a box on a bar, and lets the label of a bus hang right under its own', () => {
    const b = bar('bus', 0, 92, 3);
    expect(check({ bars: [b], boxes: [box('load', 'symbol', [20, -10, 60, 30])] })).toEqual([
      'box-box load bus',
    ]);
    expect(check({ bars: [b], boxes: [box('label', 'label', [20, 6, 80, 46], ['bus'])] })).toEqual(
      [],
    );
    expect(check({ bars: [b], boxes: [box('label', 'label', [20, 2, 80, 42], ['bus'])] })).toEqual(
      [],
    );
  });

  it('counts two boxes as apart while they reach into each other by no more than the slack', () => {
    const boxes = [box('one', 'label', [0, 0, 60, 20]), box('two', 'label', [58.5, 0, 120, 20])];
    expect(check({ boxes })).toEqual(['box-box one two']);
    expect(check({ boxes }, { slack: 2 })).toEqual([]);
  });
});

describe('findOverlaps: what it answers', () => {
  it('answers each pair once, in a fixed order, with what is wrong in words', () => {
    const drawn: DrawnDiagram = {
      bars: [bar('bus', 0, 92, 3)],
      lines: [
        line(
          'b',
          [
            [40, 3],
            [40, 100],
            [10, 100],
            [10, 3],
          ],
          'bus',
          'bus',
        ),
        line('a', [
          [40, 20],
          [40, 90],
        ]),
      ],
      boxes: [],
    };
    const found = findOverlaps(drawn);
    expect(found.map(({ kind }) => kind)).toEqual(['line-line']);
    expect(describeOverlaps(found)).toEqual(['line-line: b / a: lie on each other for 70 px']);
    expect(findOverlaps(drawn)).toEqual(found);
  });

  it('finds nothing on an empty diagram', () => {
    expect(findOverlaps({ lines: [], bars: [], boxes: [] })).toEqual([]);
  });

  it('checks a diagram of several hundred lines in a few milliseconds', () => {
    // A lattice of runs a gap and more apart, each crossing the others.
    const lines: DrawnLine[] = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push(
        line(`h${i}`, [
          [0, 20 * i],
          [6000, 20 * i],
        ]),
        line(`v${i}`, [
          [20 * i + 10, -10],
          [20 * i + 10, 6010],
        ]),
      );
    }
    const started = performance.now();
    expect(findOverlaps({ lines, bars: [], boxes: [] })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
