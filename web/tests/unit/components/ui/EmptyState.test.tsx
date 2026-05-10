import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChartLineIcon, EmptyState, FolderIcon } from '@/components/ui/EmptyState';

describe('<EmptyState /> (Unit 13 canonical)', () => {
  it('renders title only', () => {
    render(<EmptyState title="Empty here" />);
    expect(screen.getByText('Empty here')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    // status role lets assistive tech announce the state.
    expect(screen.getByRole('status')).toBeInTheDocument();
    // No description, no action.
    expect(screen.queryByTestId('empty-state-action')).toBeNull();
  });

  it('renders title + description', () => {
    render(<EmptyState title="Nothing yet" description="Pick a case to begin." />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByText('Pick a case to begin.')).toBeInTheDocument();
  });

  it('renders an icon hidden from assistive tech', () => {
    render(<EmptyState title="x" icon={<FolderIcon />} />);
    // The wrapper around the icon carries aria-hidden="true".
    const root = screen.getByTestId('empty-state');
    const ariaHidden = root.querySelector('[aria-hidden="true"]');
    expect(ariaHidden).not.toBeNull();
    // The bundled SVG glyphs are also aria-hidden themselves.
    expect(root.querySelector('svg')).not.toBeNull();
  });

  it('renders a CTA button and fires onClick', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No PF result"
        description="Run power flow to see results."
        action={{ label: 'Run PF', onClick }}
      />,
    );
    const cta = screen.getByTestId('empty-state-action');
    expect(cta).toHaveTextContent('Run PF');
    await userEvent.click(cta);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes the optional emptyStateKey via data attribute', () => {
    render(<EmptyState title="x" emptyStateKey="my-key" />);
    const root = screen.getByTestId('empty-state');
    expect(root.getAttribute('data-empty-state-key')).toBe('my-key');
  });

  it('renders all of icon + title + description + action together', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={<ChartLineIcon />}
        title="No results yet"
        description="Run power flow to see results."
        action={{ label: 'Run PF', onClick }}
        emptyStateKey="composed"
      />,
    );
    expect(screen.getByText('No results yet')).toBeInTheDocument();
    expect(screen.getByText('Run power flow to see results.')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state-action')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state').getAttribute('data-empty-state-key')).toBe('composed');
  });
});
