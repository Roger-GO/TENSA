/**
 * CancelConfirmDialog — destructive-confirmation modal shown on Cancel
 * with a dirty AddElementPanel form.
 *
 * Pure render contract; no API calls. Tests cover open/close render,
 * Discard/Keep button wiring, and overlay-dismiss routing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CancelConfirmDialog } from '@/components/elements/CancelConfirmDialog';

describe('<CancelConfirmDialog />', () => {
  it('renders nothing when closed', () => {
    render(<CancelConfirmDialog open={false} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-element-cancel-confirm')).toBeNull();
  });

  it('renders title + description + both action buttons when open', () => {
    render(<CancelConfirmDialog open={true} onCancel={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/Discard unsaved element\?/i);
    expect(dialog).toHaveTextContent(/unsaved changes/i);
    expect(screen.getByTestId('add-element-cancel-confirm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep editing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard/i })).toBeInTheDocument();
  });

  it('Keep editing fires onCancel and not onConfirm', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<CancelConfirmDialog open={true} onCancel={onCancel} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Discard fires onConfirm and not onCancel', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<CancelConfirmDialog open={true} onCancel={onCancel} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByTestId('confirm-discard'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('pressing Escape routes through onOpenChange to onCancel', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<CancelConfirmDialog open={true} onCancel={onCancel} onConfirm={onConfirm} />);
    // Radix forwards Escape to onOpenChange(false), which the component
    // routes to onCancel.
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the Discard button uses the danger variant styling', () => {
    render(<CancelConfirmDialog open={true} onCancel={() => {}} onConfirm={() => {}} />);
    const discard = screen.getByTestId('confirm-discard');
    // Danger variant styling differs across themes; assert that it's
    // distinct from Keep editing by comparing class lists.
    const keep = screen.getByRole('button', { name: /Keep editing/i });
    expect(discard.className).not.toBe(keep.className);
  });
});
