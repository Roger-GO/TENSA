/**
 * An export that was not made, for a reason its message gives in words meant
 * for the user: a run with more values than the format's export takes, say.
 *
 * `<ExportMenu>` shows the message as it is. Any other error a handler throws is
 * taken for a failure of the browser (a blocked download, a canvas that would
 * not rasterise) and gets the hint to check its settings.
 */
export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}
