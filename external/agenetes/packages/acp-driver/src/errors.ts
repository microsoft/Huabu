/**
 * Structured error taxonomy for `ensureAcpSession` and the public
 * `/threads/:threadId/session` route.
 *
 * The route used to return `{message, code: 'acp_session_failed'}` for
 * every server-side throw — a flat black box that the UI could only
 * surface as a generic red "Connect failed" tooltip. Real failures
 * fall into a small set of categories (profile gone, daemon not
 * running, spawn rejected, handshake never completed, …) and each one
 * has a different remediation. {@link AcpServiceError} carries an
 * explicit {@link AcpEnsureErrorCode} so the route can echo it to the
 * client and the UI can choose a category-specific message + action
 * (e.g. "Restart worker", "Re-create profile", "Check OAuth login").
 *
 * Throw policy:
 *
 *   • Inside this module (`service.ts`, `spawn-orchestrator.ts`) — use
 *     `throw new AcpServiceError('code', 'message')` at every failure
 *     site we can categorise.
 *   • Everything else (genuine bugs, unforeseen exceptions) keeps
 *     throwing `Error` and the route maps it to
 *     {@link AcpEnsureErrorCode}.`internal`.
 *
 * The codes are intentionally narrow and stable — adding a new one is
 * fine, but renaming or removing one breaks the web client's tooltip
 * mapping. Mirror any change in
 * `packages/shared/src/types/api/acp.ts` (`AcpEnsureErrorCode`).
 */

/**
 * Categorical reasons why `ensureAcpSession` can fail. Wire-stable —
 * the web client switches on these values to render category-specific
 * tooltips and CTA buttons.
 */
export type AcpEnsureErrorCode =
  /** The bound profile is missing from the profile store AND no
   *  persisted recipe is available to fall back on. User must
   *  re-create or re-pick a profile. */
  | 'profile_missing'
  /** The embedded agentlet server hasn't finished mounting yet (very
   *  early in server boot) — caller may retry after a short delay. */
  | 'bridge_not_mounted'
  /** The agentlet daemon supervisor never brought a worker online
   *  within the readiness timeout (worker crash, missing binary,
   *  permission error). Remediation: "Restart worker" in Settings →
   *  External Agents. */
  | 'worker_not_ready'
  /** The WorkloadSpec targets an agentlet that is not connected. */
  | 'placement_unavailable'
  /** Native session resume/load is unavailable for the persisted session.
   *  Driver-owned recovery may fall back to folded history. */
  | 'session_resume_unavailable'
  /** The agentlet was online but the `spawnOnAgentlet` RPC rejected —
   *  typically a bad recipe (command not found, cwd missing) or a
   *  daemon-side validation failure. */
  | 'spawn_failed'
  /** The agent process was spawned but never opened its WS connection
   *  within the handshake window. Common for agents that need
   *  interactive auth (e.g. Copilot OAuth expired) or were killed
   *  immediately on startup. */
  | 'connect_timeout'
  /** Catch-all for unexpected throws — the route maps any non-
   *  {@link AcpServiceError} to this. */
  | 'internal';

/**
 * Service-layer error with a categorical {@link AcpEnsureErrorCode}.
 * Route handlers detect this via `instanceof` and surface the code
 * verbatim in the response body's `code` field.
 */
export class AcpServiceError extends Error {
  readonly code: AcpEnsureErrorCode;

  constructor(code: AcpEnsureErrorCode, message: string) {
    super(message);
    this.name = 'AcpServiceError';
    this.code = code;
  }
}
