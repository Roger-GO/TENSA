/**
 * Tests for ``useLatest``: the value of the render last committed, read by code
 * that runs outside render (an effect that does not start again when the value
 * changes, a callback a library holds).
 */
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { useLatest } from '@/lib/useLatest';

describe('useLatest', () => {
  it('is the same object at every render, holding the value of the last one', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    });
    const first = result.current;
    expect(first.current).toBe(1);
    rerender({ value: 2 });
    expect(result.current).toBe(first);
    expect(first.current).toBe(2);
  });

  it('holds the value of the render being committed by the time its effects run', () => {
    const seen: string[] = [];
    function Reader({ value, tick }: { value: string; tick: number }) {
      const latest = useLatest(value);
      // Started again by `tick` only: what it reads of `value` comes from the ref.
      useEffect(() => {
        seen.push(latest.current);
      }, [tick, latest]);
      return null;
    }
    const { rerender } = render(<Reader value="a" tick={0} />);
    rerender(<Reader value="b" tick={0} />);
    rerender(<Reader value="c" tick={1} />);
    expect(seen).toEqual(['a', 'c']);
  });

  it('gives a callback made at the first render the value of the newest one', () => {
    let held: (() => number) | null = null;
    function Holder({ value }: { value: number }) {
      const latest = useLatest(value);
      useEffect(() => {
        held = () => latest.current;
      }, [latest]);
      return null;
    }
    const { rerender } = render(<Holder value={1} />);
    rerender(<Holder value={5} />);
    expect(held).not.toBeNull();
    expect(held!()).toBe(5);
  });
});
