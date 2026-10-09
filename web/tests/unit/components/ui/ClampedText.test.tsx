/**
 * `ClampedText`: a text held to the room it has, with the rest of it one
 * press away. jsdom lays nothing out, so a text that is cut is one whose box
 * is given a scroll height over its client height here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClampedText } from '@/components/ui/ClampedText';

/** Make every paragraph measure as cut off (or not) until the test ends. */
function measureAs(cut: boolean): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(cut ? 48 : 32);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(32);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LONG =
  'Load PQ_3 is selected. To move it to another bus, drag the ring where its connector meets the bar onto that bus.';

describe('<ClampedText />', () => {
  it('shows a text that fits as it is, with no button', () => {
    measureAs(false);
    render(<ClampedText text="Drag a bus to move it." testId="hint" />);
    expect(screen.getByTestId('hint')).toHaveTextContent('Drag a bus to move it.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('hint')).not.toHaveAttribute('data-cut');
  });

  it('offers the whole of a text that is cut, and shows it on a press', async () => {
    measureAs(true);
    const user = userEvent.setup();
    render(<ClampedText text={LONG} testId="hint" moreLabel="Show how to move it" />);
    expect(screen.getByTestId('hint')).toHaveAttribute('data-cut', 'true');
    const more = screen.getByRole('button', { name: 'Show how to move it' });
    expect(more).toHaveTextContent('More');
    expect(screen.queryByTestId('hint-full')).toBeNull();
    await user.click(more);
    expect(await screen.findByTestId('hint-full')).toHaveTextContent(LONG);
  });

  it('measures a single line that is cut sideways as cut too', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    render(<ClampedText text={LONG} testId="hint" className="truncate" />);
    expect(screen.getByRole('button', { name: 'Show the whole text' })).toBeInTheDocument();
  });

  it('offers the lines a summary stands for whether or not the summary fits', async () => {
    measureAs(false);
    const user = userEvent.setup();
    render(
      <ClampedText
        text="Drag a bus to move it."
        more={['Drag a bus to move it.', 'Right-click it for more.']}
        testId="hint"
      />,
    );
    await user.click(screen.getByRole('button'));
    const full = await screen.findByTestId('hint-full');
    expect(
      within(full)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Drag a bus to move it.', 'Right-click it for more.']);
  });

  it('keeps the whole text in the title, and what a caller hangs on the paragraph', () => {
    measureAs(true);
    render(
      <ClampedText
        text={LONG}
        testId="hint"
        role="status"
        lead={<strong>Note. </strong>}
        attributes={{ 'data-hint': 'movable', 'aria-live': 'polite' }}
      />,
    );
    const hint = screen.getByRole('status');
    expect(hint).toHaveAttribute('title', LONG);
    expect(hint).toHaveAttribute('data-hint', 'movable');
    expect(hint).toHaveAttribute('aria-live', 'polite');
    expect(hint).toHaveTextContent(`Note. ${LONG}`);
  });
});
