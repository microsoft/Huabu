// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The shape of every `CanvasCommand` as it may arrive in the body of
 * `POST /api/canvas/:canvasId/execute`.
 *
 * The route's body schema keeps `commands` as `unknown[]`; this is what each
 * of them is checked against before the engine sees it. It mirrors the
 * `CanvasCommand` union (`types/canvas/command.ts`) and states what a handler
 * dereferences: that a list is a list, an item an object, an id a non-empty
 * string, a point two numbers. A command that does not fit is a malformed
 * request (400), not something for a handler to trip over. Vocabulary — a
 * node type, a layout mode, an align direction — is only required to be a
 * string here: whether the word is one the engine knows is its answer.
 *
 * It is deliberately not the agent schema (`agentCanvasCommandSchema`):
 * that one is strict and describes the narrower vocabulary agents are
 * given. Objects here are loose — extra keys pass through to the engine,
 * which ignores or validates them — and whether a well-formed command is
 * *acceptable* (the node exists, the parent is a container, the source may
 * issue it) stays the engine's answer, reported per command.
 */

import { z } from 'zod';

import type { CanvasCommandType } from '../canvas/command.js';

const id = z.string().min(1);
const ids = z.array(id);
const record = z.record(z.string(), z.unknown());
const point = z.looseObject({ x: z.number(), y: z.number() });
const size = z.looseObject({
  width: z.number().optional(),
  height: z.union([z.number(), z.literal('auto')]).optional(),
});
const edgeRef = z.union([id, z.looseObject({ source: id, target: id })]);

const createdNode = z.looseObject({
  id: id.optional(),
  nodeType: id,
  data: record.optional(),
  position: point.optional(),
  size: size.optional(),
  parentId: id.nullable().optional(),
  selectOnCreate: z.boolean().optional(),
});

const dataPatch = z.looseObject({
  nodeId: id,
  patch: record,
  unset: z.array(id).optional(),
  expectRev: z.string().optional(),
  expectViewRev: z.string().optional(),
});

const restoredNode = z.looseObject({
  id,
  type: id,
  position: point,
  data: record.optional(),
  parentId: id.nullable().optional(),
});

const restoredEdge = z.looseObject({ id, source: id, target: id });

const COMMAND_SHAPES = {
  CREATE_NODES: z.looseObject({
    type: z.literal('CREATE_NODES'),
    nodes: z.array(createdNode),
  }),
  INITIALIZE_PDF_NOTE: z.looseObject({
    type: z.literal('INITIALIZE_PDF_NOTE'),
    nodeId: id,
    noteId: id.optional(),
  }),
  DELETE_NODES: z.looseObject({
    type: z.literal('DELETE_NODES'),
    nodeIds: ids,
  }),
  MERGE_NODE_DATA: z.looseObject({
    type: z.literal('MERGE_NODE_DATA'),
    patches: z.array(dataPatch),
  }),
  SET_NODE_PARENT: z.looseObject({
    type: z.literal('SET_NODE_PARENT'),
    nodeIds: ids,
    parentId: id.nullable(),
  }),
  DISSOLVE_FRAME: z.looseObject({
    type: z.literal('DISSOLVE_FRAME'),
    frameId: id,
  }),
  SET_NODE_GEOMETRY: z.looseObject({
    type: z.literal('SET_NODE_GEOMETRY'),
    items: z.array(
      z.looseObject({
        nodeId: id,
        position: point.optional(),
        size: size.optional(),
      }),
    ),
  }),
  REORDER_NODES: z.looseObject({
    type: z.literal('REORDER_NODES'),
    nodeIds: ids,
    to: z.union([
      z.literal('top'),
      z.literal('bottom'),
      z.looseObject({ before: id }),
      z.looseObject({ after: id }),
    ]),
  }),
  CONNECT_NODES: z.looseObject({
    type: z.literal('CONNECT_NODES'),
    edges: z.array(
      z.looseObject({
        id: id.optional(),
        source: id,
        target: id,
        style: record.optional(),
      }),
    ),
  }),
  DISCONNECT_EDGES: z.looseObject({
    type: z.literal('DISCONNECT_EDGES'),
    edges: z.array(edgeRef),
  }),
  SET_EDGE_STYLE: z.looseObject({
    type: z.literal('SET_EDGE_STYLE'),
    edges: z.array(z.looseObject({ edge: edgeRef, style: record })),
  }),
  ALIGN_NODES: z.looseObject({
    type: z.literal('ALIGN_NODES'),
    nodeIds: ids,
    direction: z.string(),
  }),
  DISTRIBUTE_NODES: z.looseObject({
    type: z.literal('DISTRIBUTE_NODES'),
    nodeIds: ids,
  }),
  SET_NODE_SELECTION: z.looseObject({
    type: z.literal('SET_NODE_SELECTION'),
    nodeIds: ids,
  }),
  SET_NODE_LOCKED: z.looseObject({
    type: z.literal('SET_NODE_LOCKED'),
    items: z.array(z.looseObject({ nodeId: id, locked: z.boolean() })),
  }),
  APPLY_MEASURED_HEIGHT: z.looseObject({
    type: z.literal('APPLY_MEASURED_HEIGHT'),
    items: z.array(
      z.looseObject({
        nodeId: id,
        intrinsicHeight: z.number(),
        measuredFor: z.string(),
        provisional: z.boolean().optional(),
      }),
    ),
  }),
  APPLY_MEASURED_SIZE: z.looseObject({
    type: z.literal('APPLY_MEASURED_SIZE'),
    items: z.array(
      z.looseObject({
        nodeId: id,
        width: z.number(),
        height: z.number(),
        measuredFor: z.string(),
      }),
    ),
  }),
  SET_FRAME_LAYOUT: z.looseObject({
    type: z.literal('SET_FRAME_LAYOUT'),
    frameId: id,
    mode: z.string(),
    gridCount: z.number().optional(),
    gridRowCount: z.number().optional(),
    sizing: z.string().optional(),
    cells: z
      .array(
        z.looseObject({
          nodeId: id,
          column: z.number().optional(),
          row: z.number().optional(),
        }),
      )
      .optional(),
    placements: z.array(z.looseObject({})).optional(),
  }),
  CHANGE_NODE_TYPE: z.looseObject({
    type: z.literal('CHANGE_NODE_TYPE'),
    nodeId: id,
    to: z.string(),
  }),
  RESTORE_NODES: z.looseObject({
    type: z.literal('RESTORE_NODES'),
    nodes: z.array(restoredNode),
    edges: z.array(restoredEdge).optional(),
    replace: ids.optional(),
    keepDataKeys: z.array(id).optional(),
  }),
} as const satisfies Record<CanvasCommandType, z.ZodType>;

/**
 * Why `command` is not a well-formed canvas command, or `null` when it is.
 * An unknown `type` is reported like the engine's preflight words it.
 */
export function canvasCommandShapeProblem(command: unknown): string | null {
  const type = (command as { type?: unknown } | null)?.type;
  if (
    typeof type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(COMMAND_SHAPES, type)
  )
    return 'Unsupported canvas command type';
  const parsed = COMMAND_SHAPES[type as CanvasCommandType].safeParse(command);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  return `Invalid ${type} command${where}: ${issue?.message ?? 'malformed'}`;
}
