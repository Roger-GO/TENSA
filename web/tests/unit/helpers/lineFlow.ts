import type { LineFlow } from '@/api/types';

/**
 * A `LineFlow` as the server sends it: the power at the from end, and, by
 * default, a lossless line that delivers all of it, with no rating. Pass
 * `overrides` for the to end, the loss, the rating or the loading.
 */
export function lineFlow(
  p: number,
  q: number,
  idx: { from: number | string; to: number | string } = { from: 1, to: 2 },
  overrides: Partial<LineFlow> = {},
): LineFlow {
  return {
    p,
    q,
    from_idx: idx.from,
    to_idx: idx.to,
    p_to: -p,
    q_to: -q,
    loss: 0,
    rate_a: null,
    loading_pct: null,
    ...overrides,
  };
}
