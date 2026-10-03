/**
 * Arrow IPC frame decoder for `RunStream`.
 *
 * The substrate names the run's columns once, in ``stream_start``
 * (``metadata.var_columns``, ``t`` excluded). After that every WebSocket binary
 * message is one frame: a self-contained Arrow IPC stream holding a record
 * batch of one or more rows with two columns,
 *
 * - ``t``: ``Float64``, the simulated time of each row;
 * - ``v``: ``FixedSizeList<Float64>[ncols]``, each row's values in
 *   ``var_columns`` order.
 *
 * A frame's schema is two fields wide however many variables are streamed, so
 * decoding costs what the values cost. The decoder takes the column names from
 * the caller and reads the values by position: for a single-row frame (the
 * common case, one row per decimation window) each column is a ``Float64Array``
 * view over the frame's one values buffer, with no copy.
 *
 * A run whose ``vars`` selection has no members on the loaded case has no
 * columns; its frames carry ``t`` alone and decode to an empty ``columns``.
 *
 * **NaN handling**: NaN values are preserved (Arrow's Float64 representation
 * is the same as JS Number, so ``NaN`` round-trips). uPlot draws NaN as
 * gaps, which is the desired UI behavior when a worker emits a sentinel.
 */
import { tableFromIPC } from 'apache-arrow';
import type { Table } from 'apache-arrow';

/** A single decoded frame (= one Arrow record batch worth of rows). */
export interface DecodedFrame {
  /** Number of rows in this frame. ``t.length === numRows``. */
  numRows: number;
  /**
   * Time column, one entry per row, monotonically non-decreasing within
   * one stream. Always present.
   */
  t: Float64Array;
  /**
   * All variable columns keyed by name (e.g., ``"Bus_1_v"``), each parallel
   * to ``t``. The ``t`` column is split out separately; this dict holds only
   * the variable columns.
   */
  columns: Record<string, Float64Array>;
  /**
   * Column names in stream order, ``t`` excluded: the ``columnNames`` the frame
   * was decoded with. Useful when a caller needs deterministic ordering (e.g.,
   * merging into the runs store without iterating the unordered ``columns``
   * dict).
   */
  columnNames: readonly string[];
}

/** Read one column of a decoded table as a ``Float64Array``. */
function float64Column(table: Table, name: string): Float64Array {
  const vec = table.getChild(name);
  if (vec === null) {
    throw new Error(`Arrow frame missing required '${name}' column`);
  }
  const arr = vec.toArray();
  // The substrate sends ``Float64``; ``toArray`` returns the underlying typed
  // array for a single chunk (and concatenates a multi-chunk column).
  return arr instanceof Float64Array ? arr : Float64Array.from(arr as ArrayLike<number>);
}

/** Values per row of the frame's ``v`` column: 0 when the frame has none. */
function valuesPerRow(table: Table): number {
  const list = table.getChild('v');
  return list === null ? 0 : (list.type as { listSize: number }).listSize;
}

/**
 * The values of every row, one row after the other: ``rows * columns`` numbers.
 * Reads the list column's child directly, so the rows are not materialized one
 * list at a time.
 */
function flatValues(table: Table): Float64Array {
  const child = table.getChild('v')?.getChildAt(0);
  if (child === null || child === undefined) {
    throw new Error("Arrow frame's 'v' column has no values");
  }
  const flat = child.toArray();
  return flat instanceof Float64Array ? flat : Float64Array.from(flat as ArrayLike<number>);
}

/**
 * Decode one frame (one WS binary message). ``columnNames`` are the names
 * ``stream_start`` announced; the frame's values are matched to them by
 * position, and a frame whose rows are not exactly that wide is an error.
 *
 * A message holding more than one batch (not something the substrate sends
 * today) decodes to one frame with the rows concatenated.
 */
export function decodeArrowBatch(
  buffer: ArrayBuffer,
  columnNames: readonly string[],
): DecodedFrame {
  const table = tableFromIPC(new Uint8Array(buffer));

  if (table.numRows === 0) {
    // Empty batch is a valid wire shape (a flush with no buffered rows).
    // Return an empty frame — caller treats this as "nothing to append".
    return { numRows: 0, t: new Float64Array(0), columns: {}, columnNames: [] };
  }

  const numRows = table.numRows;
  const numColumns = columnNames.length;
  const width = valuesPerRow(table);
  if (width !== numColumns) {
    throw new Error(
      `Arrow frame has ${width} values per row but stream_start named ${numColumns} columns`,
    );
  }
  const t = float64Column(table, 't');
  const columns: Record<string, Float64Array> = {};
  if (numColumns === 0) {
    return { numRows, t, columns, columnNames };
  }

  const flat = flatValues(table);
  if (flat.length !== numRows * numColumns) {
    throw new Error(
      `Arrow frame holds ${flat.length} values for ${numRows} rows of ${numColumns} columns`,
    );
  }
  if (numRows === 1) {
    // One row: column j is the single value at offset j, a view with no copy.
    for (let j = 0; j < numColumns; j += 1) {
      columns[columnNames[j]!] = flat.subarray(j, j + 1);
    }
  } else {
    // Several rows: gather each column's strided values into its own array.
    const gathered = columnNames.map(() => new Float64Array(numRows));
    for (let row = 0; row < numRows; row += 1) {
      const base = row * numColumns;
      for (let j = 0; j < numColumns; j += 1) {
        gathered[j]![row] = flat[base + j]!;
      }
    }
    for (let j = 0; j < numColumns; j += 1) {
      columns[columnNames[j]!] = gathered[j]!;
    }
  }
  return { numRows, t, columns, columnNames };
}
