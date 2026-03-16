/**
 * @file executor.ts
 *
 * Executes a sequence of IntentAction atomic operations against the canvas store.
 * Each action maps to a CanvasCommand dispatch or store method.
 *
 * Supports a tempId placeholder system: ADD_NODE can set tempId (e.g. "$new1")
 * and later actions can reference that tempId as a nodeId — the executor resolves
 * it to the real runtime ID.
 */

import { createId } from '@sediment/shared';

import useCanvasStore from '../../store/canvasStore';
import { buildNode } from '../node/factory';

import type { IntentAction } from '@sediment/shared';

/**
 * Resolve a node ID through the tempId map.
 * If the ID starts with '$' and exists in the map, return the real ID.
 * Otherwise return the ID as-is (it's a real canvas node ID).
 */
function resolveId(id: string, idMap: Map<string, string>): string {
  return idMap.get(id) ?? id;
}

/** Resolve an array of node IDs through the tempId map. */
function resolveIds(ids: string[], idMap: Map<string, string>): string[] {
  return ids.map((id) => resolveId(id, idMap));
}

/**
 * Execute an ordered sequence of intent actions.
 * Each ADD_NODE is automatically assigned a sequential placeholder ID
 * ($0, $1, $2, ...) so later actions can reference newly created nodes.
 */
export function executeIntentActions(actions: IntentAction[]): void {
  // Maps $0, $1, $2... to real node IDs created by ADD_NODE ops.
  const idMap = new Map<string, string>();
  let addNodeIndex = 0;

  console.log(`[IntentExecutor] Starting ${actions.length} action(s)`);

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    // Re-read store state before each action so we always see the
    // latest nodes/edges after previous mutations in the sequence.
    const store = useCanvasStore.getState();

    console.log(
      `[IntentExecutor] Step ${i + 1}/${actions.length}: ${action.op}`,
      action,
    );

    try {
      switch (action.op) {
        case 'ADD_NODE': {
          // Determine position: use provided, or center viewport with stacking offset
          let position = action.position ?? { x: 0, y: 0 };
          if (!action.position) {
            const rfInstance = store.rfInstance;
            if (rfInstance) {
              const container = document.querySelector('.react-flow');
              const cw = container?.clientWidth ?? window.innerWidth;
              const ch = container?.clientHeight ?? window.innerHeight;
              position = rfInstance.screenToFlowPosition({
                x: cw / 2,
                y: ch / 2,
              });
              // Offset each ADD_NODE to avoid stacking
              position.x += addNodeIndex * 30;
              position.y += addNodeIndex * 30;
            }
          }

          const data: Record<string, unknown> = {
            origin: { type: 'chat' as const },
          };
          if (action.label) data.label = action.label;
          if (action.content) data.content = action.content;
          if (action.src) data.src = action.src;

          // Use buildNode for consistent sizing, centering, and data.type injection
          const nodeId = createId('node');
          const node = buildNode({
            id: nodeId,
            type: action.nodeType,
            position,
            data,
            ...(action.width && action.height
              ? { size: { width: action.width, height: action.height } }
              : {}),
          });

          store.addNode(node);

          // Auto-track: $0 = 1st ADD_NODE, $1 = 2nd, etc.
          idMap.set(`$${addNodeIndex}`, nodeId);
          addNodeIndex++;
          break;
        }

        case 'DELETE_NODES': {
          const ids = resolveIds(action.nodeIds, idMap);
          if (ids.length > 0) {
            store.dispatch({ type: 'DELETE_NODES', nodeIds: ids });
          }
          break;
        }

        case 'CONNECT': {
          store.dispatch({
            type: 'CONNECT',
            connection: {
              source: resolveId(action.sourceId, idMap),
              target: resolveId(action.targetId, idMap),
              sourceHandle: 'bottom-source',
              targetHandle: 'top-target',
            },
          });
          break;
        }

        case 'DISCONNECT': {
          const srcId = resolveId(action.sourceId, idMap);
          const tgtId = resolveId(action.targetId, idMap);
          const edges = useCanvasStore.getState().edges;
          const matching = edges.filter(
            (e) => e.source === srcId && e.target === tgtId,
          );
          if (matching.length > 0) {
            store.dispatch({
              type: 'DISCONNECT_EDGES',
              edgeIds: matching.map((e) => e.id),
            });
          }
          break;
        }

        case 'UPDATE_NODE_DATA': {
          store.updateNodeData(resolveId(action.nodeId, idMap), action.patch);
          break;
        }

        case 'GROUP_INTO_FRAME': {
          const ids = resolveIds(action.nodeIds, idMap);
          if (ids.length > 0) {
            store.selectNodes(ids);
            store.frameSelectedNodes();
          }
          break;
        }

        case 'UNFRAME': {
          store.unframe(resolveId(action.frameId, idMap));
          break;
        }

        case 'MOVE_INTO_FRAME': {
          store.moveNodeIntoFrame(
            resolveId(action.nodeId, idMap),
            resolveId(action.frameId, idMap),
          );
          break;
        }

        case 'MOVE_OUT_OF_FRAME': {
          store.moveNodeOutOfFrame(resolveId(action.nodeId, idMap));
          break;
        }

        case 'SELECT_NODES': {
          store.selectNodes(resolveIds(action.nodeIds, idMap));
          break;
        }

        case 'ALIGN_NODES': {
          store.alignSelectedNodes(action.direction);
          break;
        }

        case 'SPREAD_NODES': {
          store.spreadSelectedNodes();
          break;
        }
      }

      console.log(`[IntentExecutor] Step ${i + 1} completed OK`);
    } catch (err) {
      console.error(
        `[IntentExecutor] Step ${i + 1}/${actions.length} FAILED (${action.op}):`,
        err,
      );
    }
  }

  console.log(`[IntentExecutor] Done. idMap:`, Object.fromEntries(idMap));
}
