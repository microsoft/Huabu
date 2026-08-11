// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared constants describing which node fields participate in the
 * per-node markdown sidecar pipeline. Imported by both:
 *
 *   • {@link ../save/structureDirtyDetector} — to *exclude* these
 *     fields from the structure-save diff (content edits must not dirty
 *     `structureRevision`, even though their own commit advances version).
 *   • the future `nodeContentQueue` extraction — to *include* them
 *     in the per-node `PUT /api/canvas/:id/nodes/:nodeId/content`
 *     body and decide which nodes own a `.md` sidecar.
 *
 * Keep in sync with the server-side `MD_BACKED_NODE_TYPES` /
 * `putNodeContentBodySchema`. See `docs/node-content-api-split.md`.
 */

/**
 * `data` keys whose values live in the per-node markdown sidecar
 * (`nodes/<safe(label)>.md`), not in structural state. A patch touching
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
 *
 * `sketch` is included for the same reason as `question`: the canvas
 * engine auto-stamps a `Sketch N` label on creation (and the user can
 * rename it from the layer panel) but the structure PUT strips
 * `label` / `labelSource`. Without a sidecar those fields would only
 * live in memory and the layer panel would show a blank row after
 * reload. The sidecar is frontmatter-only — stroke geometry stays
 * inline in structural state.
 */
export const MD_BACKED_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'image',
  'video',
  'audio',
  'frame',
  'question',
  'sketch',
]);

/**
 * Subset of {@link MD_BACKED_NODE_TYPES} that carry a `content` field
 * (free-form markdown body). The other md-backed types still have
 * label / src / etc. but no body text.
 *
 * `question` is in here: its prompt lives at `data.content` exactly
 * like a note / text body, so a single rule handles persistence and
 * canvas search picks it up for free.
 */
export const TEXT_BEARING_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);
