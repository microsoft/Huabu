// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tiny shared HTTP client.
 *
 * Wraps `fetch` so each call site doesn't have to repeat:
 *   - prefixing the API base URL,
 *   - JSON encoding the request body,
 *   - checking `response.ok`,
 *   - parsing `ApiErrorBody` and throwing a real `Error` with a stable
 *     `.message`, `.status`, and (when available) `.code`.
 *
 * For non-JSON bodies (FormData, file uploads) pass `body: <FormData>`
 * directly — the helper sets the `Content-Type` header only for JSON.
 *
 * CSRF / cross-origin protection lives entirely on the server side:
 * it uses `Sec-Fetch-Site` (W3C Fetch Metadata) as the primary signal,
 * with an `Origin` allowlist fallback (see
 * `modules/security/origin-guard.ts`). Both headers are set by the
 * browser and cannot be forged by JS, so the client needs zero extra
 * plumbing here.
 */

import { API_CONFIG } from '../config/api';

import type { ApiErrorBody } from '@huabu/shared';

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

  const init: RequestInit = { ...rest };
  let mergedHeaders: HeadersInit | undefined;
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    mergedHeaders = {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    };
  } else if (formData) {
    init.body = formData;
    mergedHeaders = headers;
  } else if (body !== undefined) {
    init.body = body;
    mergedHeaders = headers;
  } else {
    mergedHeaders = headers;
  }
  init.method = method ?? (init.body ? 'POST' : 'GET');
  init.headers = mergedHeaders;

  const response = await fetch(apiUrl(path), init);

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
