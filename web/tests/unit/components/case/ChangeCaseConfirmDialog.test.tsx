/**
 * Tests for `<ChangeCaseConfirmDialog />`.
 *
 * Small file; just verifies the destructive-confirmation render contract
 * (open/close, Cancel and Discard buttons, the "isConfirming" disabled
 * affordance).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeCaseConfirmDialog } from '@/components/case/ChangeCaseConfirmDialog';

describe('<ChangeCaseConfirmDialog />', () => {
  it('renders title + body + cancel + destructive buttons when open', () => {
    render(<ChangeCaseConfirmDialog open={true} onCancel={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/Change case\?/i);
    expect(dialog).toHaveTextContent(
      /Discard current session\? Loaded case \+ PF results will be cleared\./i,
    );
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard & change case/i })).toBeInTheDocument();
  });

  it('says that the kept runs and power flows go too, and how to keep them', () => {
    render(<ChangeCaseConfirmDialog open={true} onCancel={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'So will the runs in History and the power flows kept for comparison, which a reload of the page would have kept.',
    );
    expect(dialog).toHaveTextContent('To keep them, open the other case from Saved cases instead.');
  });

  it('does not render when closed', () => {
    render(<ChangeCaseConfirmDialog open={false} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Cancel fires onCancel; Discard fires onConfirm', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ChangeCaseConfirmDialog open={true} onCancel={onCancel} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Discard & change case/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons + shows progress label while isConfirming', () => {
    render(
      <ChangeCaseConfirmDialog
        open={true}
        onCancel={() => {}}
        onConfirm={() => {}}
        isConfirming={true}
      />,
    );
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Discarding…/i })).toBeDisabled();
  });
});
