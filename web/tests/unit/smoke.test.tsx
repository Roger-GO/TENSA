import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { useAuthStore } from '@/store/auth';

describe('App scaffold', () => {
  beforeEach(() => {
    // Unit 5 introduced an auth-paste modal that locks the app behind a
    // token entry. The smoke test asserts on the AppShell behind it, so
    // pre-seed the auth store with a synthetic token before render.
    useAuthStore.setState({ token: 'test-token-' + 'a'.repeat(53), persistFailed: false });
  });

  it('mounts the AppShell with the top bar landmark', () => {
    render(<App />);
    // The shell exposes its top bar as a banner landmark; presence of
    // this landmark confirms the AppShell mounted end-to-end.
    expect(screen.getByRole('banner', { name: /top bar/i })).toBeInTheDocument();
  });
});
