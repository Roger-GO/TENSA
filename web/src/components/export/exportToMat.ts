/**
 * MAT (Matlab v5) export client.
 *
 * The substrate handles the actual file format — `scipy.io.savemat`
 * over the EIG state matrix is the v2.0 plan choice (the EIG routine
 * serves the endpoint; this module is the client side the Export menu
 * calls).
 *
 * The JS MAT-writer ecosystem has no MIT-licensed option (verified by
 * the v2.0 plan's KTD-2 auto-fix: `mat-for-js` is GPL-3 + read-only).
 * Pushing the encoding to Python keeps the client tiny and the file
 * format authoritative.
 *
 * Endpoint: `GET /sessions/{id}/eig/state-matrix.mat` →
 * `application/octet-stream`. Returns 409 when EIG has not been run on the
 * session (404 when the session itself is gone).
 */
import { NetworkError, ProblemDetailsError } from '@/api/client';

const API_PREFIX = '/api';

export interface FetchMatOptions {
  /**
   * Per-call timeout. The MAT endpoint serialises the EIG state matrix
   * (a dense floats matrix) via `scipy.io.savemat`; for IEEE 14 and
   * Kundur the file is < 100 KB and the call is < 1s. Larger systems
   * may need more; the Export menu surfaces a spinner while in flight.
   */
  timeoutMs?: number;
  /** Optional caller-provided abort signal (plumbed alongside the timeout). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Copy for the statuses the endpoint documents, used when the body is not RFC 7807. */
function fallbackProblem(status: number): { title: string; detail: string | null } {
  if (status === 404) {
    return {
      title: 'Session not found',
      detail: 'The session is closed or has expired. Reload the case and run EIG again.',
    };
  }
  if (status === 409) {
    return { title: 'EIG has not been run', detail: 'Run EIG, then export the state matrix.' };
  }
  return { title: `HTTP ${status}`, detail: null };
}

/**
 * Fetch the EIG state matrix as a `.mat` file `Blob`.
 *
 * Throws `ProblemDetailsError` for non-2xx responses (the substrate
 * returns RFC 7807 bodies for 404 / 409 / 422). Throws `NetworkError`
 * for fetch failures or aborts.
 *
 * Returns the raw response Blob with MIME `application/octet-stream`.
 * The Export menu wraps the Blob in an `URL.createObjectURL` + anchor
 * click + revoke for download, mirroring the CSV / PNG paths.
 */
export async function fetchEigStateMatrixMat(
  sessionId: string,
  options: FetchMatOptions = {},
): Promise<Blob> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const url = `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/eig/state-matrix.mat`;
  const headers = new Headers();
  // Hint to the substrate that we want the binary response. The
  // endpoint always returns octet-stream regardless, but the header
  // makes the intent explicit and helps any future content negotiation.
  headers.set('Accept', 'application/octet-stream');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let externalListener: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      externalListener = () => controller.abort();
      signal.addEventListener('abort', externalListener);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal && externalListener) signal.removeEventListener('abort', externalListener);
    if (timedOut) {
      throw new NetworkError(`MAT export timed out after ${timeoutMs}ms`, err);
    }
    throw new NetworkError('MAT export network error', err);
  }
  clearTimeout(timeoutId);
  if (signal && externalListener) signal.removeEventListener('abort', externalListener);

  if (!response.ok) {
    // Mirror andesClient's RFC 7807 parse path. Read JSON if the body
    // shape suggests it; fall back to a synthetic ProblemDetails.
    let body: unknown = undefined;
    try {
      body = await response.clone().json();
    } catch {
      // Empty / non-JSON body — substrate may emit a plain text error.
      // Fall through with a synthesised ProblemDetails.
    }
    const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const fallback = fallbackProblem(response.status);
    throw new ProblemDetailsError(
      {
        type: typeof obj.type === 'string' ? obj.type : 'about:blank',
        title: typeof obj.title === 'string' ? obj.title : fallback.title,
        status: typeof obj.status === 'number' ? obj.status : response.status,
        detail: typeof obj.detail === 'string' ? obj.detail : fallback.detail,
        instance: typeof obj.instance === 'string' ? obj.instance : null,
      },
      body,
      url,
    );
  }
  // The substrate sets the MIME explicitly; if the proxy stripped it,
  // we fall back to the documented contract value.
  const blob = await response.blob();
  if (blob.type === '' || blob.type === 'application/octet-stream') {
    return blob;
  }
  // Re-wrap to normalise the MIME if a middlebox re-tagged it.
  return new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' });
}
