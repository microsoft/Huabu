/**
 * Backend render profile — the small set of knobs that differ between
 * the built-in (pi-ai) agent and the external (ACP) agent when turning
 * one {@link ChatEnvelope} into a per-turn `ContentPart[]`. Everything
 * else (block order, tag vocabulary, attachment handling) is shared by
 * the single `renderTurn` so the two backends cannot drift.
 *
 * The differences are intentional and tied to how each backend reads
 * node bodies: the built-in agent reads by pre-computed `file=` path
 * (`read()` / `inspect_nodes()`), the external agent reads by id
 * (`read-node <id>`). The sketch-raster hint references built-in-only
 * tools, so it rides only when `nodeReadVerb === 'read'`.
 */

/** Per-backend rendering switches. */
export interface RenderProfile {
  /** How the agent fetches a node body — picks the intro tool verb. */
  nodeReadVerb: 'read' | 'read-node';
  /** Emit `file=` on `<node>` (built-in reads by path; ACP reads by id). */
  includeFileName: boolean;
  /** Inline selection pixels as `<selected_nodes_visuals>` (+ sketch hint). */
  includeSelectionVisuals: boolean;
  /** Put the user task FIRST (slash-command turns) instead of last. */
  leadWithTask: boolean;
}

/** Built-in agent: read-by-path, selection pixels + sketch hint, task last. */
export const INTERNAL_PROFILE: RenderProfile = {
  nodeReadVerb: 'read',
  includeFileName: true,
  includeSelectionVisuals: true,
  leadWithTask: false,
};

/** External/ACP agent: read-by-id, selection pixels, task last. */
export const ACP_PROFILE: RenderProfile = {
  nodeReadVerb: 'read-node',
  includeFileName: false,
  includeSelectionVisuals: true,
  leadWithTask: false,
};
