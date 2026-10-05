/**
 * When a kept result was produced, as a list shows it: the time alone for one
 * from today (`14:02:11`), and the date in front for an older one
 * (`2026-10-04 14:02`). A tab left open overnight holds yesterday's results
 * beside today's, and the time alone would not tell them apart.
 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTakenAt(epochMs: number, now: number = Date.now()): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `${time}:${pad(d.getSeconds())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
