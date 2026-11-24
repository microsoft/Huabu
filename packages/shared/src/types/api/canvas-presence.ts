// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Space presence wire types.
 *
 * Presence is what the other open pages of a Space are doing right now: where
 * their pointer is and which nodes they have selected, are dragging or are
 * editing. It is ephemeral: held in server memory only, never part of the
 * Space record, its version, its delta log, undo, or anything an Agent reads.
 *
 * A page reports with `POST /api/canvas/:canvasId/presence` and leaves with
 * `POST /api/canvas/:canvasId/presence/leave`. Other pages receive `presence`
 * events on the Canvas Sync stream (`GET /api/canvas/:canvasId/sync/stream`),
 * which a page opens with `?pageId=` so it is not sent its own presence.
 */

import { z } from 'zod';

import { CANVAS_PRESENCE_LIMITS } from './canvas-presence-limits.js';
import { canvasPageIdSchema } from './canvas-sync.js';

const pageIdSchema = canvasPageIdSchema;

const coordinateSchema = z
  .number()
  .finite()
  .min(-CANVAS_PRESENCE_LIMITS.maxCoordinate)
  .max(CANVAS_PRESENCE_LIMITS.maxCoordinate);

/** A point in canvas (flow) coordinates, independent of any page's viewport. */
export const canvasPresencePointSchema = z.strictObject({
  x: coordinateSchema,
  y: coordinateSchema,
});
export type CanvasPresencePoint = z.infer<typeof canvasPresencePointSchema>;

const nodeIdsSchema = z
  .array(z.string().min(1).max(CANVAS_PRESENCE_LIMITS.nodeIdMaxLength))
  .max(CANVAS_PRESENCE_LIMITS.maxNodeIds);

const labelSchema = z.string().max(CANVAS_PRESENCE_LIMITS.labelMaxLength);
const displayNameSchema = z
  .string()
  .min(1)
  .max(CANVAS_PRESENCE_LIMITS.displayNameMaxLength);

/**
 * Body of `POST /api/canvas/:canvasId/presence`. Every field but `pageId` is
 * optional and an absent field leaves that part of the page's presence as it
 * was, so a pointer tick does not resend the selection.
 *
 * The page is the caller's own (principal and `pageId` together). There is
 * no name field: the name others see comes from the caller's identity.
 * `editingNodeIds` is the other pages' edit lock and is taken only from a
 * caller with write access to the Space.
 */
export const canvasPresenceReportBodySchema = z.strictObject({
  pageId: pageIdSchema,
  /** Short device/browser label shown next to the marker. */
  label: labelSchema.optional(),
  /** `null` when the pointer is not over the canvas. */
  pointer: canvasPresencePointSchema.nullable().optional(),
  selectedNodeIds: nodeIdsSchema.optional(),
  draggingNodeIds: nodeIdsSchema.optional(),
  editingNodeIds: nodeIdsSchema.optional(),
});
export type CanvasPresenceReportBody = z.infer<
  typeof canvasPresenceReportBodySchema
>;

/** Body of `POST /api/canvas/:canvasId/presence/leave`. */
export const canvasPresenceLeaveBodySchema = z.strictObject({
  pageId: pageIdSchema,
});
export type CanvasPresenceLeaveBody = z.infer<
  typeof canvasPresenceLeaveBodySchema
>;

/** Query of the Canvas Sync stream. */
export const canvasSyncStreamQuerySchema = z.object({
  pageId: pageIdSchema.optional(),
});
export type CanvasSyncStreamQuery = z.infer<typeof canvasSyncStreamQuerySchema>;

/**
 * One other page's presence, as relayed to subscribers.
 *
 * `pageId` identifies the page for the viewer only: a page of the viewer's
 * own principal carries the id it reports with, a page of another principal
 * an id the server assigned. `displayName` is the other principal's name as
 * the identity provider gives it — a page cannot set it — and is absent for
 * the viewer's own pages.
 */
export const canvasPresencePageSchema = z.object({
  pageId: pageIdSchema,
  /** Stable for as long as the page stays present; assigned by the server. */
  colorIndex: z
    .number()
    .int()
    .min(0)
    .max(CANVAS_PRESENCE_LIMITS.colorCount - 1),
  label: labelSchema,
  displayName: displayNameSchema.optional(),
  pointer: canvasPresencePointSchema.nullable(),
  selectedNodeIds: nodeIdsSchema,
  draggingNodeIds: nodeIdsSchema,
  editingNodeIds: nodeIdsSchema,
});
export type CanvasPresencePage = z.infer<typeof canvasPresencePageSchema>;

/**
 * `presence` event on the Canvas Sync stream.
 *
 *  - `snapshot` — sent once on connect: every other page currently present.
 *  - `update` — a page appeared or changed anything but only its pointer.
 *  - `pointer` — a page's pointer moved (or left the canvas: `null`).
 *  - `leave` — a page left, disconnected or expired.
 */
export const canvasPresenceEventSchema = z.object({
  type: z.literal('presence'),
  data: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('snapshot'),
      pages: z.array(canvasPresencePageSchema),
    }),
    z.object({ op: z.literal('update'), page: canvasPresencePageSchema }),
    z.object({
      op: z.literal('pointer'),
      pageId: pageIdSchema,
      pointer: canvasPresencePointSchema.nullable(),
    }),
    z.object({ op: z.literal('leave'), pageId: pageIdSchema }),
  ]),
});
export type CanvasPresenceEvent = z.infer<typeof canvasPresenceEventSchema>;
export type CanvasPresenceEventData = CanvasPresenceEvent['data'];
