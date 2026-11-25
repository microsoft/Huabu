// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared constants describing which node fields participate in the
 * per-node markdown sidecar pipeline. Imported by both:
 *
 *   • the store's send queue — to *exclude* these fields from the
 *     structure commands it sends (content edits must not bump
 *     `canvas.version`).
 *   • the future `nodeContentQueue` extraction — to *include* them
 *     in the per-node `PUT /api/canvas/:id/nodes/:nodeId/content`
 *     body and decide which nodes own a `.md` sidecar.
 *
 * Keep in sync with the server-side `MD_BACKED_NODE_TYPES` /
 * `putNodeContentBodySchema`. See `docs/architecture/canvas-realtime-sync.md`.
 */

/**
 * `data` keys whose values live in the per-node markdown sidecar
 * (`nodes/<safe(label)>.md`), not in structural state. A patch touching
 * any of these schedules a per-node content save and the key is
 * left out of the structure commands the page sends.
 */
export const NODE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'dataSchema',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
  'properties',
  'propertyDisplayKeys',
]);

/**
 * The content keys that hold a node's custom properties. No revision covers
 * them and they are saved per key; every other content field belongs to the
 * body's save.
 */
export const PROPERTY_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'properties',
  'propertyDisplayKeys',
]);

/** The title: a label and the source that says who gave it. */
export const TITLE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'label',
  'labelSource',
]);

/** The body's fields: the ones a node's content revision covers. */
export const BODY_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'src',
  'dataSchema',
]);

/**
 * The content field a property unit belongs to (see `sync/propertyUnits.ts`):
 * `data.label` is `label`, `data.properties.<key>` is the custom property
 * `<key>` of `properties`. `null` for a unit that is not node content.
 */
export function contentFieldOfUnit(
  unit: string,
): { field: string; propertyKey?: string } | null {
  if (!unit.startsWith('data.')) return null;
  const rest = unit.slice(5);
  if (NODE_CONTENT_KEYS.has(rest)) return { field: rest };
  if (rest.startsWith('properties.'))
    return { field: 'properties', propertyKey: rest.slice(11) };
  return null;
}

/**
 * Node types that own a markdown sidecar. Mirrors the server-side
 * `MD_BACKED_NODE_TYPES`. Patches to nodes whose type is not in this
 * set still update the in-memory store but do not schedule a content
 * save (there is no `.md` to write).
 *
 * `question` is included as a frontmatter-only sidecar (no body) so
 * its auto-generated label / labelSource survive canvas reloads —
 * without this, `patchNodeSilent({label, labelSource})` would only
 * live in memory because structure commands leave both fields out.
 *
 * `sketch` is included for the same reason as `question`: the canvas
 * engine auto-stamps a `Sketch N` label on creation (and the user can
 * rename it from the layer panel) but structure commands leave out
 * `label` / `labelSource`. Without a sidecar those fields would only
 * live in memory and the layer panel would show a blank row after
 * reload. The sidecar is frontmatter-only — stroke geometry stays
 * inline in structural state.
 */
export const MD_BACKED_NODE_TYPES: ReadonlySet<string> = new Set([
  'fileReference',
  'data',
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
  'data',
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);

/** `data` with `patch` laid over it; a key patched to `undefined` is removed. */
export function withContentPatch(
  data: Record<string, unknown> | undefined,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data, ...patch };
  for (const [key, value] of Object.entries(patch))
    if (value === undefined) delete next[key];
  return next;
}

/**
 * Types whose sidecar carries data only the server can produce and the web
 * never holds: a PDF's extracted text (the web renders from `data.src`; see
 * the server's `WIRE_INLINE_CONTENT_TYPES`), a video's cover.
 *
 * Deleting the node deletes that data and an undo can only write back what
 * the web has. So for these types a missing body does not mean an incomplete
 * snapshot, and they are preprocessed again once the restored sidecar is
 * saved.
 */
export const SERVER_DERIVED_SIDECAR_NODE_TYPES: ReadonlySet<string> = new Set([
  'pdf',
  'video',
]);
