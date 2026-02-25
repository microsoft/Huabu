/**
 * Canvas Operation Service
 *
 * High-level service for programmatic canvas manipulation.
 * Used by the research graph to create nodes, frames, and edges.
 */

import { createId } from '@sediment/shared';

import { getCanvasDb } from './canvas.db.js';
import { calculateLayout } from './layout/layout.service.js';

import type {
  Bounds,
  CreateNodeParams,
  CreateNodeResult,
  CreateFrameParams,
  CreateEdgeParams,
  CreateEdgeResult,
  UpdateCanvasStateParams,
  UpdateCanvasStateResult,
  CalculateLayoutParams,
  LayoutResult,
} from '@sediment/shared';

/**
 * Canvas Operation Service
 *
 * High-level service for programmatic canvas manipulation.
 * Used by the research graph to create nodes, frames, and edges.
 */
export class CanvasOperationService {
  /**
   * Load current canvas state from database
   */
  private async loadCanvasState(canvasId: string): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    version: number;
  }> {
    const db = getCanvasDb();
    const row = db
      .prepare('SELECT stateJson, version FROM canvases WHERE canvasId = ?')
      .get(canvasId) as { stateJson: string; version: number } | undefined;

    if (!row) {
      // Canvas doesn't exist, return empty state
      return { nodes: [], edges: [], version: 0 };
    }

    try {
      const state = JSON.parse(row.stateJson) as {
        nodes?: Array<Record<string, unknown>>;
        edges?: Array<Record<string, unknown>>;
      };
      return {
        nodes: state.nodes ?? [],
        edges: state.edges ?? [],
        version: row.version,
      };
    } catch (err) {
      console.error('[loadCanvasState] Parse error:', err);
      return { nodes: [], edges: [], version: row.version };
    }
  }

  /**
   * Save canvas state to database
   */
  private async saveCanvasState(
    canvasId: string,
    nodes: Array<Record<string, unknown>>,
    edges: Array<Record<string, unknown>>,
    currentVersion: number,
  ): Promise<number> {
    const db = getCanvasDb();
    const nextVersion = currentVersion + 1;
    const stateJson = JSON.stringify({ nodes, edges });
    const timestamp = Date.now();

    // Check if canvas exists
    const existing = db
      .prepare('SELECT canvasId FROM canvases WHERE canvasId = ?')
      .get(canvasId);

    if (!existing) {
      // Insert new canvas
      db.prepare(
        `INSERT INTO canvases (
          canvasId, workspaceId, title, version, stateJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        canvasId,
        'default',
        null,
        nextVersion,
        stateJson,
        timestamp,
        timestamp,
      );
    } else {
      // Update existing canvas
      db.prepare(
        `UPDATE canvases
         SET stateJson = ?,
             version = ?,
             updatedAt = ?
         WHERE canvasId = ?`,
      ).run(stateJson, nextVersion, timestamp, canvasId);
    }

    return nextVersion;
  }

  /**
   * Create a new node on the canvas
   */
  async createNode(params: CreateNodeParams): Promise<CreateNodeResult> {
    const { canvasId, position, data, size } = params;

    const nodeId = createId('node');

    // Load current state
    const state = await this.loadCanvasState(canvasId);

    // Create node object (ReactFlow format)
    const newNode = {
      id: nodeId,
      type: data.type,
      position,
      data,
      width: size?.width,
      height: size?.height,
      selected: false,
    };

    // Add to nodes array
    state.nodes.push(newNode);

    // Save back to database
    await this.saveCanvasState(
      canvasId,
      state.nodes,
      state.edges,
      state.version,
    );

    console.log('[CanvasOperationService.createNode] Created node:', {
      nodeId,
      canvasId,
      type: data.type,
      position,
    });

    return { nodeId };
  }

  /**
   * Create a frame to group nodes
   */
  async createFrame(params: CreateFrameParams): Promise<CreateNodeResult> {
    const { canvasId, label, childNodeIds, position, data, size } = params;

    const frameId = createId('frame');

    // Load current state
    const state = await this.loadCanvasState(canvasId);

    // Calculate frame size if not provided
    let frameWidth = size?.width ?? 800;
    let frameHeight = size?.height ?? 600;
    let frameX = position?.x ?? 0;
    let frameY = position?.y ?? 0;

    // If we have child nodes, calculate bounds
    if (childNodeIds.length > 0 && !size) {
      const childNodes = state.nodes.filter((n) =>
        childNodeIds.includes(n.id as string),
      );

      if (childNodes.length > 0) {
        const positions = childNodes.map((n) => ({
          x: (n.position as { x: number; y: number }).x,
          y: (n.position as { x: number; y: number }).y,
          width: (n.width as number) ?? 200,
          height: (n.height as number) ?? 150,
        }));

        const minX = Math.min(...positions.map((p) => p.x));
        const minY = Math.min(...positions.map((p) => p.y));
        const maxX = Math.max(...positions.map((p) => p.x + p.width));
        const maxY = Math.max(...positions.map((p) => p.y + p.height));

        frameX = minX - 50;
        frameY = minY - 80; // Extra space for label
        frameWidth = maxX - minX + 100;
        frameHeight = maxY - minY + 130;
      }
    }

    // Create frame node
    const newFrame = {
      id: frameId,
      type: 'frame',
      position: { x: frameX, y: frameY },
      data: {
        label,
        ...data,
      },
      width: frameWidth,
      height: frameHeight,
      selected: false,
      style: {
        width: frameWidth,
        height: frameHeight,
      },
    };

    // IMPORTANT: Parent nodes must come before child nodes in ReactFlow
    // 1. Find the index of the first child node
    let firstChildIndex = -1;
    for (let i = 0; i < state.nodes.length; i++) {
      if (childNodeIds.includes(state.nodes[i].id as string)) {
        firstChildIndex = i;
        break;
      }
    }

    // 2. Insert frame before the first child node
    if (firstChildIndex >= 0) {
      state.nodes.splice(firstChildIndex, 0, newFrame);
    } else {
      // No child nodes found, just add frame at the end
      state.nodes.push(newFrame);
    }

    // 3. Update child nodes to reference this frame as parent
    state.nodes = state.nodes.map((node) => {
      if (childNodeIds.includes(node.id as string)) {
        return {
          ...node,
          parentId: frameId,
          extent: 'parent',
        };
      }
      return node;
    });

    // Save back to database
    await this.saveCanvasState(
      canvasId,
      state.nodes,
      state.edges,
      state.version,
    );

    console.log('[CanvasOperationService.createFrame] Created frame:', {
      frameId,
      canvasId,
      label,
      childNodeIds,
    });

    return { nodeId: frameId };
  }

  /**
   * Create an edge between nodes
   */
  async createEdge(params: CreateEdgeParams): Promise<CreateEdgeResult> {
    const { canvasId, sourceNodeId, targetNodeId, label, style } = params;

    const edgeId = createId('edge');

    // Load current state
    const state = await this.loadCanvasState(canvasId);

    // Create edge object
    const newEdge = {
      id: edgeId,
      source: sourceNodeId,
      target: targetNodeId,
      label,
      type: 'smoothstep',
      animated: style?.animated ?? false,
      style: style
        ? {
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
          }
        : undefined,
    };

    // Add to edges array
    state.edges.push(newEdge);

    // Save back to database
    await this.saveCanvasState(
      canvasId,
      state.nodes,
      state.edges,
      state.version,
    );

    console.log('[CanvasOperationService.createEdge] Created edge:', {
      edgeId,
      canvasId,
      sourceNodeId,
      targetNodeId,
    });

    return { edgeId };
  }

  /**
   * Calculate layout for new nodes
   */
  async calculateLayout(params: CalculateLayoutParams): Promise<LayoutResult> {
    // Get existing canvas state to calculate bounds
    const db = getCanvasDb();
    const row = db
      .prepare('SELECT stateJson FROM canvases WHERE canvasId = ?')
      .get(params.canvasId) as { stateJson: string } | undefined;

    let existingBounds: Bounds | null = null;

    if (row) {
      try {
        const state = JSON.parse(row.stateJson) as { nodes?: unknown[] };
        if (Array.isArray(state.nodes) && state.nodes.length > 0) {
          // TODO: calculateCanvasBounds with proper types
          existingBounds = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
        }
      } catch (err) {
        console.error(
          '[CanvasOperationService.calculateLayout] Parse error:',
          err,
        );
      }
    }

    const layoutParams: CalculateLayoutParams = {
      ...params,
      existingBounds: existingBounds ?? undefined,
    };

    return calculateLayout(layoutParams);
  }

  /**
   * Update node data (e.g., add sourceId after ingestion)
   */
  async updateNodeData(
    canvasId: string,
    nodeId: string,
    dataUpdate: Record<string, unknown>,
  ): Promise<void> {
    // Load current state
    const state = await this.loadCanvasState(canvasId);

    // Find the node
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      console.warn(
        `[updateNodeData] Node ${nodeId} not found in canvas ${canvasId}`,
      );
      return;
    }

    // Update node data
    node.data = {
      ...(node.data as Record<string, unknown> | undefined),
      ...dataUpdate,
    };

    // Save back to database
    await this.saveCanvasState(
      canvasId,
      state.nodes,
      state.edges,
      state.version,
    );

    console.log(
      '[updateNodeData] Updated node:',
      nodeId,
      'with data:',
      dataUpdate,
    );
  }

  /**
   * Batch update canvas state
   */
  async updateCanvasState(
    params: UpdateCanvasStateParams,
  ): Promise<UpdateCanvasStateResult> {
    const { canvasId, version, nodes, edges } = params;

    // TODO: Implement full canvas state update
    // 1. Check version (optimistic locking)
    // 2. Update state_json
    // 3. Increment version
    // 4. Return new version

    const newVersion = version + 1;

    console.log('[CanvasOperationService.updateCanvasState]', {
      canvasId,
      oldVersion: version,
      newVersion,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    });

    return { newVersion };
  }
}

// Singleton instance
let serviceInstance: CanvasOperationService | null = null;

/**
 * Get the Canvas Operation Service singleton
 */
export function getCanvasOperationService(): CanvasOperationService {
  if (!serviceInstance) {
    serviceInstance = new CanvasOperationService();
  }
  return serviceInstance;
}
