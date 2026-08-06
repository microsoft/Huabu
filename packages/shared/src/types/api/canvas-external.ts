// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas External Imports API
 *
 * Wire types for the watcher that surfaces user-authored `.md` files
 * dropped into `<canvasDir>/nodes/` outside the app. The web layer
 * shows them as greyed-out rows in the layer panel and lets the user
 * import them on click / double-click.
 */

import { z } from 'zod';

export const externalNoteItemSchema = z.object({
  /** Path relative to `<canvasDir>/`, e.g. `nodes/foo.md`. */
  relativePath: z.string().min(1),
  /** File basename used as the display label, e.g. `foo.md`. */
  fileName: z.string().min(1),
  /** Frontmatter `id:` if present — lets the client dedupe vs canvas state. */
  noteId: z.string().optional(),
  /** File mtime (ms) for tie-breaking and stable ordering. */
  mtime: z.number(),
});

export type ExternalNoteItem = z.infer<typeof externalNoteItemSchema>;

export const externalNoteEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    data: z.object({ items: z.array(externalNoteItemSchema) }),
  }),
  z.object({ type: z.literal('added'), data: externalNoteItemSchema }),
  z.object({
    type: z.literal('removed'),
    data: z.object({ relativePath: z.string() }),
  }),
]);

export type ExternalNoteEvent = z.infer<typeof externalNoteEventSchema>;

export const importExternalNoteBodySchema = z.object({
  relativePath: z.string().min(1),
});

export type ImportExternalNoteRequest = z.infer<
  typeof importExternalNoteBodySchema
>;

export interface ImportExternalNoteResponse {
  label: string;
  content: string;
}
