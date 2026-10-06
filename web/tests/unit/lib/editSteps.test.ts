/**
 * The words Undo and Redo use for the edit they would act on.
 */
import { describe, expect, it } from 'vitest';

import { describeStep } from '@/lib/editSteps';
import type { EditStep } from '@/api/types';

const step = (over: Partial<EditStep> & Pick<EditStep, 'op'>): EditStep => ({
  model: 'Bus',
  idx: 3,
  params: [],
  also: 0,
  ...over,
});

describe('describeStep', () => {
  it('names an add and a delete by the element', () => {
    expect(describeStep(step({ op: 'add', idx: 15 }))).toBe('add Bus 15');
    expect(describeStep(step({ op: 'delete', model: 'Line', idx: 'Line_3' }))).toBe(
      'delete Line Line_3',
    );
  });

  it('says how many went with a deleted element', () => {
    expect(describeStep(step({ op: 'delete', also: 4 }))).toBe('delete Bus 3 and 4 more');
  });

  it('names what an edit changed, up to three params', () => {
    expect(describeStep(step({ op: 'edit', params: ['Vn'] }))).toBe('change Vn of Bus 3');
    expect(describeStep(step({ op: 'edit', params: ['r', 'x', 'b'] }))).toBe(
      'change r, x, b of Bus 3',
    );
    expect(describeStep(step({ op: 'edit', params: ['r', 'x', 'b', 'g', 'tap'] }))).toBe(
      'change r, x, b and 2 more of Bus 3',
    );
    expect(describeStep(step({ op: 'edit' }))).toBe('change Bus 3');
  });

  it('falls back to the model for an element without an idx', () => {
    expect(describeStep(step({ op: 'add', idx: null }))).toBe('add Bus');
  });
});
