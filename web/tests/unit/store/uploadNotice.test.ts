import { beforeEach, describe, expect, it } from 'vitest';

import { useUploadNoticeStore } from '@/store/uploadNotice';

beforeEach(() => {
  useUploadNoticeStore.getState().dismiss();
});

describe('useUploadNoticeStore', () => {
  it('starts with nothing to show', () => {
    expect(useUploadNoticeStore.getState().refused).toEqual([]);
  });

  it('shows the lines it is given, and a later show replaces them', () => {
    const { show } = useUploadNoticeStore.getState();
    show(['a.txt is empty.']);
    expect(useUploadNoticeStore.getState().refused).toEqual(['a.txt is empty.']);
    show(['b.zip is not a case file.', 'c.raw is empty.']);
    expect(useUploadNoticeStore.getState().refused).toEqual([
      'b.zip is not a case file.',
      'c.raw is empty.',
    ]);
  });

  it('is cleared by dismiss and by showing nothing', () => {
    const { show, dismiss } = useUploadNoticeStore.getState();
    show(['a.txt is empty.']);
    dismiss();
    expect(useUploadNoticeStore.getState().refused).toEqual([]);
    show(['a.txt is empty.']);
    show([]);
    expect(useUploadNoticeStore.getState().refused).toEqual([]);
  });

  it('does not share the array it was given', () => {
    const lines = ['a.txt is empty.'];
    useUploadNoticeStore.getState().show(lines);
    lines.push('b.txt is empty.');
    expect(useUploadNoticeStore.getState().refused).toEqual(['a.txt is empty.']);
  });
});
