/**
 * Tests for ``useDepsChanged``: state set from what changed, while rendering,
 * where an effect with the same dependencies would set it after a commit.
 */
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useDepsChanged } from '@/lib/useDepsChanged';

function Watcher({ deps, onChange }: { deps: unknown[]; onChange: () => void }) {
  if (useDepsChanged(deps)) onChange();
  return null;
}

describe('useDepsChanged', () => {
  it('is true at the first render and at each change, as an effect would run', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Watcher deps={['a', 1]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<Watcher deps={['a', 1]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<Watcher deps={['a', 2]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(2);
    rerender(<Watcher deps={['b', 2]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('compares as React compares dependencies (Object.is)', () => {
    const onChange = vi.fn();
    const kept = { a: 1 };
    const other = { a: 1 };
    const { rerender } = render(<Watcher deps={[Number.NaN, kept]} onChange={onChange} />);
    rerender(<Watcher deps={[Number.NaN, kept]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Another object that holds the same is a change.
    rerender(<Watcher deps={[Number.NaN, other]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(2);
    rerender(<Watcher deps={[0, other]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(3);
    rerender(<Watcher deps={[-0, other]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('commits no render with the state of before', () => {
    const committed: string[] = [];
    function Resetting({ item }: { item: string }) {
      const [picked, setPicked] = useState<string | null>(null);
      if (useDepsChanged([item])) setPicked(null);
      useLayoutEffect(() => {
        committed.push(`${item}:${picked ?? '-'}`);
      });
      return (
        <button type="button" onClick={() => setPicked('part')}>
          pick
        </button>
      );
    }
    const { rerender, getByRole } = render(<Resetting item="first" />);
    fireEvent.click(getByRole('button'));
    rerender(<Resetting item="second" />);
    // An effect would have committed "second:part" before it reset the pick.
    expect(committed).toEqual(['first:-', 'first:part', 'second:-']);
  });
});
