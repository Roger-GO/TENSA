/**
 * Arrow IPC stream-chunk decoder for `RunStream`.
 *
 * Each WebSocket binary message from the substrate is one Arrow IPC stream
 * chunk: schema preamble + one (or more) RecordBatch with one or more
 * rows. The schema is ``t: float64`` plus one ``Float64`` column per
 * variable selected at ``start_tds`` time (e.g., ``Bus_1_v``,
 * ``Gen_2_omega``, ``Line_4_5_p`` ...).
 *
 * The decoder uses ``apache-arrow``'s ``RecordBatchStreamReader`` (or
 * ``tableFromIPC`` — equivalent under the hood) to materialize each batch.
 * For each row, columns are pushed into ``DecodedFrame.columns`` keyed by
 * column name, and the ``t`` column is split out separately.
 *
 * **Forward-compat**: any column the substrate adds in the future (beyond
 * the v0.2 ``bus_v``/``gen_state``/``line_flow`` set) is preserved in
 * ``columns`` exactly as named — the decoder is schema-agnostic. Unknown
 * columns flow through to the runs slice so a future plot kind can read
 * them without a decoder change.
 *
 * **NaN handling**: NaN values are preserved (Arrow's Float64 representation
 * is the same as JS Number, so ``NaN`` round-trips). uPlot draws NaN as
 * gaps, which is the desired UI behavior when a worker emits a sentinel.
 */
import { tableFromIPC } from 'apache-arrow';

/** A single decoded frame (= one Arrow record batch worth of rows). */
export interface DecodedFrame {
  /** Number of rows in this frame. ``t.length === numRows``. */
  numRows: number;
  /**
   * Time column, one entry per row, monotonically non-decreasing within
   * one stream. Always present — the schema guarantees a ``t`` field.
   */
  t: Float64Array;
  /**
   * All variable columns keyed by the Arrow field name (e.g.,
   * ``"Bus_1_v"``). The ``t`` column is split out separately; this dict
   * holds only the variable columns. Order is preserved from the schema
   * for any caller that needs to walk columns in declaration order.
   */
  columns: Record<string, Float64Array>;
  /**
   * Column names in schema order, ``t`` excluded. Useful when a caller
   * needs deterministic ordering (e.g., merging into the runs store
   * without iterating the unordered ``columns`` dict).
   */
  columnNames: readonly string[];
}

/**
 * Decode one Arrow IPC stream chunk (one WS binary message) into a
 * ``DecodedFrame``.
 *
 * The substrate sends each WS binary message as a self-contained Arrow
 * IPC stream — schema preamble + one RecordBatch with one or more rows.
 * In rare cases the worker may emit more than one batch in a single
 * message (e.g., decimation flush-tail); this decoder concatenates rows
 * across all batches in the message into a single ``DecodedFrame``.
 */
export function decodeArrowBatch(buffer: ArrayBuffer): DecodedFrame {
  // ``tableFromIPC`` accepts a ``Uint8Array`` or an iterable of them and
  // returns a ``Table`` that has materialized all RecordBatches in the
  // input. For one-batch-per-message (the common case) this is a single
  // batch; for multi-batch messages the rows are concatenated.
  const table = tableFromIPC(new Uint8Array(buffer));

  if (table.numRows === 0) {
    // Empty batch is a valid wire shape (a flush with no buffered rows).
    // Return an empty frame — caller treats this as "nothing to append".
    return { numRows: 0, t: new Float64Array(0), columns: {}, columnNames: [] };
  }

  // ``table.schema.fields`` preserves the on-wire column order.
  const fields = table.schema.fields;
  const tField = fields.find((f) => f.name === 't');
  if (!tField) {
    throw new Error("Arrow batch missing required 't' column");
  }

  // Materialize each column to a contiguous ``Float64Array``. The Arrow
  // ``Vector#toArray`` API returns the underlying typed array when the
  // column is a single chunk — which it almost always is for one-batch
  // messages. If the column is multi-chunked, ``toArray`` concatenates
  // for us, paying one O(n) copy.
  let tArr: Float64Array | null = null;
  const columns: Record<string, Float64Array> = {};
  const columnNames: string[] = [];

  for (const field of fields) {
    const vec = table.getChild(field.name);
    if (vec === null) continue;
    const arr = vec.toArray();
    // The substrate schema is exclusively ``Float64`` for ``t`` and every
    // variable column. ``toArray`` returns a ``Float64Array`` directly in
    // that case — no copy needed beyond what Arrow already did.
    const f64: Float64Array =
      arr instanceof Float64Array ? arr : Float64Array.from(arr as ArrayLike<number>);
    if (field.name === 't') {
      tArr = f64;
    } else {
      columns[field.name] = f64;
      columnNames.push(field.name);
    }
  }

  if (tArr === null) {
    throw new Error("Arrow batch 't' column failed to materialize");
  }

  return {
    numRows: table.numRows,
    t: tArr,
    columns,
    columnNames,
  };
}
