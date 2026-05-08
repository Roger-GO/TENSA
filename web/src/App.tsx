import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/shell/AppShell';
import { TokenPasteModal } from '@/components/auth/TokenPasteModal';
import { makeQueryClient, wireGlobal401Handler } from '@/api/queries';
import { setTokenGetter } from '@/api/client';
import { getAuthToken } from '@/store';

// Wire the API client's token-getter to the auth store. This runs once at
// module load (the App.tsx import is the entry point); `getAuthToken`
// reads from the Zustand store via `getState()` so it doesn't need a
// React context.
setTokenGetter(getAuthToken);

/**
 * Root component. Wraps the AppShell with the cross-cutting providers
 * (QueryClientProvider + global 401 cascade) and mounts the
 * TokenPasteModal in the shell's `modal` slot — the modal renders only
 * when `auth.token === null`, so for an authenticated tab the slot is
 * effectively empty.
 *
 * Subsequent Phase 2 units fill in the rest of the shell:
 *
 * - Unit 7: case nav (`leftRail`), workspace file picker, run controls (`topBarRight`).
 * - Unit 8: SLD canvas (`main`).
 * - Unit 9: inspector + results table (`inspector` + `results`).
 */
export function App() {
  // The QueryClient is created once per mount via `useState`'s lazy
  // initializer — re-renders preserve the instance, but unmount/remount
  // (e.g., HMR or test isolation) gets a fresh client.
  const [queryClient] = useState(() => {
    const client = makeQueryClient();
    wireGlobal401Handler(client);
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell modal={<TokenPasteModal />} />
    </QueryClientProvider>
  );
}
