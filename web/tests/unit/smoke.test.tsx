import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';

describe('App scaffold', () => {
  it('mounts the AppShell with the top bar landmark', () => {
    render(<App />);
    // The shell exposes its top bar as a banner landmark; presence of
    // this landmark confirms the AppShell mounted end-to-end.
    expect(screen.getByRole('banner', { name: /top bar/i })).toBeInTheDocument();
  });
});
