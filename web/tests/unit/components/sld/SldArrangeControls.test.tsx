/**
 * The controls that arrange the diagram: the Tidy diagram button, the Arrange
 * menu, and the bar over the diagram while several nodes are picked. Each
 * posts a command; the canvas tests cover what the commands do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  ArrangeButtons,
  MANUAL_ROUTE_HINT,
  PICK_SEVERAL_HINT,
  SldArrangeControls,
  SldSelectionBar,
  TIDY_DESCRIPTION,
  TIDY_RELAYOUT_DESCRIPTION,
} from '@/components/sld/SldArrangeControls';

afterEach(() => cleanup());

function controls(props: Partial<Parameters<typeof SldArrangeControls>[0]> = {}) {
  const onCommand = vi.fn();
  const onSnapChange = vi.fn();
  render(
    <SldArrangeControls
      locked={false}
      pickedCount={0}
      snap={false}
      onSnapChange={onSnapChange}
      onCommand={onCommand}
      {...props}
    />,
  );
  return { onCommand, onSnapChange };
}

describe('<SldArrangeControls />', () => {
  it('has Tidy diagram as a button of its own, which says what it does and that nothing moves', () => {
    const { onCommand } = controls();
    const tidy = screen.getByRole('button', { name: 'Tidy diagram' });
    expect(tidy).toHaveAttribute('title', TIDY_DESCRIPTION);
    expect(TIDY_DESCRIPTION).toMatch(/Nothing is moved/);
    fireEvent.click(tidy);
    expect(onCommand).toHaveBeenCalledWith('tidy');
  });

  it('opens a menu with both tidies, Snap to grid, and Align and Distribute', async () => {
    const { onCommand } = controls();
    expect(screen.queryByTestId('sld-arrange-menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange the diagram' }));
    const menu = await screen.findByTestId('sld-arrange-menu');
    expect(menu).toHaveTextContent('Tidy and re-layout');
    expect(menu).toHaveTextContent(TIDY_RELAYOUT_DESCRIPTION);
    expect(menu).toHaveTextContent('Snap to grid');
    expect(menu).toHaveTextContent('Align and distribute');
    // How a change is taken back, which nothing else on the diagram says.
    expect(menu).toHaveTextContent(/Undo \(Ctrl\+Z, or Cmd\+Z on a Mac\)/);

    fireEvent.click(screen.getByTestId('sld-arrange-tidy-relayout'));
    expect(onCommand).toHaveBeenCalledWith('tidy-relayout');
    // A command closes the menu.
    expect(screen.queryByTestId('sld-arrange-menu')).not.toBeInTheDocument();
  });

  it('shows whether Snap to grid is on, and reports a change of it', async () => {
    const { onSnapChange } = controls({ snap: true });
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    const toggle = await screen.findByTestId('sld-snap-toggle');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onSnapChange).toHaveBeenCalledWith(false);
    // The setting stays in view: the menu is not closed by it.
    expect(screen.getByTestId('sld-arrange-menu')).toBeInTheDocument();
  });

  it('says how to pick several nodes while fewer than two are picked', async () => {
    controls({ pickedCount: 1 });
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    expect(await screen.findByTestId('sld-arrange-pick-hint')).toHaveTextContent(PICK_SEVERAL_HINT);
    expect(screen.getByTestId('sld-align-left')).toBeDisabled();
    expect(screen.getByTestId('sld-distribute-horizontal')).toBeDisabled();
  });

  it('offers the alignments once two are picked, and says how many', async () => {
    const { onCommand } = controls({ pickedCount: 2 });
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    const menu = await screen.findByTestId('sld-arrange-menu');
    expect(menu).toHaveTextContent('Align and distribute (2 picked)');
    expect(screen.queryByTestId('sld-arrange-pick-hint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sld-align-centre'));
    expect(onCommand).toHaveBeenCalledWith('align-centre');
  });

  it('says how a line is moved by hand, and that there is none to reset while that is so', async () => {
    const { onCommand } = controls();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange the diagram' }));
    const menu = await screen.findByTestId('sld-arrange-menu');
    expect(menu).toHaveTextContent('Lines moved by hand');
    expect(screen.getByTestId('sld-arrange-route-hint')).toHaveTextContent(MANUAL_ROUTE_HINT);
    expect(MANUAL_ROUTE_HINT).toMatch(/Click a line.*drag a run/);
    const reset = screen.getByRole('button', { name: 'Reset manual routes' });
    expect(reset).toBeDisabled();
    // The reason stands beside the button.
    expect(screen.getByTestId('sld-arrange-no-manual-routes')).toHaveTextContent(
      'No line is routed by hand, so there is nothing to reset.',
    );
    fireEvent.click(reset);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('counts the lines routed by hand, and resets them all', async () => {
    const { onCommand } = controls({ manualRoutes: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange the diagram' }));
    const menu = await screen.findByTestId('sld-arrange-menu');
    expect(menu).toHaveTextContent('Lines moved by hand (3)');
    expect(menu).toHaveTextContent('Gives all 3 back to the automatic routing');
    expect(screen.queryByTestId('sld-arrange-no-manual-routes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset manual routes' }));
    expect(onCommand).toHaveBeenCalledWith('reset-manual-routes');
    // A command closes the menu.
    expect(screen.queryByTestId('sld-arrange-menu')).not.toBeInTheDocument();
  });

  it('counts the lines that run through a symbol or a bar on the Tidy diagram button', () => {
    controls({ untidy: 3 });
    const button = screen.getByTestId('sld-tidy');
    expect(screen.getByTestId('sld-tidy-count')).toHaveTextContent('3');
    // The tooltip says what the count is of, and what the button does about it.
    expect(button.getAttribute('title')).toBe(
      `3 lines run through a symbol or a bar. ${TIDY_DESCRIPTION}`,
    );
    expect(button).toHaveAccessibleName('Tidy diagram: 3 lines run through a symbol or a bar.');
    cleanup();

    controls({ untidy: 1 });
    expect(screen.getByTestId('sld-tidy')).toHaveAccessibleName(
      'Tidy diagram: 1 line runs through a symbol or a bar.',
    );
    cleanup();
    // With none the button is as it always was, and so it is while a tidy runs.
    controls({ untidy: 0 });
    expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('sld-tidy')).toHaveAttribute('title', TIDY_DESCRIPTION);
    cleanup();
    controls({ untidy: 2, busy: true });
    expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument();
  });

  it('says that a tidy is being worked out, and takes no second one meanwhile', async () => {
    const { onCommand } = controls({ busy: true });
    const tidy = screen.getByTestId('sld-tidy');
    expect(tidy).toHaveTextContent('Tidying…');
    expect(tidy).toBeDisabled();
    expect(tidy).toHaveAttribute('data-busy', 'true');
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    expect(await screen.findByTestId('sld-arrange-tidy')).toBeDisabled();
    expect(screen.getByTestId('sld-arrange-tidy-relayout')).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('offers to stop a tidy that is being worked out, and only then', () => {
    const onCancel = vi.fn();
    controls({ busy: true, onCancel });
    const stop = screen.getByTestId('sld-tidy-cancel');
    expect(stop).toHaveTextContent('Stop');
    expect(stop).toHaveAttribute('title', 'Stop tidying. Nothing is changed.');
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();

    // Not while nothing runs, and not for a tidy that cannot be stopped.
    controls({ busy: false, onCancel });
    expect(screen.queryByTestId('sld-tidy-cancel')).not.toBeInTheDocument();
    cleanup();
    controls({ busy: true });
    expect(screen.queryByTestId('sld-tidy-cancel')).not.toBeInTheDocument();
  });

  it('says what the last tidy came to beside the button, and nothing while one is worked out', () => {
    controls();
    const note = screen.getByTestId('sld-tidy-note');
    // There all along, so that what it comes to say is announced.
    expect(note).toHaveAttribute('aria-live', 'polite');
    expect(note).toHaveTextContent('');
    expect(note.className).toContain('sr-only');
    cleanup();

    controls({ note: 'Already tidy: nothing was changed' });
    const shown = screen.getByTestId('sld-tidy-note');
    expect(shown).toHaveTextContent('Already tidy: nothing was changed');
    expect(shown).toHaveAttribute('title', 'Already tidy: nothing was changed');
    expect(shown.className).not.toContain('sr-only');
    cleanup();

    controls({ note: 'Already tidy: nothing was changed', busy: true });
    expect(screen.getByTestId('sld-tidy-note')).toHaveTextContent('');
  });

  it('greys everything that arranges out while the diagram is locked, and says why', async () => {
    const { onCommand } = controls({ locked: true, pickedCount: 3 });
    const tidy = screen.getByTestId('sld-tidy');
    expect(tidy).toBeDisabled();
    expect(tidy.getAttribute('title')).toMatch(/^The diagram is locked\./);
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    const menu = await screen.findByTestId('sld-arrange-menu');
    expect(menu).toHaveTextContent('The diagram is locked.');
    expect(screen.getByTestId('sld-arrange-tidy')).toBeDisabled();
    expect(screen.getByTestId('sld-arrange-tidy-relayout')).toBeDisabled();
    expect(screen.getByTestId('sld-align-left')).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('<ArrangeButtons />', () => {
  it('names each button for assistive technology and in its tooltip', () => {
    render(<ArrangeButtons count={3} onCommand={vi.fn()} />);
    for (const name of [
      'Align left',
      'Align centre',
      'Align right',
      'Align top',
      'Align middle',
      'Align bottom',
      'Distribute horizontally',
      'Distribute vertically',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('title', name);
      expect(button).toBeEnabled();
    }
  });

  it('posts the command of the button that is pressed', () => {
    const onCommand = vi.fn();
    render(<ArrangeButtons count={3} onCommand={onCommand} />);
    fireEvent.click(screen.getByTestId('sld-align-bottom'));
    fireEvent.click(screen.getByTestId('sld-distribute-vertical'));
    expect(onCommand.mock.calls).toEqual([['align-bottom'], ['distribute-vertical']]);
  });

  it('keeps Distribute greyed out with two picked, and says it needs three', () => {
    render(<ArrangeButtons count={2} onCommand={vi.fn()} />);
    expect(screen.getByTestId('sld-align-left')).toBeEnabled();
    const distribute = screen.getByTestId('sld-distribute-horizontal');
    expect(distribute).toBeDisabled();
    expect(distribute).toHaveAttribute(
      'title',
      'Distribute horizontally (needs three or more picked)',
    );
  });
});

describe('<SldSelectionBar />', () => {
  it('shows from two picked nodes, with how many and the buttons', () => {
    const onCommand = vi.fn();
    const { rerender } = render(<SldSelectionBar count={1} locked={false} onCommand={onCommand} />);
    expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument();

    rerender(<SldSelectionBar count={2} locked={false} onCommand={onCommand} />);
    const bar = screen.getByRole('toolbar', { name: 'Arrange the picked elements' });
    expect(screen.getByTestId('sld-selection-count')).toHaveTextContent('2 picked');
    // That they move together is on the count's tooltip.
    expect(screen.getByTestId('sld-selection-count').getAttribute('title')).toMatch(
      /move them together/,
    );
    // Left out of a picture of the diagram.
    expect(bar).toHaveAttribute('data-export-ignore');
    fireEvent.click(screen.getByTestId('sld-align-top'));
    expect(onCommand).toHaveBeenCalledWith('align-top');
  });

  it('greys its buttons out while the diagram is locked', () => {
    render(<SldSelectionBar count={3} locked onCommand={vi.fn()} />);
    expect(screen.getByTestId('sld-align-top')).toBeDisabled();
    expect(screen.getByTestId('sld-distribute-horizontal')).toBeDisabled();
  });
});
