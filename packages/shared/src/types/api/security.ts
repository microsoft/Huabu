/**
 * Security bootstrap API wire types.
 *
 * The `/api/security/bootstrap` endpoint hands the web client the CSRF
 * token it must echo on every state-changing request as
 * `X-Sediment-CSRF`. The token is generated once per server boot and
 * persists to `data/security-token` so it survives restarts (giving
 * stable UX without forcing the user to reload). See
 * `apps/server/src/modules/security` for the server implementation.
 *
 * There is no request body; this is a plain GET. Errors use the shared
 * {@link ApiErrorBody} envelope.
 */

export interface SecurityBootstrapResponse {
  /** Opaque hex string the client must echo on writes. */
  csrfToken: string;
}

/** Error code returned when the CSRF header is missing or does not match. */
export const CSRF_INVALID_CODE = 'CSRF_INVALID';

/** Header name expected by the server on state-changing requests. */
export const CSRF_HEADER = 'X-Sediment-CSRF';
