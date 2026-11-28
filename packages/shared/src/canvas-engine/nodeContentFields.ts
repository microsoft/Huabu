// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which part of a node is its content: stored in the node's own record
 * (`nodes/<safe(label)>.md` on Disk), saved per node, and left out of the
 * Space's structural state. The page and the server both decide from these
 * lists whether a change is a content change, so there is one copy.
 */

/**
 * `data` keys whose values are node content. A page saves them through the
 * node's content route and leaves them out of the structure commands it
 * sends; the server strips them from structural state and reads a change to
 * any of them as a change of the node's saved content.
 */
export const NODE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
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
 * Node types that own a content record. A node of another type has no
 * content to save.
 *
 * `image`, `video`, `audio`, `frame`, `question` and `sketch` carry only
 * frontmatter. `question` is here so its generated title survives a reload,
 * `sketch` so the `Sketch N` title the engine gives it (and a rename from
 * the Layers panel) does: structure writes leave `label` / `labelSource`
 * out, so the record is the only place they are stored. Stroke geometry
 * stays in structural state.
 */
export const MD_BACKED_NODE_TYPES: ReadonlySet<string> = new Set([
  'fileReference',
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
 * The types of {@link MD_BACKED_NODE_TYPES} that have a body (`content`).
 * The others have a title, a source and so on, but no body text.
 * `question` is one of them: its prompt is `data.content`, like the body of
 * a note.
 */
export const TEXT_BEARING_NODE_TYPES: ReadonlySet<string> = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);
