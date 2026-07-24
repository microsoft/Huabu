/**
 * Per-tab client identity (P2 / Plan A).
 *
 * A stable, opaque id minted once per page load. It rides the autosave
 * `PUT /api/canvas/:canvasId` body as `clientId` and is echoed back on the
 * sync broadcast as `originatorClientId`, so this tab can skip its *own*
 * PUT echo instead of re-applying a change it already rendered
 * optimistically. Not persisted — a reload deliberately starts a new
 * session id.
 */
export const CLIENT_ID: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
