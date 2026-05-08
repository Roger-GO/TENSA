import { AppShell } from '@/components/shell/AppShell';

/**
 * Root component. Mounts the AppShell with empty slots — Phase 2 units
 * fill them in:
 *
 * - Unit 5: wraps with `QueryClientProvider`; mounts TokenPasteModal in
 *   the `modal` slot.
 * - Unit 7: supplies the case nav (`leftRail`), workspace file picker,
 *   and run controls (`topBarRight`).
 * - Unit 8: supplies the SLD canvas (`main`).
 * - Unit 9: supplies the inspector + results table.
 *
 * The shell is intentionally state-free; cross-cutting providers wrap
 * around it (not inside it) to keep the layout component pure.
 */
export function App() {
  return <AppShell />;
}
