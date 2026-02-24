/**
 * Canvas API types for server-client communication
 */

/**
 * Supported knowledge storage backends.
 */
export type KnowledgeStorageBackend = 'sqlite' | 'obsidian';

/**
 * User-configurable knowledge storage settings.
 * Persisted inside the canvas state so it can be changed from the frontend.
 */
export interface KnowledgeStorageConfig {
  backend: KnowledgeStorageBackend;
  /** Required when backend is 'obsidian'. Absolute path to the Obsidian vault folder. */
  obsidianVaultPath?: string;
}

export interface GetCanvasResponse {
  canvasId: string;
  version: number;
  state: unknown;
}

export interface PutCanvasRequest {
  version: number;
  state: unknown;
  workspaceId?: string;
  title?: string;
}

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
}

export interface CanvasVersionMismatchError {
  message: string;
  serverVersion: number;
}

/**
 * Node API types for individual node operations
 */

export interface UpsertNodeRequest {
  workspaceId?: string;
  type: 'note' | 'text' | 'web' | 'pdf';
  title?: string;
  content?: string;
  src?: string;
  /**
   * Existing source ID from a previous ingestion.
   * When provided the server will update the existing source
   * instead of creating a new one.
   */
  sourceId?: string;
}

export interface UpsertNodeResponse {
  nodeId: string;
  sourceId: string;
  success: boolean;
  /**
   * The storage backend where this source was persisted.
   * Stored on the node so the client can detect cross-backend mismatches.
   */
  sourceBackend?: KnowledgeStorageBackend;
  /**
   * Optional server-suggested label derived from ingested content (e.g. web page title, PDF title).
   * The client may choose to apply it only when the current label is empty or still a placeholder.
   */
  suggestedLabel?: string;
  error?: string;
}

export interface DeleteNodeResponse {
  success: boolean;
}

/**
 * Storage migration API types
 */

export interface MigrateStorageRequest {
  to: KnowledgeStorageConfig;
}

export interface MigrateStorageNodeResult {
  nodeId: string;
  sourceId: string;
  status: 'migrated' | 'skipped' | 'failed';
  error?: string;
}

export interface MigrateStorageResponse {
  success: boolean;
  totalNodes: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  results: MigrateStorageNodeResult[];
  version: number;
}

/**
 * Canvas Operations - Additional Types for Deep Research
 */

// ==================== Basic Types ====================

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ==================== Node Origin & Metadata ====================

export type NodeOrigin = 'user' | 'research' | 'chat';

export interface NodeResearchData {
  /** Original research query */
  query: string;
  /** Research session ID (for grouping) */
  sessionId?: string;
  /** Related node IDs (for auto-connecting) */
  relatedNodeIds?: string[];
}

export interface NodeMetadata {
  /** Node origin/source */
  origin?: NodeOrigin;
  /** Research-related data (only when origin === 'research') */
  research?: NodeResearchData;
}

export interface FrameMetadata extends NodeMetadata {
  /** Whether the frame is locked (prevents auto-resize) */
  locked?: boolean;
}

// ==================== Canvas Operation Params ====================

export interface CreateNodeParams {
  canvasId: string;
  type: 'note' | 'text' | 'image' | 'pdf' | 'video' | 'web' | 'frame';
  position: Point;
  data: Record<string, unknown>;
  /** Optional: explicit width/height */
  size?: { width: number; height: number };
}

export interface CreateFrameParams {
  canvasId: string;
  label: string;
  position: Point;
  /** Node IDs to wrap in this frame */
  childNodeIds: string[];
  /** Optional frame data (researchGenerated, etc.) */
  data?: Record<string, unknown>;
  /** Optional: explicit size (otherwise auto-calculated) */
  size?: { width: number; height: number };
}

export interface EdgeStyle {
  stroke?: string;
  strokeWidth?: number;
  animated?: boolean;
}

export interface CreateEdgeParams {
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  style?: EdgeStyle;
}

// ==================== Layout Types ====================

export type LayoutStrategy = 'hierarchical' | 'radial' | 'force-directed';

export interface LayoutConfig {
  strategy: LayoutStrategy;
  spacing: { x: number; y: number };
}

export type PlacementStrategy = 'right' | 'bottom' | 'empty-space' | 'auto';

export interface CalculateLayoutParams {
  canvasId: string;
  /** Existing canvas bounds */
  existingBounds?: Bounds;
  /** Placement strategy */
  placementStrategy: PlacementStrategy;
  /** Number of new nodes to place */
  nodeCount: number;
  /** Padding from existing content */
  padding?: number;
}

export interface LayoutResult {
  /** Starting position for the first node */
  startPosition: Point;
  /** Suggested positions for all nodes (if layout is pre-calculated) */
  positions?: Point[];
}

// ==================== Canvas Operation Results ====================

export interface CreateNodeResult {
  nodeId: string;
}

export interface CreateFrameResult {
  frameId: string;
}

export interface CreateEdgeResult {
  edgeId: string;
}

export interface UpdateCanvasStateParams {
  canvasId: string;
  version: number;
  nodes: unknown[]; // ReactFlow Node type
  edges: unknown[]; // ReactFlow Edge type
}

export interface UpdateCanvasStateResult {
  newVersion: number;
}
