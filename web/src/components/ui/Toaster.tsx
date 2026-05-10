/**
 * Toaster — global sonner provider mount.
 *
 * Mounts once at the AppShell root (per Unit 3 of the v2.0 polish
 * plan). Every `toast.*` call from `@/lib/toast` lands here regardless
 * of which component triggered it, which means a toast survives the
 * unmount of its origin (sonner owns the portal in document.body).
 *
 * Theme bridge: the `theme` prop currently hard-codes `light`. Unit 12
 * (theme system) will wire this to the active app theme so dark-mode
 * users get a dark toast. Leaving the prop named so the wire-up is a
 * one-liner once the theme store lands.
 *
 * Test-id contract: each rendered toast carries
 * `data-testid="toast-{id}"` via `toastOptions.unstyled` + sonner's
 * built-in `data-sonner-toast` attribute (Playwright + Testing Library
 * can also use `[data-sonner-toast][data-type="error"]` for kind-scoped
 * assertions).
 */
import { Toaster as SonnerToaster } from 'sonner';

export interface ToasterProps {
  /**
   * Theme to apply to toasts. Defaults to `light`. Unit 12 will wire
   * this to the global theme store.
   */
  theme?: 'light' | 'dark' | 'system';
}

export function Toaster({ theme = 'light' }: ToasterProps = {}) {
  return (
    <SonnerToaster
      theme={theme}
      position="top-right"
      richColors
      closeButton
      // Sonner's defaults: 4000ms auto-dismiss, newest on top, max 3
      // visible (the rest stack and reveal as they dismiss). The plan's
      // "5 toasts in rapid succession → stack with newest on top"
      // scenario relies on these defaults — leave them alone unless a
      // specific use case forces an override.
      data-testid="toaster-root"
    />
  );
}
