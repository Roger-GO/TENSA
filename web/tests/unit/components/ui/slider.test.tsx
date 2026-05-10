import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from '@/components/ui/slider';

describe('Slider', () => {
  it('renders uncontrolled with defaultValue', () => {
    render(<Slider defaultValue={[50]} min={0} max={100} step={1} />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '50');
    expect(thumb).toHaveAttribute('aria-valuemin', '0');
    expect(thumb).toHaveAttribute('aria-valuemax', '100');
  });

  it('renders controlled with value', () => {
    function Harness() {
      const [value, setValue] = useState([30]);
      return <Slider value={value} onValueChange={setValue} min={0} max={100} step={1} />;
    }
    render(<Harness />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '30');
  });

  it('arrow key steps by step value', async () => {
    const onValueChange = vi.fn();
    render(<Slider defaultValue={[50]} min={0} max={100} step={5} onValueChange={onValueChange} />);
    const thumb = screen.getByRole('slider');
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenLastCalledWith([55]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(onValueChange).toHaveBeenLastCalledWith([50]);
  });
});
