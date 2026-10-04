/**
 * Tests for the pieces around lazily loaded code: `LazyMount` (mounts its
 * children on the first request and keeps them), `LoadingPanel` and
 * `LazyLoadFailed`.
 */
import { lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LazyLoadFailed, LazyMount, LoadingPanel } from '@/components/ui/Lazy';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Child() {
  return <p data-testid="child">loaded</p>;
}

describe('<LazyMount />', () => {
  it('does not render, or load, its children while `when` is false', () => {
    const load = vi.fn(() => Promise.resolve({ default: Child }));
    const Lazy = lazy(load);
    render(
      <LazyMount when={false}>
        <Lazy />
      </LazyMount>,
    );
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads and renders its children once `when` turns true', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Child }));
    const Lazy = lazy(load);
    const { rerender } = render(
      <LazyMount when={false}>
        <Lazy />
      </LazyMount>,
    );
    rerender(
      <LazyMount when>
        <Lazy />
      </LazyMount>,
    );
    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps its children mounted after `when` goes back to false', async () => {
    const Lazy = lazy(() => Promise.resolve({ default: Child }));
    const { rerender } = render(
      <LazyMount when>
        <Lazy />
      </LazyMount>,
    );
    expect(await screen.findByTestId('child')).toBeInTheDocument();
    rerender(
      <LazyMount when={false}>
        <Lazy />
      </LazyMount>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('shows the fallback while the chunk is loading', async () => {
    let release: (mod: { default: typeof Child }) => void = () => undefined;
    const Lazy = lazy(
      () =>
        new Promise<{ default: typeof Child }>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <LazyMount when fallback={<span data-testid="pending" />}>
        <Lazy />
      </LazyMount>,
    );
    expect(screen.getByTestId('pending')).toBeInTheDocument();
    release({ default: Child });
    expect(await screen.findByTestId('child')).toBeInTheDocument();
  });
});

describe('<LoadingPanel />', () => {
  it('is a polite status region that says it is loading', () => {
    render(<LoadingPanel />);
    const panel = screen.getByRole('status');
    expect(panel).toHaveAttribute('aria-live', 'polite');
    expect(panel).toHaveTextContent('Loading');
  });
});

describe('<LazyLoadFailed />', () => {
  it('offers a reload and calls location.reload when it is used', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(<LazyLoadFailed />);
      await userEvent.click(screen.getByRole('button', { name: 'Reload page' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
