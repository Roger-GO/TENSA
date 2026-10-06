/**
 * When a kept result was produced, as a list shows it: the time alone for one
 * from today (`14:02:11`), and the date in front for an older one
 * (`2026-10-04 14:02`). Results are kept across a reload of the page, so a list
 * can hold yesterday's beside today's, and the time alone would not tell them
 * apart.
 */
import { pad2 } from '@/lib/pad2';

export function formatTakenAt(epochMs: number, now: number = Date.now()): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `${time}:${pad2(d.getSeconds())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}
