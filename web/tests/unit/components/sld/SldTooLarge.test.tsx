import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DRAW_AT_ONCE_BUSES, tooLargeToDraw } from '@/components/sld/largeCase';
import { SldTooLarge } from '@/components/sld/SldTooLarge';

describe('tooLargeToDraw', () => {
  it('holds a case to the buses it is drawn at once for, which the 300-bus case is within', () => {
    expect(DRAW_AT_ONCE_BUSES).toBe(400);
    for (const buses of [0, 14, 118, 300, 400]) expect(tooLargeToDraw(buses)).toBe(false);
    for (const buses of [401, 1354, 2000]) expect(tooLargeToDraw(buses)).toBe(true);
  });
});

describe('SldTooLarge', () => {
  it('says how many buses the case has and what works without the diagram', () => {
    render(<SldTooLarge buses={2000} onDraw={() => {}} />);
    const card = screen.getByTestId('sld-too-large');
    expect(card).toHaveAttribute('role', 'status');
    expect(card).toHaveTextContent('The diagram of 2,000 buses is not drawn yet');
    expect(card).toHaveTextContent('takes minutes to draw');
    expect(card).toHaveTextContent('the page does not answer');
    expect(card).toHaveTextContent(
      'The tables, the power flow and its violations, and the analyses work without it',
    );
  });

  it('offers the diagram to anyone who is willing to wait for it, by a button named for it', async () => {
    const onDraw = vi.fn();
    render(<SldTooLarge buses={1354} onDraw={onDraw} />);
    const button = screen.getByRole('button', { name: 'Draw the diagram anyway' });
    await userEvent.setup().click(button);
    expect(onDraw).toHaveBeenCalledTimes(1);
  });
});
