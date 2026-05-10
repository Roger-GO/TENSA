/**
 * Auth slice. Owns the per-launch token used by the substrate's
 * `X-Andes-Token` header.
 *
 * Persistence: `sessionStorage` only (NOT `localStorage`). The token is
 * valid until the substrate process exits; persisting across tab reloads
 * is the user-friendly choice (page reload during dev or a researcher's
 * workflow shouldn't force a re-paste), but persisting across tab close
 * would be a security smell — `sessionStorage` is the exact right key.
 *
 * `sessionStorage` write failures (Safari private mode, quota errors)
 * fall back to in-memory state and surface a `persistFailed` flag the UI
 * shows as a banner. The token is still usable until the tab closes.
 */
import { create } from 'zustand';

const STORAGE_KEY = 'andes-app:auth-token';

/**
 * Try to read the persisted token from `sessionStorage`. Returns `null`
 * on any failure (storage unavailable, value missing, etc.) — the auth
 * flow falls back to the TokenPasteModal.
 */
function readPersistedToken(): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Try to persist the token. Returns `true` on success, `false` if storage
 * threw (private-mode Safari, quota exceeded, etc.) — the slice surfaces
 * this as `persistFailed: true`.
 */
function writePersistedToken(token: string | null): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false;
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export interface AuthState {
  /** The current token, or null if the user hasn't authed this tab. */
  token: string | null;
  /**
   * True if the most recent persistence attempt failed. The TokenPasteModal
   * uses this to render a "won't survive a reload" banner.
   */
  persistFailed: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
}

/**
 * Cross-slice clear hook. The combined store wires `clearToken` to also
 * clear `session`, `case`, and `pflow` (a 401 from any endpoint or a
 * user-driven sign-out unwinds the whole graph). The hook lives at module
 * scope so any consumer (including the client's 401 path) can register
 * cleanup without depending on the store shape.
 */
const cascadeListeners = new Set<() => void>();

export function registerAuthClearCascade(fn: () => void): () => void {
  cascadeListeners.add(fn);
  return () => {
    cascadeListeners.delete(fn);
  };
}

function fireCascade(): void {
  for (const fn of cascadeListeners) {
    try {
      fn();
    } catch (err) {
      // A cascade listener should never throw; if it does, surface in the
      // dev console and continue clearing the rest. Production users
      // benefit from a partial clear over a hard crash. `console.error`
      // is allowlisted in the ESLint config.
      console.error('auth clear cascade listener threw:', err);
    }
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  token: readPersistedToken(),
  persistFailed: false,
  setToken: (token: string) => {
    const ok = writePersistedToken(token);
    set({ token, persistFailed: !ok });
  },
  clearToken: () => {
    writePersistedToken(null);
    set({ token: null, persistFailed: false });
    fireCascade();
  },
}));

/**
 * Token getter for `client.ts` — reads the current token via the store's
 * non-React API. `getState()` skips the React subscription so the fetch
 * wrapper stays usable from non-component code.
 */
export function getAuthToken(): string | null {
  return useAuthStore.getState().token;
}
