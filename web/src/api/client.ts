/**
 * Fetch wrapper for the substrate HTTP API.
 *
 * Responsibilities:
 *
 * - Inject the `X-Andes-Token` header from the auth store on every call.
 *   The token getter is a module-level injection point so tests can swap
 *   it without spinning up a Zustand store.
 * - Resolve all paths against `/api/*` so the Vite dev proxy (or the
 *   production wheel-bundled FastAPI mount) can route to the substrate's
 *   root paths uniformly.
 * - Canonicalize non-2xx responses into typed `Error` subclasses
 *   (`ProblemDetailsError`, `RateLimitedError`, `NetworkError`, etc.) so
 *   call sites pattern-match on `instanceof` rather than re-parsing
 *   ad-hoc objects.
 * - Per-call timeouts via `AbortController`. Each endpoint passes its own
 *   timeout (10s default for lifecycle calls; 60s for case load + PF).
 *
 * Per the v0.1 plan: 401 → caller is expected to clear the auth store and
 * reopen the modal. We surface `ProblemDetailsError` with `status === 401`
 * and let the queries layer decide; the client itself is dumb on purpose.
 */
import type { ProblemDetails } from './types';

// ---- error taxonomy --------------------------------------------------------

/**
 * A non-2xx response whose body parsed as RFC 7807 ProblemDetails. Carries
 * the status code so callers can pattern-match `err.status === 401`.
 */
export class ProblemDetailsError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly raw: ProblemDetails;

  constructor(problem: ProblemDetails) {
    // Title + detail compose the message. Either may be missing; fall back
    // sensibly so logs / DevTools at least surface the status.
    const message = problem.detail
      ? `${problem.title}: ${problem.detail}`
      : (problem.title ?? `HTTP ${problem.status}`);
    super(message);
    this.name = 'ProblemDetailsError';
    this.type = problem.type ?? 'about:blank';
    this.title = problem.title ?? `HTTP ${problem.status}`;
    this.status = problem.status;
    this.detail = problem.detail ?? undefined;
    this.instance = problem.instance ?? undefined;
    this.raw = problem;
  }
}

/**
 * 429 with a `Retry-After` header. Carries the parsed retry-after seconds
 * so the UI can show a countdown without re-parsing the header.
 */
export class RateLimitedError extends ProblemDetailsError {
  readonly retryAfterSeconds: number | undefined;

  constructor(problem: ProblemDetails, retryAfterSeconds: number | undefined) {
    super(problem);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A 5xx response. Routed by the UI to the runtime-crash modal (R8). */
export class ServerError extends ProblemDetailsError {
  constructor(problem: ProblemDetails) {
    super(problem);
    this.name = 'ServerError';
  }
}

/**
 * The fetch itself failed (DNS, network drop, AbortController fired before
 * a response arrived, response body wasn't valid JSON, etc.). Distinct
 * from a server-returned error.
 */
export class NetworkError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

// ---- token-getter injection -----------------------------------------------

/**
 * The token-getter the client uses to fetch the current auth token. Wired
 * to the Zustand store at App boot (`web/src/store/auth.ts`); tests
 * override it via `setTokenGetter`.
 */
export type TokenGetter = () => string | null;

let tokenGetter: TokenGetter = () => null;

export function setTokenGetter(getter: TokenGetter): void {
  tokenGetter = getter;
}

// ---- client core ----------------------------------------------------------

export interface RequestOptions {
  /** Optional JSON body. Will be `JSON.stringify`ed and `Content-Type` set. */
  body?: unknown;
  /** Per-call timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** External AbortSignal — combined with the per-call timeout. */
  signal?: AbortSignal;
  /** Optional URL search-params (object form). */
  query?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const API_PREFIX = '/api';

/**
 * Combine an optional caller-provided `AbortSignal` with a timeout-driven
 * one so either source can abort the request. Returns the AbortController
 * we own (so we can cancel its setTimeout) plus a cleanup function.
 */
function makeAbortController(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  controller: AbortController;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOutFlag = false;
  const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOutFlag = true;
    controller.abort();
  }, timeoutMs);
  let externalListener: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalListener = () => controller.abort();
      externalSignal.addEventListener('abort', externalListener);
    }
  }
  return {
    controller,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (externalListener && externalSignal) {
        externalSignal.removeEventListener('abort', externalListener);
      }
    },
    timedOut: () => timedOutFlag,
  };
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
  const base = path.startsWith('/') ? `${API_PREFIX}${path}` : `${API_PREFIX}/${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Parse a `Retry-After` header. The substrate emits seconds-as-integer; we
 * also accept HTTP-date format defensively (returns `undefined` on parse
 * failure rather than throwing — the UI has a sane default).
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    const seconds = Math.max(0, Math.round((asDate - Date.now()) / 1000));
    return seconds;
  }
  return undefined;
}

/**
 * Coerce an arbitrary parsed JSON body into a `ProblemDetails`. The substrate
 * emits well-formed bodies, but RFC 7807 leaves several fields optional and
 * a misbehaving proxy in front could strip fields, so we defend against
 * partial shapes.
 */
function coerceProblemDetails(status: number, body: unknown): ProblemDetails {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    type: typeof obj.type === 'string' ? obj.type : 'about:blank',
    title: typeof obj.title === 'string' ? obj.title : `HTTP ${status}`,
    status: typeof obj.status === 'number' ? obj.status : status,
    detail: typeof obj.detail === 'string' ? obj.detail : null,
    instance: typeof obj.instance === 'string' ? obj.instance : null,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, query } = options;
  const url = buildUrl(path, query);
  const headers = new Headers();
  const token = tokenGetter();
  if (token) headers.set('X-Andes-Token', token);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  const { controller, cleanup, timedOut } = makeAbortController(timeoutMs, signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (timedOut()) {
      throw new NetworkError(`Request to ${method} ${url} timed out after ${timeoutMs}ms`, err);
    }
    throw new NetworkError(`Network error on ${method} ${url}`, err);
  }
  cleanup();

  if (response.status === 204) {
    // No body; cast through unknown for the rare endpoint that returns 204.
    return undefined as unknown as T;
  }

  const parsed = await readJson(response);

  if (response.ok) {
    return parsed as T;
  }

  const problem = coerceProblemDetails(response.status, parsed);

  if (response.status === 429) {
    throw new RateLimitedError(problem, parseRetryAfter(response.headers.get('Retry-After')));
  }
  if (response.status >= 500) {
    throw new ServerError(problem);
  }
  throw new ProblemDetailsError(problem);
}

/** Public client surface — verb-named methods returning typed bodies. */
export const andesClient = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, opts?: RequestOptions) => request<T>('POST', path, opts),
  put: <T>(path: string, opts?: RequestOptions) => request<T>('PUT', path, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

/** Per-endpoint timeout knobs, exported so the queries layer can pass them. */
export const TIMEOUTS = {
  /** Session create / list / describe / delete. Snappy; 10s is generous. */
  sessionLifecycle: 10_000,
  /** Case load may include first-time prep + parse. */
  caseLoad: 60_000,
  /** PF run on a moderately-sized case can take seconds. */
  pflowRun: 60_000,
  /** Topology read is post-load + cheap. */
  topology: 10_000,
  /** Workspace lister scan. */
  workspace: 10_000,
} as const;
