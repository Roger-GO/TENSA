import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DRAW_AT_ONCE_BUSES,
  DRAW_ON_REQUEST_BUSES,
  tooLargeToDraw,
  tooLargeToOffer,
} from '@/components/sld/largeCase';
import { SldTooLarge } from '@/components/sld/SldTooLarge';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';

const MIME = 'application/andes-component-type';

function drop(target: HTMLElement, kind: string): void {
  const dataTransfer = {
    getData: (mime: string) => (mime === MIME ? kind : ''),
    types: [MIME],
    dropEffect: 'copy',
  };
  fireEvent(target, createEvent.drop(target, { dataTransfer }));
}

afterEach(() => {
  cleanup();
  useCaseStore.getState().closeAddPanel();
  vi.restoreAllMocks();
});

describe('tooLargeToDraw', () => {
  it('holds a case to the buses it is drawn at once for, which the 300-bus case is within', () => {
    expect(DRAW_AT_ONCE_BUSES).toBe(400);
    for (const buses of [0, 14, 118, 300, 400]) expect(tooLargeToDraw(buses)).toBe(false);
    for (const buses of [401, 1354, 2000]) expect(tooLargeToDraw(buses)).toBe(true);
  });

  it('offers the diagram on request up to the buses it was measured to be drawn in time for', () => {
    expect(DRAW_ON_REQUEST_BUSES).toBe(500);
    for (const buses of [401, 450, 500]) expect(tooLargeToOffer(buses)).toBe(false);
    for (const buses of [501, 1354, 2000]) expect(tooLargeToOffer(buses)).toBe(true);
  });
});

describe('SldTooLarge', () => {
  it('says how many buses the case has and what works without the diagram', () => {
    render(<SldTooLarge buses={450} onDraw={() => {}} />);
    const card = screen.getByTestId('sld-too-large');
    expect(card).toHaveAttribute('role', 'status');
    expect(card).toHaveTextContent('The diagram of 450 buses is not drawn yet');
    expect(card).toHaveTextContent('takes up to a minute to draw');
    expect(card).toHaveTextContent('the page does not answer');
    expect(card).toHaveTextContent(
      'The tables, the power flow and its violations, and the analyses work without it',
    );
  });

  it('offers the diagram to anyone who is willing to wait for it, by a button named for it', async () => {
    const onDraw = vi.fn();
    render(<SldTooLarge buses={500} onDraw={onDraw} />);
    const button = screen.getByRole('button', { name: 'Draw the diagram anyway' });
    await userEvent.setup().click(button);
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it('says the page will not answer, in place of the button, once the diagram is asked for', () => {
    render(<SldTooLarge buses={450} onDraw={() => {}} drawing />);
    expect(screen.getByTestId('sld-drawing')).toHaveTextContent(
      'Drawing the diagram. The page does not answer until it is done.',
    );
    expect(screen.queryByRole('button', { name: 'Draw the diagram anyway' })).toBeNull();
    // The reasons stay on screen beside it.
    expect(screen.getByTestId('sld-too-large')).toHaveTextContent(
      'The tables, the power flow and its violations',
    );
  });

  it('does not offer the diagram of a case so large that the page would outlast its session', () => {
    render(<SldTooLarge buses={2000} onDraw={() => {}} />);
    const card = screen.getByTestId('sld-too-large');
    expect(card).toHaveTextContent('The diagram of 2,000 buses is not drawn');
    expect(card).not.toHaveTextContent('not drawn yet');
    expect(card).toHaveTextContent('takes five minutes or more');
    expect(card).toHaveTextContent('the server closes the session of a page that is silent');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('sld-drawing')).toBeNull();
    expect(card).toHaveTextContent(
      'The tables, the power flow and its violations, and the analyses work without it',
    );
  });
});

describe('SldTooLarge as a drop target', () => {
  it('opens the form for a component dropped on it and says why, where a drop would do nothing', () => {
    const info = vi.spyOn(toast, 'info');
    useCaseStore.getState().closeAddPanel();
    render(<SldTooLarge buses={450} onDraw={() => {}} />);
    drop(screen.getByTestId('sld-too-large'), 'PQ');
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'PQ' });
    expect(info).toHaveBeenCalledWith(
      'The diagram is not drawn, so there is nothing to drop it on',
      expect.objectContaining({ description: 'The form to add it opens instead.' }),
    );
  });

  it('is still the status note it was', () => {
    render(<SldTooLarge buses={2000} onDraw={() => {}} />);
    expect(screen.getByTestId('sld-too-large')).toHaveAttribute('role', 'status');
  });
});
