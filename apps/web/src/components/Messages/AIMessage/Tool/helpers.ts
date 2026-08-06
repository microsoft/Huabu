// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared helpers for tool-call renderers under `Messages/AIMessage/Tool/`.
 *
 * Extracted from the legacy `ToolMessage.tsx` so each renderer file
 * (`SpaceCommandCard`, `MergedAgentToolRow`, `WebSearchToolDisplay`)
 * can stay focused on its own view logic.
 */

import type { AssistantToolPart } from '@huabu/shared';

/**
 * Display-only description of a single canvas mutation, reconstructed from a
 * `space_commands` tool result for the SpaceCommandCard. Revert is owned by
 * the broadcast-fed ChangeReviewCard, so these carry no inverse commands.
 */
export interface CanvasChange {
  id: string;
  tool: string;
  label: string;
  nodeType?: string;
  nodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  /** Snapshot labels captured at extraction time (stable across preview swaps). */
  nodeLabel?: string;
  sourceNodeLabel?: string;
  targetNodeLabel?: string;
  targetFrameId?: string;
  edgeId?: string;
  operation?: 'aligned' | 'distributed' | 'reordered' | 'edgeStyle';
  count?: number;
  detail?: string;
  frameLayout?: {
    mode: string;
    gridCount?: number;
    sizing?: string;
  };
  revertible: boolean;
}

/** Truncate a string to a max length with ellipsis. */
export const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + '…' : s;

export function partIsExecuting(part: AssistantToolPart): boolean {
  return part.status === 'pending' || part.status === 'in_progress';
}

/** A single tool part plus the owning assistant message id (used for updates). */
export interface ToolPart<P extends AssistantToolPart = AssistantToolPart> {
  /** The owning assistant message id. */
  messageId: string;
  /** The actual ACP tool part data. */
  part: P;
}

/**
 * Reconstruct display-only CanvasChange entries from raw commands.
 * Used after refresh when canvasChanges weren't persisted.
 * All entries are non-revertible.
 */
export function reconstructChangesFromCommands(
  commands: Array<Record<string, unknown>>,
): CanvasChange[] {
  const changes: CanvasChange[] = [];
  let counter = 0;

  for (const cmd of commands) {
    const type = cmd.type as string;
    switch (type) {
      case 'CREATE_NODES': {
        const nodes = (cmd.nodes ?? []) as Array<Record<string, unknown>>;
        for (const node of nodes) {
          const label = (node.data as Record<string, unknown> | undefined)
            ?.label as string | undefined;
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: `Created: ${truncate(label ?? 'untitled', 24)}`,
            nodeType: (node.nodeType as string) ?? 'note',
            nodeId: node.id as string,
            nodeLabel: truncate(label ?? 'untitled', 24),
            revertible: false,
          });
        }
        break;
      }
      case 'DELETE_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        for (const nodeId of nodeIds) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: `Deleted: ${truncate(nodeId, 24)}`,
            nodeId,
            revertible: false,
          });
        }
        break;
      }
      case 'MERGE_NODE_DATA': {
        const patches = (cmd.patches ?? []) as Array<Record<string, unknown>>;
        for (const patch of patches) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: `Updated: ${truncate((patch.nodeId as string) ?? '?', 24)}`,
            nodeId: patch.nodeId as string,
            revertible: false,
          });
        }
        break;
      }
      case 'CONNECT_NODES': {
        const edges = (cmd.edges ?? []) as Array<Record<string, unknown>>;
        for (const edge of edges) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: 'Connected',
            sourceNodeId: edge.source as string,
            targetNodeId: edge.target as string,
            revertible: false,
          });
        }
        break;
      }
      case 'DISCONNECT_EDGES': {
        const edges = (cmd.edges ?? []) as Array<
          string | Record<string, unknown>
        >;
        for (const edge of edges) {
          const source =
            typeof edge === 'string' ? undefined : (edge.source as string);
          const target =
            typeof edge === 'string' ? undefined : (edge.target as string);
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: 'Disconnected',
            sourceNodeId: source,
            targetNodeId: target,
            edgeId: typeof edge === 'string' ? edge : undefined,
            revertible: false,
          });
        }
        break;
      }
      case 'SET_NODE_PARENT': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        const parentId = cmd.parentId as string | null;
        const verb = parentId ? 'Moved into frame' : 'Moved out of frame';
        for (const nodeId of nodeIds) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: `${verb}: ${truncate(nodeId, 24)}`,
            nodeId,
            targetFrameId: parentId ?? undefined,
            revertible: false,
          });
        }
        break;
      }
      case 'DISSOLVE_FRAME': {
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Dissolved frame',
          nodeType: 'frame',
          nodeId: cmd.frameId as string,
          revertible: false,
        });
        break;
      }
      case 'SET_FRAME_LAYOUT': {
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Set frame layout',
          nodeType: 'frame',
          nodeId: cmd.frameId as string,
          frameLayout: {
            mode: (cmd.mode as string) || 'free',
            gridCount:
              typeof cmd.gridCount === 'number' ? cmd.gridCount : undefined,
            sizing: typeof cmd.sizing === 'string' ? cmd.sizing : undefined,
          },
          revertible: false,
        });
        break;
      }
      case 'SET_NODE_GEOMETRY': {
        const items = (cmd.items ?? []) as Array<Record<string, unknown>>;
        for (const item of items) {
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: `Repositioned: ${truncate((item.nodeId as string) ?? '?', 24)}`,
            nodeId: item.nodeId as string,
            revertible: false,
          });
        }
        break;
      }
      case 'SET_PORTAL_NODE_PINS': {
        const updates = (cmd.updates ?? []) as Array<Record<string, unknown>>;
        for (const update of updates) {
          const sourceNodeIds = (update.sourceNodeIds ?? []) as string[];
          const pinned = update.pinned === true;
          changes.push({
            id: `hist-${counter++}`,
            tool: 'space_commands',
            label: pinned ? 'Pinned to World' : 'Unpinned from World',
            count: sourceNodeIds.length,
            detail: update.sourceCanvasId as string,
            revertible: false,
          });
        }
        break;
      }
      case 'ALIGN_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Aligned nodes',
          operation: 'aligned',
          count: nodeIds.length,
          detail: typeof cmd.direction === 'string' ? cmd.direction : undefined,
          revertible: false,
        });
        break;
      }
      case 'DISTRIBUTE_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Distributed nodes',
          operation: 'distributed',
          count: nodeIds.length,
          revertible: false,
        });
        break;
      }
      case 'REORDER_NODES': {
        const nodeIds = (cmd.nodeIds ?? []) as string[];
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Reordered nodes',
          operation: 'reordered',
          count: nodeIds.length,
          detail:
            typeof cmd.to === 'string'
              ? cmd.to
              : cmd.to && typeof cmd.to === 'object'
                ? Object.keys(cmd.to as Record<string, unknown>)[0]
                : undefined,
          revertible: false,
        });
        break;
      }
      case 'SET_EDGE_STYLE': {
        const edges = (cmd.edges ?? []) as Array<Record<string, unknown>>;
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: 'Updated connection style',
          operation: 'edgeStyle',
          count: edges.length,
          revertible: false,
        });
        break;
      }
      default:
        changes.push({
          id: `hist-${counter++}`,
          tool: 'space_commands',
          label: type || 'Unknown command',
          revertible: false,
        });
        break;
    }
  }

  return changes;
}
