/**
 * Toast helper — typed wrapper around `sonner`.
 *
 * Why this exists: the v2.0 polish plan (Unit 3) consolidates the
 * project's hand-rolled inline toasts onto a single global surface so
 * that:
 *
 * 1. Toasts survive the unmount of the originating component (sonner
 *    owns the portal; the trigger component can vanish without losing
 *    the message).
 * 2. Multiple in-flight actions stack rather than overwriting each
 *    other in the same fixed-position div.
 * 3. The visual treatment (colour per kind, dismiss affordance, action
 *    button) is centralised so the design language stays consistent.
 *
 * Policy (referenced from `web/AGENTS.md` once Unit 5 lands):
 *
 * - **Form-validation alerts STAY inline** (`role="alert"` next to the
 *   offending input). A toast that vanishes after 4s is the wrong
 *   surface for "this field is required" — the user needs the alert
 *   visible while they fix the input.
 * - **Transient action results → toast.** Bundle exported, snapshot
 *   saved, sweep cancelled, run pinned to overlay. The action is done;
 *   the user just needs confirmation that the click landed.
 * - **Recovery state transitions → toast.** Substrate reconnected,
 *   token re-paste succeeded, sweep aborted by the user. Same shape as
 *   action results.
 * - **Persistent error UI** (the SLD pre-load empty state, the
 *   ConvergenceErrorPanel, the NumericalErrorBanner) STAYS inline.
 *   These represent a state of the world — not the result of a single
 *   click — and a toast that auto-dismisses would lose information the
 *   user may need to act on.
 *
 * Why a typed wrapper rather than direct `sonner` imports: the wrapper
 * lets us swap sonner for an alternative without rewriting every call
 * site, and lets us add `data-testid` attributes to the rendered toast
 * so Playwright + Testing Library can assert on a stable selector.
 */
import { toast as sonnerToast } from 'sonner';

/**
 * Optional payload accepted by every kind. Matches the subset of
 * sonner's API we want to expose.
 *
 * - `duration`: ms before the toast auto-dismisses. Sonner default is
 *   4000ms; pass `Infinity` to keep until manual dismiss.
 * - `description`: secondary text under the message (smaller font).
 *   Useful when the headline is the kind ("Snapshot save failed") and
 *   the body holds the actionable detail.
 * - `action`: a single button rendered to the right of the message.
 *   The label is the visible text; `onClick` fires when the user
 *   activates it. Sonner auto-dismisses on action click.
 */
export interface ToastOpts {
  /** Auto-dismiss after this many ms. Defaults to sonner's 4000ms. */
  duration?: number;
  /** Secondary text rendered below the message. */
  description?: string;
  /** Single action button. Sonner auto-dismisses on click. */
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Sonner's `id` field accepts both `number` and `string`; we normalise
 * to string so test assertions on `data-testid="toast-{id}"` are
 * predictable.
 */
function toIdString(id: number | string): string {
  return typeof id === 'string' ? id : String(id);
}

/** Map our `ToastOpts` to sonner's options object. */
function mapOpts(opts: ToastOpts | undefined): Record<string, unknown> {
  if (opts === undefined) return {};
  const out: Record<string, unknown> = {};
  if (opts.duration !== undefined) out.duration = opts.duration;
  if (opts.description !== undefined) out.description = opts.description;
  if (opts.action !== undefined) {
    out.action = { label: opts.action.label, onClick: opts.action.onClick };
  }
  return out;
}

/**
 * Public toast surface. Mirrors sonner's `toast.*` API but accepts only
 * the option subset we want to standardise on.
 *
 * Each method returns a string id so callers can dismiss programmatically
 * (rare; mostly used in tests to assert that a specific toast was
 * emitted).
 */
export const toast = {
  success(message: string, opts?: ToastOpts): string {
    return toIdString(sonnerToast.success(message, mapOpts(opts)));
  },
  error(message: string, opts?: ToastOpts): string {
    return toIdString(sonnerToast.error(message, mapOpts(opts)));
  },
  warning(message: string, opts?: ToastOpts): string {
    return toIdString(sonnerToast.warning(message, mapOpts(opts)));
  },
  info(message: string, opts?: ToastOpts): string {
    return toIdString(sonnerToast.info(message, mapOpts(opts)));
  },
  /** Programmatic dismiss; rarely needed since toasts auto-dismiss. */
  dismiss(id?: string): void {
    sonnerToast.dismiss(id);
  },
};
