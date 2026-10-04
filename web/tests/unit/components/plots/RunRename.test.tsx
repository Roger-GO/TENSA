/**
 * The two controls a run is renamed with: the pencil that starts a rename and
 * the field that finishes it. They are shared by the legend chip and the
 * history row, which test them only through their own behaviour, so what the
 * controls promise on their own is pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RenameRunButton, RunRenameInput } from '@/components/plots/RunRename';

afterEach(cleanup);

describe('RenameRunButton', () => {
  it('is a pencil named for its run, with a hover title', () => {
    render(
      <RenameRunButton aria-label="Rename TDS #2" onClick={vi.fn()} data-testid="rename-pencil" />,
    );
    const button = screen.getByRole('button', { name: 'Rename TDS #2' });
    expect(button).toBe(screen.getByTestId('rename-pencil'));
    expect(button).toHaveAttribute('title', 'Rename this run');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('starts the rename on a click, and a click on it is not a click on what holds it', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <RenameRunButton aria-label="Rename run" onClick={onClick} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Rename run' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    // A legend chip toggles the overlay when clicked; its pencil must not.
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe('RunRenameInput', () => {
  function setup(props: Partial<React.ComponentProps<typeof RunRenameInput>> = {}) {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <RunRenameInput
        initialValue="Base case"
        placeholder="TDS #1 - fault bus 7"
        onCommit={onCommit}
        onCancel={onCancel}
        data-testid="rename-field"
        {...props}
      />,
    );
    return { onCommit, onCancel, input: screen.getByTestId('rename-field') as HTMLInputElement };
  }

  it('opens with the current name focused and selected, ready to retype', () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Base case');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Base case'.length);
  });

  it('shows the default label as the placeholder, so an empty field says what it goes back to', () => {
    const { input } = setup({ initialValue: '' });
    expect(input).toHaveAttribute('placeholder', 'TDS #1 - fault bus 7');
  });

  it('is named "Rename run" unless the caller names it for its row', () => {
    setup();
    expect(screen.getByRole('textbox', { name: 'Rename run' })).toBeInTheDocument();
    cleanup();
    setup({ 'aria-label': 'New name for TDS #3' });
    expect(screen.getByRole('textbox', { name: 'New name for TDS #3' })).toBeInTheDocument();
  });

  it('marks itself, so a surrounding dialog can tell Escape belongs to the field', () => {
    const { input } = setup();
    expect(input).toHaveAttribute('data-run-rename');
  });

  it('commits what was typed on Enter, once', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel, input } = setup();

    // Clicking into the field puts the caret at the end, so clear it to retype.
    await user.clear(input);
    await user.type(input, 'Baseline no fault{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Baseline no fault');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not commit a second time when the field then loses focus', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = setup();

    await user.clear(input);
    await user.type(input, 'X{Enter}');
    input.blur();

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits when focus leaves the field', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = setup();

    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Renamed');
  });

  it('drops what was typed on Escape, and the blur that follows does not commit it', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel, input } = setup();

    await user.clear(input);
    await user.type(input, 'Dropped{Escape}');
    input.blur();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits an empty name as an empty string, which puts the default label back', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = setup();

    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledWith('');
  });

  it('is w-32 wide unless the caller gives it a width', () => {
    const { input } = setup();
    expect(input.className).toContain('w-32');
    cleanup();
    const wide = setup({ className: 'w-full' });
    expect(wide.input.className).toContain('w-full');
    expect(wide.input.className).not.toContain('w-32');
  });
});
