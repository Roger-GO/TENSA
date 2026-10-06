/**
 * `n` held between `lo` and `hi`, both included. Bounds given the wrong way
 * round (`lo` above `hi`) answer `hi`, which is what an index into an empty
 * list wants: `clamp(i, 0, length - 1)` is then -1, no row.
 */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
