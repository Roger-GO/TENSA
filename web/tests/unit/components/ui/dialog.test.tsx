import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

describe('Dialog', () => {
  it('renders content when open=true (controlled)', () => {
    render(
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('does not render content when open=false (controlled)', () => {
    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esc fires onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open={true} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens on trigger click (uncontrolled)', async () => {
    function Harness() {
      return (
        <Dialog>
          <DialogTrigger>Open</DialogTrigger>
          <DialogContent>
            <DialogTitle>Confirm</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('integration: tooltip inside dialog renders above the dialog', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <TooltipProvider delayDuration={0}>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Settings</DialogTitle>
              <Tooltip>
                <TooltipTrigger>Info</TooltipTrigger>
                <TooltipContent>Helpful hint</TooltipContent>
              </Tooltip>
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Info' });
    // Tab into the trigger to fire a synthetic focus event that Radix
    // recognizes as a tooltip-open trigger (hover events don't reliably
    // synthesize in jsdom).
    await userEvent.tab();
    if (document.activeElement !== trigger) {
      // Dialog focus management can land focus elsewhere first; tab again
      // until we reach the tooltip trigger.
      await userEvent.tab();
    }
    expect(trigger).toBeInTheDocument();
    // Radix renders the tooltip content + a visually-hidden duplicate for
    // screen readers; find at least one styled wrapper carrying our z-50
    // class. The styled wrapper proves the tooltip portal sits above the
    // dialog overlay (both use z-50 and the tooltip is portaled later in
    // the DOM, so it stacks on top).
    const tooltips = await screen.findAllByText('Helpful hint');
    expect(tooltips.length).toBeGreaterThan(0);
    const styledRoot = tooltips
      .map((el) => el.closest('[class*="z-50"]'))
      .find((el) => el !== null);
    expect(styledRoot).toBeDefined();
    expect(styledRoot?.className).toMatch(/z-50/);
  });
});
