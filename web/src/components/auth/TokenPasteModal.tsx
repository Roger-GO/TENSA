import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/store/auth';

/**
 * TokenPasteModal. Mounts conditionally on `auth.token === null`; locks
 * the app behind a token-paste flow until a valid token has been confirmed.
 *
 * Two paths to a token:
 *
 * 1. URL-fragment fast path — `andes-app serve --open` constructs
 *    `http://<host>:<port>/#token=<value>` and opens the user's browser
 *    to it. On mount, we read `location.hash`, validate format, smoke-
 *    check via `GET /api/sessions`, persist on success, and clear the
 *    fragment from `location` immediately via `history.replaceState` so
 *    the token doesn't linger in browser history.
 * 2. Manual paste — for SSH-tunnel / remote-desktop users where
 *    `webbrowser.open()` doesn't help. The user copies the value from
 *    `~/.andes-app/run-<pid>.token` (or their CLI's stderr line) into
 *    the input.
 *
 * Pasted values are `trim()`ed (handles `cat`-style trailing newline)
 * then format-validated against `^[0-9a-f]{64}$`. On submit we run the
 * smoke check; on 200 we set the token and the modal unmounts. On 401 we
 * surface "Token rejected" inline. On a network error we surface "Try
 * again" + a debug-detail disclosure.
 *
 * Behavior choices (per R20 + R18):
 *
 * - No Esc-to-close. No overlay-click-to-close. The app is locked behind
 *   this modal — there's nothing useful behind it.
 * - Focus is trapped by Radix Dialog; we autofocus the input on first
 *   render so a single keypress + paste lands the user where they
 *   should type.
 * - Enter on the input submits.
 */

const TOKEN_FORMAT = /^[0-9a-f]{64}$/;
const URL_FRAGMENT_PATTERN = /^#token=([0-9a-f]{64})$/;

type PendingState =
  | { kind: 'idle' }
  | { kind: 'checking'; token: string }
  | { kind: 'invalid-format' }
  | { kind: 'rejected' } // server returned 401
  | { kind: 'network-error'; debugDetail: string };

/**
 * Smoke-check a candidate token by hitting `/api/sessions` directly with
 * the candidate value (NOT via `andesClient`, which would read the
 * not-yet-set token from the auth store). Returns one of three outcomes:
 *
 * - `'ok'` — server returned 200; the token is valid.
 * - `'rejected'` — server returned 401; show inline error.
 * - `{ kind: 'network'; ... }` — fetch threw, status >= 500, or some
 *   other unexpected shape.
 */
async function smokeCheck(
  token: string,
  signal: AbortSignal,
): Promise<'ok' | 'rejected' | { kind: 'network'; debugDetail: string }> {
  try {
    const response = await fetch('/api/sessions', {
      method: 'GET',
      headers: { 'X-Andes-Token': token },
      signal,
    });
    if (response.status === 200) return 'ok';
    if (response.status === 401) return 'rejected';
    return {
      kind: 'network',
      debugDetail: `Unexpected status ${response.status} from /api/sessions.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'network', debugDetail: message };
  }
}

export function TokenPasteModal(): React.ReactElement | null {
  const token = useAuthStore((s) => s.token);
  const persistFailed = useAuthStore((s) => s.persistFailed);
  const setToken = useAuthStore((s) => s.setToken);
  const authDisabled = useAuthStore((s) => s.authDisabled);
  const authProbeDone = useAuthStore((s) => s.authProbeDone);

  const [inputValue, setInputValue] = useState<string>('');
  const [pending, setPending] = useState<PendingState>({ kind: 'idle' });
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const errorId = useId();
  // Track the URL-fragment fast-path attempt so it runs once per mount.
  const fragmentAttemptedRef = useRef(false);

  // ---- URL-fragment fast path on first mount -----------------------------
  // We deliberately do NOT abort the in-flight smoke check on unmount.
  // React StrictMode double-mounts every effect in dev: mount1 fires the
  // fetch, cleanup1 aborts it, mount2 sees fragmentAttemptedRef.current
  // === true and returns early, leaving local state stuck at 'checking'
  // and the token never persisted. The smoke check is idempotent (a
  // single GET); on success we write to the global Zustand auth store,
  // which survives a parent unmount cleanly. The `isMounted` flag below
  // guards only the LOCAL pending-state writes, not the global store
  // write or the fragment cleanup, both of which are one-shot side
  // effects we want to land regardless.
  useEffect(() => {
    if (fragmentAttemptedRef.current) return;
    fragmentAttemptedRef.current = true;
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const match = hash.match(URL_FRAGMENT_PATTERN);
    if (!match || !match[1]) return;
    const candidate = match[1];

    // Never-aborted controller — smokeCheck() requires a signal, but we
    // intentionally don't expose `abort()` to the cleanup function.
    const controller = new AbortController();
    let isMounted = true;
    setPending({ kind: 'checking', token: candidate });
    void (async () => {
      const outcome = await smokeCheck(candidate, controller.signal);
      // Always clear the fragment from history first so the token does
      // not linger regardless of outcome — a rejected token in the URL
      // is no less of a leak than an accepted one.
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        // History API may throw in unusual hosts; surfacing this as
        // a UI error would be disproportionate. Carry on.
      }
      if (outcome === 'ok') {
        setToken(candidate);
        if (isMounted) setPending({ kind: 'idle' });
        return;
      }
      if (!isMounted) return;
      if (outcome === 'rejected') {
        setPending({ kind: 'rejected' });
        return;
      }
      setPending({ kind: 'network-error', debugDetail: outcome.debugDetail });
    })();
    return () => {
      isMounted = false;
    };
  }, [setToken]);

  // ---- manual submit handler --------------------------------------------
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = inputValue.trim();
    if (!TOKEN_FORMAT.test(candidate)) {
      setPending({ kind: 'invalid-format' });
      return;
    }
    setPending({ kind: 'checking', token: candidate });
    const controller = new AbortController();
    void (async () => {
      const outcome = await smokeCheck(candidate, controller.signal);
      if (outcome === 'ok') {
        setToken(candidate);
        setPending({ kind: 'idle' });
        return;
      }
      if (outcome === 'rejected') {
        setPending({ kind: 'rejected' });
        return;
      }
      setPending({ kind: 'network-error', debugDetail: outcome.debugDetail });
    })();
  };

  // ---- render -----------------------------------------------------------
  // Hidden when: a token is set; the backend is no-auth (serve --no-auth); or
  // the boot probe hasn't resolved yet (so a no-auth backend never flashes
  // this modal before the probe lands).
  if (token !== null || authDisabled || !authProbeDone) return null;

  const trimmed = inputValue.trim();
  const formatValid = TOKEN_FORMAT.test(trimmed);
  const isChecking = pending.kind === 'checking';
  const showRejected = pending.kind === 'rejected';
  const showInvalidFormat = pending.kind === 'invalid-format' && !formatValid;
  const showNetworkError = pending.kind === 'network-error';

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        // Disable Esc + overlay click; the app is locked behind this modal.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <DialogTitle>Paste your andes-app token</DialogTitle>
        <DialogDescription className="mt-2">
          Find your token in <code className="font-mono">~/.andes-app/run-&lt;pid&gt;.token</code> —
          the path was printed to stderr when you ran{' '}
          <code className="font-mono">andes-app serve</code>.
        </DialogDescription>

        {persistFailed ? (
          <div
            role="status"
            className="border-warning bg-warning/10 text-warning-foreground mt-4 rounded-md border p-3 text-sm"
          >
            Token won&apos;t survive a tab reload — sessionStorage unavailable (private mode?).
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label htmlFor={inputId} className="text-sm font-medium">
            Token
          </label>
          <Input
            id={inputId}
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={showInvalidFormat || showRejected ? true : undefined}
            aria-describedby={
              showInvalidFormat || showRejected || showNetworkError ? errorId : undefined
            }
            value={inputValue}
            onChange={(next) => {
              setInputValue(next);
              // Reset transient errors on edit so the user sees fresh validation.
              if (pending.kind !== 'idle' && pending.kind !== 'checking') {
                setPending({ kind: 'idle' });
              }
            }}
            placeholder="64 hex characters"
            className="font-mono"
          />

          {showInvalidFormat ? (
            <p id={errorId} role="alert" className="text-danger text-sm">
              Token must be 64 hex characters (0–9, a–f).
            </p>
          ) : null}
          {showRejected ? (
            <p id={errorId} role="alert" className="text-danger text-sm">
              Token rejected. Check{' '}
              <code className="font-mono">~/.andes-app/run-&lt;pid&gt;.token</code> for the current
              value.
            </p>
          ) : null}
          {showNetworkError ? (
            <div id={errorId} role="alert" className="text-danger flex flex-col gap-1 text-sm">
              <span>Could not reach the substrate. Is it running?</span>
              <button
                type="button"
                onClick={() => setShowDebug((v) => !v)}
                className="text-muted-foreground hover:text-foreground self-start text-xs underline"
              >
                {showDebug ? 'Hide debug detail' : 'Show debug detail'}
              </button>
              {showDebug ? (
                <pre className="bg-muted text-foreground overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
                  {pending.kind === 'network-error' ? pending.debugDetail : ''}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 flex justify-end gap-2">
            <Button type="submit" disabled={!formatValid || isChecking}>
              {isChecking ? 'Checking…' : showNetworkError ? 'Try again' : 'Continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
