/**
 * Tests for `lazyNamed`: it loads a module's named export on first render, keeps
 * the component's props, and turns a failed chunk load into a message (a panel)
 * or a toast (an overlay) instead of an unmounted app.
 */
import { Suspense, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastError = vi.fn<(message: string, opts?: unknown) => string>();
vi.mock('@/lib/toast', () => ({
  toast: { error: (message: string, opts?: unknown) => toastError(message, opts) },
}));

import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';

const FAILED_TITLE = 'This part of the app did not load';

type GreetingModule = { Greeting: typeof Greeting };

/** A loader whose chunk cannot be fetched. */
function failingLoad(message = 'Failed to fetch dynamically imported module') {
  return () => Promise.reject<GreetingModule>(new Error(message));
}

function Greeting({ name }: { name: string }) {
  return <p data-testid="greeting">Hello, {name}</p>;
}

beforeEach(() => {
  toastError.mockReset();
  // The loader logs the failure it swallows; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('lazyNamed', () => {
  it('renders the named export with its props once the module has loaded', async () => {
    const Lazy = lazyNamed(() => Promise.resolve({ Greeting, other: 1 }), 'Greeting');
    render(
      <Suspense fallback={<span data-testid="pending" />}>
        <Lazy name="TENSA" />
      </Suspense>,
    );
    expect(await screen.findByTestId('greeting')).toHaveTextContent('Hello, TENSA');
  });

  it('does not call the loader until the component is first rendered', async () => {
    const load = vi.fn(() => Promise.resolve({ Greeting }));
    const Lazy = lazyNamed(load, 'Greeting');
    expect(load).not.toHaveBeenCalled();
    render(
      <Suspense fallback={null}>
        <Lazy name="x" />
      </Suspense>,
    );
    expect(await screen.findByTestId('greeting')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows the Suspense fallback while the chunk is loading', async () => {
    let release: (mod: { Greeting: typeof Greeting }) => void = () => undefined;
    const Lazy = lazyNamed(
      () =>
        new Promise<{ Greeting: typeof Greeting }>((resolve) => {
          release = resolve;
        }),
      'Greeting',
    );
    render(
      <Suspense fallback={<span data-testid="pending" />}>
        <Lazy name="x" />
      </Suspense>,
    );
    expect(screen.getByTestId('pending')).toBeInTheDocument();
    release({ Greeting });
    expect(await screen.findByTestId('greeting')).toBeInTheDocument();
    expect(screen.queryByTestId('pending')).not.toBeInTheDocument();
  });

  it('renders a reload prompt in place of a panel whose chunk failed to load', async () => {
    const Lazy = lazyNamed(failingLoad(), 'Greeting');
    render(
      <Suspense fallback={null}>
        <Lazy name="x" />
      </Suspense>,
    );
    expect(await screen.findByText(FAILED_TITLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts, and renders nothing, when an overlay chunk fails to load', async () => {
    const Lazy = lazyNamed(failingLoad(), 'Greeting', 'overlay');
    const { container } = render(
      <Suspense fallback={null}>
        <Lazy name="x" />
      </Suspense>,
    );
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toMatch(/could not be loaded/i);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(FAILED_TITLE)).not.toBeInTheDocument();
  });

  it('does not take the surrounding tree down when the chunk fails', async () => {
    const Lazy = lazyNamed(failingLoad('gone'), 'Greeting');
    render(
      <div>
        <span data-testid="sibling">still here</span>
        <Suspense fallback={null}>
          <Lazy name="x" />
        </Suspense>
      </div>,
    );
    expect(await screen.findByText(FAILED_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('sibling')).toBeInTheDocument();
  });
});

/**
 * A dialog the way the app mounts one: a flag (a store's, here a state) that a
 * button sets and only the dialog clears, shown through a `LazyMount` that the
 * owner gives a way to clear it.
 */
function DialogOwner({
  Dialog,
  onLoadFailed,
}: {
  Dialog: ReturnType<typeof lazyNamed<GreetingModule, 'Greeting'>>;
  onLoadFailed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <span data-testid="flag">{String(open)}</span>
      <LazyMount
        when={open}
        onLoadFailed={() => {
          onLoadFailed?.();
          setOpen(false);
        }}
      >
        <Dialog name="x" />
      </LazyMount>
    </>
  );
}

describe('an overlay opened after its chunk failed to load', () => {
  it('says so each time it is opened, and lets its owner drop the open flag', async () => {
    const load = vi.fn(failingLoad());
    const Dialog = lazyNamed(load, 'Greeting', 'overlay');
    const onLoadFailed = vi.fn();
    render(<DialogOwner Dialog={Dialog} onLoadFailed={onLoadFailed} />);
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.getByTestId('flag')).toHaveTextContent('false'));
    expect(onLoadFailed).toHaveBeenCalledTimes(1);

    // The flag is clear, so the second click is a change the mount can see.
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.getByTestId('flag')).toHaveTextContent('false'));
    expect(onLoadFailed).toHaveBeenCalledTimes(2);

    // The failure is kept, not retried: the chunk was asked for once.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not call onLoadFailed, or toast, when the overlay loads', async () => {
    const Dialog = lazyNamed(() => Promise.resolve({ Greeting }), 'Greeting', 'overlay');
    const onLoadFailed = vi.fn();
    render(<DialogOwner Dialog={Dialog} onLoadFailed={onLoadFailed} />);

    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByTestId('greeting')).toBeInTheDocument();
    expect(onLoadFailed).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByTestId('flag')).toHaveTextContent('true');
  });
});
