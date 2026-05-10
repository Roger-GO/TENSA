/**
 * Tests for `<Input />` (Unit 5 of v2.0 polish).
 *
 * The contract under test:
 *
 * 1. Happy path — typed text fires onChange on every keystroke with
 *    the new full value.
 * 2. Paste — clipboard insertion fires onChange once with the pasted
 *    value (replicates real browser behaviour).
 * 3. IME composition — onChange does NOT fire mid-composition;
 *    fires once on compositionend with the final value.
 * 4. React-friendly programmatic value setter — `el.value = 'x'` plus
 *    a bubbling 'input' event propagates through to onChange. This is
 *    the Playwright `locator.fill()` escape hatch that future tests
 *    will rely on.
 * 5. forwardRef — the ref points at the underlying <input> element.
 * 6. Disabled — the input doesn't fire onChange when disabled and
 *    carries the visual disabled style.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRef, useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '@/components/ui/Input';

describe('<Input />', () => {
  it('fires onChange on every keystroke with the new full value', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <Input
          aria-label="field"
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    await userEvent.type(input, 'abc');
    // userEvent fires one onChange per character; the last value is the
    // accumulated string. The harness re-renders on each keystroke
    // (real controlled-component flow), so the input.value advances
    // alongside the parent's React state.
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['a', 'ab', 'abc']);
    expect(input.value).toBe('abc');
  });

  it('paste-from-clipboard fires onChange with the pasted text', async () => {
    const onChange = vi.fn();
    function Harness() {
      return <Input aria-label="field" value="" onChange={onChange} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    input.focus();
    await userEvent.paste('hello-world');
    expect(onChange).toHaveBeenCalledWith('hello-world');
  });

  it('does NOT fire onChange during IME composition; fires once on compositionend', () => {
    const onChange = vi.fn();
    let value = '';
    function Harness() {
      return (
        <Input
          aria-label="field"
          value={value}
          onChange={(next) => {
            value = next;
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('field') as HTMLInputElement;

    // Start composition (e.g., user typed 'n' in an IME, expecting hiragana).
    fireEvent.compositionStart(input, { data: '' });

    // Intermediate input events while composing — these should NOT
    // propagate to the parent. We update the DOM value directly first
    // to mirror what the IME does in a real browser.
    input.value = 'n';
    fireEvent.input(input, { data: 'n', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();

    input.value = 'ni';
    fireEvent.input(input, { data: 'ni', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();

    // Final 'input' event with the composed character lands…
    input.value = 'に';
    fireEvent.input(input, { data: 'に', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();

    // …and then compositionend fires. THIS is when we surface the value.
    fireEvent.compositionEnd(input, { data: 'に' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('に');
  });

  it('after composition ends, regular keystrokes resume firing onChange', () => {
    const onChange = vi.fn();
    function Harness() {
      return <Input aria-label="field" value="" onChange={onChange} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('field') as HTMLInputElement;

    fireEvent.compositionStart(input);
    input.value = 'a';
    fireEvent.input(input, { isComposing: true });
    fireEvent.compositionEnd(input);

    // 1 call for the compositionend handler.
    expect(onChange).toHaveBeenCalledTimes(1);

    // A subsequent regular keystroke still propagates.
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('ab');
  });

  it('React-friendly programmatic setter propagates to onChange', () => {
    // This mirrors the Playwright `locator.fill()` workaround the
    // Phase 2 smoke documented (see `web/AGENTS.md`). The trick:
    // `el.value = 'x'` alone does NOT trigger React's onChange because
    // React caches the previous value on the input's prototype-level
    // setter and bypasses the native set. We have to call the native
    // setter directly, then dispatch a bubbling 'input' event.
    const onChange = vi.fn();
    function Harness() {
      return <Input aria-label="field" value="" onChange={onChange} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('field') as HTMLInputElement;

    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    );
    descriptor!.set!.call(input, 'pasted-by-test');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith('pasted-by-test');
  });

  it('forwards the ref to the underlying <input>', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input aria-label="field" value="" onChange={() => {}} ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('disabled prevents onChange and applies the disabled style', async () => {
    const onChange = vi.fn();
    render(<Input aria-label="field" value="" onChange={onChange} disabled />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(input.className).toMatch(/disabled:opacity-60/);
    await userEvent.type(input, 'abc');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts standard HTML attributes (placeholder, type, autoFocus)', () => {
    render(
      <Input
        aria-label="token"
        value=""
        onChange={() => {}}
        placeholder="paste here"
        type="password"
        autoFocus
      />,
    );
    const input = screen.getByLabelText('token') as HTMLInputElement;
    expect(input).toHaveAttribute('placeholder', 'paste here');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveFocus();
  });

  it('parent-controlled value drives the displayed value', () => {
    const { rerender } = render(
      <Input aria-label="field" value="initial" onChange={() => {}} />,
    );
    const input = screen.getByLabelText('field') as HTMLInputElement;
    expect(input.value).toBe('initial');

    rerender(<Input aria-label="field" value="updated" onChange={() => {}} />);
    expect(input.value).toBe('updated');
  });
});
