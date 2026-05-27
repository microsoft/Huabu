/**
 * Shared constants describing which node fields participate in the
 * per-node markdown sidecar pipeline. Imported by both:
 *
 *   • {@link ../save/structureDirtyDetector} — to *exclude* these
 *     fields from the structure-save diff (content edits must not
 *     bump `canvas.version`).
 *   • the future `nodeContentQueue` extraction — to *include* them
 *     in the per-node `PUT /api/canvas/:id/nodes/:nodeId/content`
 *     body and decide which nodes own a `.md` sidecar.
 *
 * Keep in sync with the server-side `MD_BACKED_NODE_TYPES` /
 * `putNodeContentBodySchema`. See `docs/node-content-api-split.md`.
 */

/**
 * `data` keys whose values live in the per-node markdown sidecar
 * (`nodes/<safe(label)>.md`), not in `canvas.json`. A patch touching
 * any of these schedules a per-node content save and the key is
 * stripped from the structure PUT body so a viewport drag does not
 * rewrite content.
 */
export const NODE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
]);

/**
 * Node types that own a markdown sidecar. Mirrors the server-side
 * `MD_BACKED_NODE_TYPES`. Patches to nodes whose type is not in this
 * set still update the in-memory store but do not schedule a content
 * save (there is no `.md` to write).
 *
 * `question` is included as a frontmatter-only sidecar (no body) so
 * its auto-generated label / labelSource survive canvas reloads —
 * without this, `patchNodeSilent({label, labelSource})` would only
 * live in memory because the structure PUT strips both fields.
 */
export const MD_BACKED_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'video',
  'frame',
  'question',
]);

/**
 * Subset of {@link MD_BACKED_NODE_TYPES} that carry a `content` field
 * (free-form markdown body). The other md-backed types still have
 * label / src / etc. but no body text.
 */
export const TEXT_BEARING_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
]);
