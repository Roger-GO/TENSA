import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/shell/EmptyState';

describe('EmptyState', () => {
  it('renders title, description, and action when supplied', () => {
    render(
      <EmptyState
        title="Nothing here yet"
        description="Pick a case file to begin."
        action={<button type="button">Browse</button>}
      />,
    );
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    expect(screen.getByText('Pick a case file to begin.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
    // status role lets assistive tech announce the state.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders with only a title', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.getByText('Empty')).toBeInTheDocument();
    // Description should not be rendered.
    expect(screen.queryByText('Pick a case')).not.toBeInTheDocument();
  });

  it('renders the icon hidden from assistive tech', () => {
    render(<EmptyState title="x" icon={<svg data-testid="ico" aria-hidden="true" />} />);
    const icon = screen.getByTestId('ico');
    expect(icon).toBeInTheDocument();
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
