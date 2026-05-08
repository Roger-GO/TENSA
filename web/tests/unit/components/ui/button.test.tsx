import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders with default variant + size', () => {
    render(<Button>Run PF</Button>);
    const btn = screen.getByRole('button', { name: 'Run PF' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('forwards custom variant + size to className', () => {
    render(
      <Button variant="ghost" size="sm">
        Cancel
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Cancel' });
    // ghost variant is transparent-by-default; sm is h-8
    expect(btn.className).toMatch(/bg-transparent/);
    expect(btn.className).toMatch(/h-8/);
  });

  it('disabled state prevents click', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run PF
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Run PF' });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick on keyboard activation', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run PF</Button>);
    const btn = screen.getByRole('button', { name: 'Run PF' });
    btn.focus();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('asChild forwards styling to a different element', () => {
    render(
      <Button asChild>
        <a href="/docs">Docs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toBeInTheDocument();
    // styling forwarded through Slot
    expect(link.className).toMatch(/inline-flex/);
  });

  it('respects type="submit" override', () => {
    render(
      <form>
        <Button type="submit">Submit</Button>
      </form>,
    );
    const btn = screen.getByRole('button', { name: 'Submit' });
    expect(btn).toHaveAttribute('type', 'submit');
  });
});
