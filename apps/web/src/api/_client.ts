/**
 * Tiny shared HTTP client.
 *
 * Wraps `fetch` so each call site doesn't have to repeat:
 *   - prefixing the API base URL,
 *   - JSON encoding the request body,
 *   - checking `response.ok`,
 *   - parsing `ApiErrorBody` and throwing a real `Error` with a stable
 *     `.message`, `.status`, and (when available) `.code`,
 *   - echoing the per-install CSRF token on state-changing requests.
 *
 * For non-JSON bodies (FormData, file uploads) pass `body: <FormData>`
 * directly — the helper sets the `Content-Type` header only for JSON.
 */

import { CSRF_HEADER, CSRF_INVALID_CODE } from '@sediment/shared';

import { routes } from './_routes';
import { API_CONFIG } from '../config/api';

import type { ApiErrorBody, SecurityBootstrapResponse } from '@sediment/shared';

/** Strongly-typed runtime error raised when the server returns a non-2xx. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, body: Partial<ApiErrorBody>, fallback: string) {
    super(body.message?.trim() ? body.message : fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

// ── CSRF token plumbing ──────────────────────────────────────────────
// The token is fetched once at app boot (see `initCsrfToken` below) and
// cached in module-level state. Every non-safe request automatically
// attaches it as the `X-Sediment-CSRF` header; if the server returns a
// 403 with code `CSRF_INVALID` (e.g. the operator wiped
// `data/security-token`) we refresh and retry exactly once.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
let cachedCsrfToken: string | null = null;
let inflightBootstrap: Promise<string> | null = null;

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch(apiUrl(routes.securityBootstrap), {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      {},
      `Security bootstrap failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as SecurityBootstrapResponse;
  if (!body?.csrfToken) {
    throw new ApiError(500, {}, 'Security bootstrap returned no token');
  }
  return body.csrfToken;
}

/**
 * Fetch (or refresh) the CSRF token from the server.
 *
 * Concurrent callers share a single in-flight request. Idempotent —
 * the app calls this at startup, and `apiFetch` calls it again on a
 * stale-token 403.
 */
export async function initCsrfToken(): Promise<string> {
  if (cachedCsrfToken && !inflightBootstrap) return cachedCsrfToken;
  if (!inflightBootstrap) {
    inflightBootstrap = fetchCsrfToken()
      .then((token) => {
        cachedCsrfToken = token;
        return token;
      })
      .finally(() => {
        inflightBootstrap = null;
      });
  }
  return inflightBootstrap;
}

/**
 * Read the cached token without triggering a network request. Returns
 * `null` until `initCsrfToken` has resolved at least once.
 *
 * Exported so the few callers that build their own `fetch` (SSE
 * streams, the `PUT /canvas` writer) can splice the header in by hand.
 */
export function getCsrfToken(): string | null {
  return cachedCsrfToken;
}

function needsCsrf(method: string, url: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  // Don't recurse into the bootstrap endpoint.
  return !url.endsWith(routes.securityBootstrap);
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body' | 'method'> {
  method?: RequestInit['method'];
  /** JSON-serialisable request body. Mutually exclusive with `formData`. */
  json?: unknown;
  /**
   * FormData payload — used for file uploads. The browser will set the
   * correct `multipart/form-data` boundary, so don't add a Content-Type.
   */
  formData?: FormData;
  /** Raw body. Use only when neither `json` nor `formData` fits. */
  body?: BodyInit | null;
  /** Custom fallback message when the server omits one. */
  fallbackMessage?: string;
  /** Disable JSON-decoding the response (e.g. blob downloads). */
  raw?: boolean;
}

/** Build the absolute URL from an API-relative path (e.g. `/canvas/abc`). */
export function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_CONFIG.API_URL}${path}`;
}

async function readErrorBody(
  response: Response,
): Promise<Partial<ApiErrorBody>> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body && typeof body === 'object') return body;
  } catch {
    /* not JSON — fall through */
  }
  return {};
}

function mergeCsrfHeader(
  headers: HeadersInit | undefined,
  token: string | null,
): HeadersInit | undefined {
  if (!token) return headers;
  if (!headers) return { [CSRF_HEADER]: token };
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.set(CSRF_HEADER, token);
    return next;
  }
  if (Array.isArray(headers)) {
    return [...headers, [CSRF_HEADER, token]];
  }
  return { ...headers, [CSRF_HEADER]: token };
}

/**
 * Perform a JSON request and parse the response.
 *
 * Throws `ApiError` for any non-2xx response. The error's `.message`
 * always matches the `ApiErrorBody.message` from the server when
 * present, otherwise falls back to a constructed string so the UI
 * always has *something* to show.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const {
    json,
    formData,
    body,
    fallbackMessage,
    raw,
    headers,
    method,
    ...rest
  } = options;

  let mergedHeaders: HeadersInit | undefined;

  const buildInit = (csrfToken: string | null): RequestInit => {
    const i: RequestInit = { ...rest };
    if (json !== undefined) {
      i.body = JSON.stringify(json);
      mergedHeaders = {
        'Content-Type': 'application/json',
        ...(headers ?? {}),
      };
    } else if (formData) {
      i.body = formData;
      mergedHeaders = headers;
    } else if (body !== undefined) {
      i.body = body;
      mergedHeaders = headers;
    } else {
      mergedHeaders = headers;
    }
    i.method = method ?? (i.body ? 'POST' : 'GET');
    if (needsCsrf(i.method, path)) {
      mergedHeaders = mergeCsrfHeader(mergedHeaders, csrfToken);
    }
    i.headers = mergedHeaders;
    return i;
  };

  const init = buildInit(cachedCsrfToken);
  let response = await fetch(apiUrl(path), init);

  // Stale token (e.g. server restart with regenerated token, or operator
  // wiped `data/security-token`). Refresh and retry exactly once.
  if (
    response.status === 403 &&
    init.method &&
    !SAFE_METHODS.has(init.method)
  ) {
    const errBody = await readErrorBody(response);
    if (errBody.code === CSRF_INVALID_CODE) {
      cachedCsrfToken = null;
      const fresh = await initCsrfToken();
      response = await fetch(apiUrl(path), buildInit(fresh));
    } else {
      throw new ApiError(
        response.status,
        errBody,
        fallbackMessage ??
          `Request to ${path} failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  if (!response.ok) {
    const errBody = await readErrorBody(response);
    throw new ApiError(
      response.status,
      errBody,
      fallbackMessage ??
        `Request to ${path} failed: ${response.status} ${response.statusText}`,
    );
  }

  if (raw || response.status === 204) {
    return undefined as T;
  }

  // Empty body is a valid void response (e.g. fire-and-forget logging endpoints).
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Fire-and-forget variant — swallows errors so the caller doesn't have
 * to. Used by best-effort endpoints (e.g. intent episode logging).
 */
export async function apiFetchVoid(
  path: string,
  options: ApiFetchOptions = {},
): Promise<void> {
  try {
    await apiFetch<void>(path, { ...options, raw: true });
  } catch (err) {
    console.error(`[api] ${path} failed:`, err);
  }
}
