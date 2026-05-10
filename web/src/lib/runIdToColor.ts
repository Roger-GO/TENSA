/**
 * Per-run colour hash for the multi-run overlay (Unit 9 of the v2.0 plan).
 *
 * Maps a ``runId`` to a stable HSL colour with golden-ratio hue rotation
 * so up to ~8 simultaneously-rendered runs land on visually distinct
 * hues. The 9th–20th runs reuse the hue palette but flip a line-dash
 * variant so the renderer can avoid colour collisions purely by stroke
 * style — see ``runIdToDash``.
 *
 * Plan-divergence note (KTD-8):
 *   The plan's ideal is SHA-256 → first 3 bytes → HSL hue. WebCrypto's
 *   SHA-256 is async (and ``crypto.subtle.digest`` is awkward to call
 *   from a synchronous render path). Since the colour is purely a UI
 *   concern (no security / collision-resistance requirement beyond
 *   "different runIds usually map to different colours"), we use a
 *   deterministic 32-bit FNV-1a hash and apply the golden-ratio rotation
 *   to that. The visual result is identical for the 8-run distinguishable
 *   palette; the only difference is the cryptographic strength of the
 *   hash, which doesn't matter here.
 */

/**
 * Golden-ratio conjugate. Multiplying the hue by this constant produces
 * a maximally-spread sequence of values in [0, 1) for any small integer
 * series — the colour-theoretic basis for the "low-discrepancy palette"
 * trick used in many data-vis libraries.
 */
const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;

/** Number of distinct hues the palette aims to surface before reuse. */
export const PALETTE_SIZE = 8;

/**
 * 32-bit FNV-1a hash. Deterministic, fast, and good enough for the
 * "spread runIds across hues" use case. NOT a cryptographic hash.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (16777619) using Math.imul for 32-bit.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned interpretation.
  return hash >>> 0;
}

/**
 * Map a runId → palette slot in [0, PALETTE_SIZE). The hash is rotated
 * by the golden-ratio conjugate to spread adjacent runIds across the
 * palette (rather than landing in adjacent slots due to small hash
 * differences).
 */
export function runIdToPaletteSlot(runId: string): number {
  const h = fnv1a32(runId);
  // Normalise to [0, 1), apply golden-ratio rotation, then bucket.
  const fraction = (h / 0x100000000) * GOLDEN_RATIO_CONJUGATE;
  const rotated = fraction - Math.floor(fraction);
  return Math.floor(rotated * PALETTE_SIZE);
}

/**
 * Map a runId → CSS HSL colour string. Stable saturation (70%) and
 * lightness (45%) keep the chips readable in both light and dark
 * themes; only the hue varies with the runId. Hues are spread by
 * golden-ratio rotation across the [0, 360) range.
 *
 * **Override (Unit 20, v2.0):** when ``override`` is a non-empty
 * string, it is returned verbatim instead of the hash-derived hue.
 * Callers fetch the override from the runs store
 * (``runs[runId].colorOverride``) and pass it through; keeping the
 * function pure (no store import) lets it be called from non-React
 * code paths (e.g., tests) without dragging in the global store.
 */
export function runIdToColor(runId: string, override?: string | null): string {
  if (override && override.length > 0) return override;
  const slot = runIdToPaletteSlot(runId);
  const hue = Math.round((360 / PALETTE_SIZE) * slot);
  return `hsl(${hue}, 70%, 45%)`;
}

/**
 * Map a runId → uPlot dash array. The first PALETTE_SIZE slots use a
 * solid line; subsequent slots use progressively richer dash patterns
 * so the 9th–20th overlay runs don't collide with the first 8 by
 * colour alone.
 *
 * Returns an empty array (uPlot's "solid" sentinel) for the solid case;
 * uPlot's ``Series.dash`` accepts ``[on, off, on, off, ...]`` patterns.
 */
export function runIdToDash(runId: string): readonly number[] {
  const h = fnv1a32(runId);
  // Bucket into "dash family" by hashing again into a small space.
  // Mix the hash a bit so the dash family is decoupled from the hue
  // bucket (otherwise runs in palette slot 0 would always be solid).
  const dashSlot = Math.floor((((h ^ 0xdeadbeef) >>> 0) / 0x100000000) * 4);
  switch (dashSlot) {
    case 0:
      return [];
    case 1:
      return [6, 4];
    case 2:
      return [2, 3];
    case 3:
      return [10, 4, 2, 4];
    default:
      return [];
  }
}

/**
 * Convenience: compute both stroke colour and dash for a runId in one
 * call. The TimeSeriesPlot calls this once per overlay run when building
 * uPlot series options.
 */
export interface RunStrokeStyle {
  /** CSS HSL colour string. */
  color: string;
  /** uPlot dash pattern (empty = solid). */
  dash: readonly number[];
}

export function runIdToStrokeStyle(runId: string, override?: string | null): RunStrokeStyle {
  return { color: runIdToColor(runId, override), dash: runIdToDash(runId) };
}
