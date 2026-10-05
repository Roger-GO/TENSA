/**
 * COMTRADE (IEEE C37.111) export client.
 *
 * Like the MAT export, the file format is the substrate's: `POST /comtrade`
 * takes the signals and answers with a `.zip` of the record's `.cfg` and its
 * ASCII `.dat` (`tensa.core.comtrade` says what the two hold). The run's samples
 * live in the browser, so they are sent with the request, which holds no
 * session: a run kept from an earlier session exports like the active one.
 *
 * `lib/comtrade.ts` decides what is sent; this module sends it.
 */
import { fetchComtradeRecord } from '@/api/queries';
import { comtradeRequest } from '@/lib/comtrade';
import type { RunRecord } from '@/store/runs';

/**
 * The columns `names` of `run` as a COMTRADE record: the `.zip` as a `Blob`, or
 * `null` when the run has nothing to write. Throws `ExportRefusedError` for more
 * values than one export takes, and the API client's typed errors when the
 * substrate refuses or cannot be reached.
 */
export async function exportRunToComtrade(
  run: RunRecord,
  names: readonly string[],
): Promise<Blob | null> {
  const request = comtradeRequest(run, names);
  if (request === null) return null;
  return await fetchComtradeRecord(request);
}
