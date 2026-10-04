/**
 * The job labels the Activity panel, the in-flight chip and the screen-reader
 * announcer print for a job's kind.
 */
import { describe, expect, it } from 'vitest';

import { kindLabel } from '@/components/shell/jobLabels';

describe('kindLabel', () => {
  it('calls the add undo an addition, not an edit, so it is not read as a parameter undo', () => {
    expect(kindLabel('element-undo')).toBe('Undo addition');
  });

  it('names the controller parameter edit jobs like the Edit menu items they come from', () => {
    expect(kindLabel('clone-undo')).toBe('Undo parameter edit');
    expect(kindLabel('clone-redo')).toBe('Redo parameter edit');
    expect(kindLabel('clone-save-as')).toBe('Save parameter edits as case');
    expect(kindLabel('clone-reset')).toBe('Discard parameter edits');
  });

  it('falls back to a title-cased kind for one it has no name for', () => {
    expect(kindLabel('some-new-kind' as never)).toBe('Some New Kind');
  });
});
