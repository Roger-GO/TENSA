import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopBar } from '@/components/shell/TopBar';

describe('TopBar', () => {
  it('renders three slot regions in left/center/right order', () => {
    render(<TopBar left={<span>L</span>} center={<span>C</span>} right={<span>R</span>} />);
    const banner = screen.getByRole('banner');
    const slots = banner.querySelectorAll('[data-slot]');
    expect(slots).toHaveLength(3);
    expect(slots[0]?.getAttribute('data-slot')).toBe('left');
    expect(slots[1]?.getAttribute('data-slot')).toBe('center');
    expect(slots[2]?.getAttribute('data-slot')).toBe('right');
    expect(within(slots[0] as HTMLElement).getByText('L')).toBeInTheDocument();
    expect(within(slots[1] as HTMLElement).getByText('C')).toBeInTheDocument();
    expect(within(slots[2] as HTMLElement).getByText('R')).toBeInTheDocument();
  });

  it('renders empty slot regions when no content is provided', () => {
    render(<TopBar />);
    const banner = screen.getByRole('banner');
    const slots = banner.querySelectorAll('[data-slot]');
    // All three slot wrappers exist even when empty so the flex layout
    // remains predictable.
    expect(slots).toHaveLength(3);
  });

  it('forwards className for caller-side overrides', () => {
    render(<TopBar className="custom-top-bar" />);
    expect(screen.getByRole('banner').className).toMatch(/custom-top-bar/);
  });
});
