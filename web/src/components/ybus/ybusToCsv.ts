/**
 * The CSV download of the Ybus dialog: one header row of column names, then
 * one row per entry, in the order the table shows them (filtered and sorted),
 * so the file exports as the table reads. ``row_idx`` and ``col_idx`` are the
 * idx of the bus of the row and of the column, as the table shows them.
 */
import { recordsToCsv } from '@/components/export/exportToCsv';
import type { components } from '@/api/generated';

/** The bus admittance matrix of the loaded case, as sparse triplets. */
type YbusResponse = components['schemas']['YbusResponse'];

/** One entry of the matrix, as the dialog's table lists it. */
export type YbusEntry = YbusResponse['entries'][number];

const YBUS_CSV_COLUMNS = ['row_idx', 'col_idx', 'g_pu', 'b_pu'];

/** A number at full precision, keeping the sign of a negative zero. */
function exact(x: number): number | string {
  return Object.is(x, -0) ? '-0' : x;
}

/**
 * Build the CSV Blob of the entries the table shows, in that order. Each row
 * is ``[bus_idx[row], bus_idx[col], re, im]`` with the numbers written as the
 * shortest text that reads back as the same double.
 */
export function ybusToCsv(data: YbusResponse, entries: readonly YbusEntry[]): Blob {
  return recordsToCsv({
    columns: YBUS_CSV_COLUMNS,
    rows: entries.map((e) => [
      data.bus_idx[e.row] ?? '',
      data.bus_idx[e.col] ?? '',
      exact(e.re),
      exact(e.im),
    ]),
  });
}
