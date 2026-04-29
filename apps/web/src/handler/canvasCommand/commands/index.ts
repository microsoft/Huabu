/**
 * Central command registry.
 *
 * Each command is defined in its own file with co-located handler + metadata.
 * This index gathers them into the HANDLERS and COMMAND_META maps consumed
 * by the executor.
 */

import alignNodes from './alignNodes';
import autoLayout from './autoLayout';
import changeNodeType from './changeNodeType';
import connectNodes from './connectNodes';
import createNodes from './createNodes';
import createQuestion from './createQuestion';
import deleteNodes from './deleteNodes';
import disconnectEdges from './disconnectEdges';
import dissolveFrame from './dissolveFrame';
import distributeNodes from './distributeNodes';
import mergeNodeData from './mergeNodeData';
import reorderNodes from './reorderNodes';
import setEdgeStyle from './setEdgeStyle';
import setExpandedNode from './setExpandedNode';
import setNodeGeometry from './setNodeGeometry';
import setNodeLocked from './setNodeLocked';
import setNodeParent from './setNodeParent';
import setNodeSelection from './setNodeSelection';

import type {
  CommandHandler,
  CommandHandlerResult,
  CommandMeta,
} from './types';
import type { CanvasCommand, CanvasCommandType } from '@sediment/shared';

// ---------------------------------------------------------------------------
// Handler registry (excludes SET_EXPANDED_NODE — handled inline by executor)
// ---------------------------------------------------------------------------

type HandlerMap = {
  [K in Exclude<CanvasCommandType, 'SET_EXPANDED_NODE'>]: CommandHandler<
    Extract<CanvasCommand, { type: K }>
  >;
};

export const HANDLERS: HandlerMap = {
  CREATE_NODES: createNodes.handler,
  CREATE_QUESTION: createQuestion.handler,
  DELETE_NODES: deleteNodes.handler,
  MERGE_NODE_DATA: mergeNodeData.handler,
  SET_NODE_PARENT: setNodeParent.handler,
  DISSOLVE_FRAME: dissolveFrame.handler,
  SET_NODE_GEOMETRY: setNodeGeometry.handler,
  SET_NODE_SELECTION: setNodeSelection.handler,
  REORDER_NODES: reorderNodes.handler,
  SET_NODE_LOCKED: setNodeLocked.handler,
  CONNECT_NODES: connectNodes.handler,
  DISCONNECT_EDGES: disconnectEdges.handler,
  SET_EDGE_STYLE: setEdgeStyle.handler,
  ALIGN_NODES: alignNodes.handler,
  DISTRIBUTE_NODES: distributeNodes.handler,
  AUTO_LAYOUT: autoLayout.handler,
  CHANGE_NODE_TYPE: changeNodeType.handler,
};

// ---------------------------------------------------------------------------
// Metadata registry (all commands including SET_EXPANDED_NODE)
// ---------------------------------------------------------------------------

export const COMMAND_META: Record<CanvasCommandType, CommandMeta> = {
  CREATE_NODES: createNodes.meta,
  CREATE_QUESTION: createQuestion.meta,
  DELETE_NODES: deleteNodes.meta,
  MERGE_NODE_DATA: mergeNodeData.meta,
  SET_NODE_PARENT: setNodeParent.meta,
  DISSOLVE_FRAME: dissolveFrame.meta,
  SET_NODE_GEOMETRY: setNodeGeometry.meta,
  SET_NODE_SELECTION: setNodeSelection.meta,
  SET_EXPANDED_NODE: setExpandedNode.meta,
  REORDER_NODES: reorderNodes.meta,
  SET_NODE_LOCKED: setNodeLocked.meta,
  CONNECT_NODES: connectNodes.meta,
  DISCONNECT_EDGES: disconnectEdges.meta,
  SET_EDGE_STYLE: setEdgeStyle.meta,
  ALIGN_NODES: alignNodes.meta,
  DISTRIBUTE_NODES: distributeNodes.meta,
  AUTO_LAYOUT: autoLayout.meta,
  CHANGE_NODE_TYPE: changeNodeType.meta,
};

// Re-export types for consumers.
export type { CommandHandler, CommandHandlerResult, CommandMeta };
