// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The page's view of node content: how the content fields divide between
 * the body's save, the title and the custom properties. Which fields are
 * content at all, and which node types have a content record, is the same
 * on the server and comes from `@huabu/shared/canvas-engine`. See
 * `docs/architecture/canvas-realtime-sync.md`.
 */

import {
  CONTENT_REVISION_KEYS,
  NODE_CONTENT_KEYS,
} from '@huabu/shared/canvas-engine';

export {
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  TEXT_BEARING_NODE_TYPES,
} from '@huabu/shared/canvas-engine';

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
export const BODY_CONTENT_KEYS: ReadonlySet<string> = new Set(
  CONTENT_REVISION_KEYS,
);

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
