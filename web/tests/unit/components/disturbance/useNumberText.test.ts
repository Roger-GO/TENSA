/**
 * useNumberText: the text of a number field, which follows the number only
 * when the number is set from outside.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNumberText } from '@/components/disturbance/useNumberText';

describe('useNumberText', () => {
  it('starts as the number', () => {
    const { result } = renderHook(({ value }) => useNumberText(value), {
      initialProps: { value: 1.1 },
    });
    expect(result.current[0]).toBe('1.1');
  });

  it('keeps what the user typed when the number it stands for is already the spec', () => {
    const { result, rerender } = renderHook(({ value }) => useNumberText(value), {
      initialProps: { value: 1 },
    });
    // "1.0" and "1" are the same number: the field is not rewritten under the user's cursor.
    act(() => result.current[1]('1.0'));
    rerender({ value: 1 });
    expect(result.current[0]).toBe('1.0');
  });

  it('does not write NaN into a field that was emptied, nor drop a typed minus sign', () => {
    const { result, rerender } = renderHook(({ value }) => useNumberText(value), {
      initialProps: { value: 0.2 },
    });
    // The form turns the text into a number on every keystroke: empty and "-" are NaN.
    act(() => result.current[1](''));
    rerender({ value: Number.NaN });
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('-'));
    rerender({ value: Number.NaN });
    expect(result.current[0]).toBe('-');
    act(() => result.current[1]('-0.2'));
    rerender({ value: -0.2 });
    expect(result.current[0]).toBe('-0.2');
  });

  it('follows the number when it is set from outside', () => {
    const { result, rerender } = renderHook(({ value }) => useNumberText(value), {
      initialProps: { value: 1.3 },
    });
    rerender({ value: 1.1 });
    expect(result.current[0]).toBe('1.1');
  });

  it('empties the field when the number is set to "not entered" from outside, rather than writing NaN', () => {
    const { result, rerender } = renderHook(({ value }) => useNumberText(value), {
      initialProps: { value: 2 },
    });
    rerender({ value: Number.NaN });
    expect(result.current[0]).toBe('');
  });
});
