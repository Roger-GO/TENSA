/**
 * Builds the binary messages the substrate sends over the stream WebSocket.
 *
 * A frame is one Arrow IPC stream holding a record batch with a `t` column and
 * a `v` column, a fixed-size list with one entry per variable per row. The
 * variable names are not in the frame: `stream_start` announces them, and the
 * entries of `v` follow the order of `var_columns`. These helpers take the
 * columns by name for readability and lay the values out in the order the
 * object lists them, so a test must give `var_columns` that same order.
 * A call with no columns builds a frame with `t` alone, which is what the
 * substrate sends when the selected variables have no members on the case.
 */
import {
  Field,
  FixedSizeList,
  Float64,
  RecordBatch,
  Schema,
  Struct,
  Table,
  makeData,
  tableToIPC,
} from 'apache-arrow';
import type { Data } from 'apache-arrow';

export interface FrameBatch {
  t: readonly number[];
  cols: Readonly<Record<string, readonly number[]>>;
}

function recordBatch({ t, cols }: FrameBatch): RecordBatch {
  const names = Object.keys(cols);
  const rows = t.length;
  const float = new Float64();
  const tData = makeData({ type: float, data: new Float64Array(t) });
  const fields: Field[] = [new Field('t', float, true)];
  const children: Data[] = [tData];

  if (names.length > 0) {
    const flat = new Float64Array(rows * names.length);
    names.forEach((name, j) => {
      const column = cols[name]!;
      for (let row = 0; row < rows; row += 1) flat[row * names.length + j] = column[row]!;
    });
    const listType = new FixedSizeList(names.length, new Field('item', float, true));
    fields.push(new Field('v', listType, true));
    children.push(
      makeData({
        type: listType,
        length: rows,
        nullCount: 0,
        child: makeData({ type: float, data: flat }),
      }),
    );
  }

  const struct = new Struct(fields);
  return new RecordBatch(
    new Schema(fields),
    makeData({ type: struct, length: rows, nullCount: 0, children }),
  );
}

/** One WS binary message holding every batch given, in order. */
export function arrowBatches(batches: readonly FrameBatch[]): ArrayBuffer {
  const bytes = tableToIPC(new Table(batches.map(recordBatch)), 'stream');
  // Copy into a fresh ``ArrayBuffer`` so the wire frame is the concrete
  // ``ArrayBuffer`` shape ``mock-socket`` and the decoder both expect
  // (``Uint8Array#buffer`` widens to ``ArrayBufferLike``).
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** One WS binary message: a single record batch of `t.length` rows. */
export function arrowFrame(
  t: readonly number[],
  cols: Readonly<Record<string, readonly number[]>>,
): ArrayBuffer {
  return arrowBatches([{ t, cols }]);
}
