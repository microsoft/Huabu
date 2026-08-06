// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Central command registry.
 *
 * Each command is defined in its own file with co-located handler + metadata.
 * This index gathers them into the HANDLERS and COMMAND_META maps consumed
 * by the executor.
 */

import alignNodes from './alignNodes.js';
import applyMeasuredHeight from './applyMeasuredHeight.js';
import changeNodeType from './changeNodeType.js';
import connectNodes from './connectNodes.js';
import createNodes from './createNodes.js';
import deleteNodes from './deleteNodes.js';
import disconnectEdges from './disconnectEdges.js';
import dissolveFrame from './dissolveFrame.js';
import distributeNodes from './distributeNodes.js';
import mergeNodeData from './mergeNodeData.js';
import reorderNodes from './reorderNodes.js';
import setEdgeStyle from './setEdgeStyle.js';
import setFrameLayout from './setFrameLayout.js';
import setNodeGeometry from './setNodeGeometry.js';
import setNodeLocked from './setNodeLocked.js';
import setNodeParent from './setNodeParent.js';
import setNodeSelection from './setNodeSelection.js';
import setPortalNodePins from './setPortalNodePins.js';

import type {
  CommandHandler,
  CommandHandlerResult,
  CommandMeta,
  CommandDefinition,
} from './types.js';
import type { CanvasCommand, CanvasCommandType } from '../../index.js';

// ---------------------------------------------------------------------------
// Handler registry (exhaustive over CanvasCommandType)
// ---------------------------------------------------------------------------

type HandlerMap = {
  [K in CanvasCommandType]: CommandHandler<Extract<CanvasCommand, { type: K }>>;
};

export const HANDLERS: HandlerMap = {
  CREATE_NODES: createNodes.handler,
  DELETE_NODES: deleteNodes.handler,
  MERGE_NODE_DATA: mergeNodeData.handler,
  SET_NODE_PARENT: setNodeParent.handler,
  DISSOLVE_FRAME: dissolveFrame.handler,
  SET_NODE_GEOMETRY: setNodeGeometry.handler,
  SET_NODE_SELECTION: setNodeSelection.handler,
  APPLY_MEASURED_HEIGHT: applyMeasuredHeight.handler,
  REORDER_NODES: reorderNodes.handler,
  SET_NODE_LOCKED: setNodeLocked.handler,
  CONNECT_NODES: connectNodes.handler,
  DISCONNECT_EDGES: disconnectEdges.handler,
  SET_EDGE_STYLE: setEdgeStyle.handler,
  ALIGN_NODES: alignNodes.handler,
  DISTRIBUTE_NODES: distributeNodes.handler,
  CHANGE_NODE_TYPE: changeNodeType.handler,
  SET_FRAME_LAYOUT: setFrameLayout.handler,
  SET_PORTAL_NODE_PINS: setPortalNodePins.handler,
};

// ---------------------------------------------------------------------------
// Metadata registry (exhaustive over CanvasCommandType)
// ---------------------------------------------------------------------------

export const COMMAND_META: Record<CanvasCommandType, CommandMeta> = {
  CREATE_NODES: createNodes.meta,
  DELETE_NODES: deleteNodes.meta,
  MERGE_NODE_DATA: mergeNodeData.meta,
  SET_NODE_PARENT: setNodeParent.meta,
  DISSOLVE_FRAME: dissolveFrame.meta,
  SET_NODE_GEOMETRY: setNodeGeometry.meta,
  SET_NODE_SELECTION: setNodeSelection.meta,
  APPLY_MEASURED_HEIGHT: applyMeasuredHeight.meta,
  REORDER_NODES: reorderNodes.meta,
  SET_NODE_LOCKED: setNodeLocked.meta,
  CONNECT_NODES: connectNodes.meta,
  DISCONNECT_EDGES: disconnectEdges.meta,
  SET_EDGE_STYLE: setEdgeStyle.meta,
  ALIGN_NODES: alignNodes.meta,
  DISTRIBUTE_NODES: distributeNodes.meta,
  CHANGE_NODE_TYPE: changeNodeType.meta,
  SET_FRAME_LAYOUT: setFrameLayout.meta,
  SET_PORTAL_NODE_PINS: setPortalNodePins.meta,
};

// Re-export types for consumers.
export type {
  CommandHandler,
  CommandHandlerResult,
  CommandMeta,
  CommandDefinition,
};
