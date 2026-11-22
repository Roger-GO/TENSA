/**
 * A reactive power in MVAr as the Results rows show it. A DC power flow (a
 * Sienna session's `method` dc or ptdf-dc) computes no reactive power and
 * answers `null`, which is shown as a dash, never as 0.
 */
export function formatMvar(q: number | null): string {
  return q === null ? '—' : `${q.toFixed(2)} MVAr`;
}
