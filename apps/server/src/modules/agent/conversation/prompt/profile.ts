// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Backend render profile — the small set of knobs that differ between
 * the built-in (pi-ai) agent and the external (ACP) agent when turning
 * one {@link ChatEnvelope} into a per-turn `ContentPart[]`. Everything
 * else (block order, tag vocabulary, attachment handling) is shared by
 * the single `renderTurn` so the two backends cannot drift.
 *
 * The differences are intentional and tied to how each backend reads
 * node bodies: the built-in agent reads by pre-computed `file=` path
 * (`read()` / `inspect_nodes()`), the external agent downloads by that
 * same `file=` path over the RFS (`GET ${HUABU_RFS_URL}/download/<file>`).
 * The sketch-raster reuse hint is worded per `toolset` (built-in
 * `snapshot_nodes` vs asking the canvas agent to render).
 */

/** Per-backend rendering switches. */
export interface RenderProfile {
  /**
   * Which tool surface the agent has — picks the read verb in section
   * intros and tool-specific wording. `internal` reads by `file=` path
   * (`read()` / `inspect_nodes()`); `reachback` downloads by that same
   * `file=` path over the RFS (`GET ${HUABU_RFS_URL}/download/<file>`).
   */
  toolset: 'internal' | 'reachback';
  /** Inline selection pixels as `<selected_nodes_visuals>` (+ sketch hint). */
  includeSelectionVisuals: boolean;
  /** Put the user task FIRST (slash-command turns) instead of last. */
  leadWithTask: boolean;
}

/** Built-in agent: read-by-path, selection pixels + sketch hint, task last. */
export const INTERNAL_PROFILE: RenderProfile = {
  toolset: 'internal',
  includeSelectionVisuals: true,
  leadWithTask: false,
};

/** External/ACP agent: read-by-path (over RFS), selection pixels, task last. */
export const ACP_PROFILE: RenderProfile = {
  toolset: 'reachback',
  includeSelectionVisuals: true,
  leadWithTask: false,
};

/** ACP slash-command turn: command must lead so the agent recognises it. */
export const ACP_SLASH_PROFILE: RenderProfile = {
  ...ACP_PROFILE,
  leadWithTask: true,
};
