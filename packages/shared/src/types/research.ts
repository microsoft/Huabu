/**
 * Deep Research - Type Definitions
 *
 * Types for the Deep Research feature that allows AI to autonomously
 * search, analyze, and organize findings into Canvas nodes.
 */

import type { PlacementStrategy } from './canvas.js';
import type { ToolResponse } from './chat.js';

// ==================== Request Types ====================

export interface ResearchConfig {
  /** Search depth: basic (3-5 sources) or advanced (8-10 sources, default) */
  searchDepth?: 'basic' | 'advanced';
  /** Where to place new research nodes */
  placement?: PlacementStrategy;
  /** Whether to wrap research nodes in a Frame (default: true) */
  groupWithFrame?: boolean;
  /** Auto-connect to related existing nodes (experimental, default: false) */
  autoConnect?: boolean;
  /** Spacing between existing content and research nodes (default: 200px) */
  padding?: number;
}

export interface ResearchRequest {
  /** The research query/question */
  query: string;
  /** Canvas ID to add nodes to */
  canvasId: string;
  /** Current canvas version (for optimistic locking) */
  canvasVersion: number;
  /** Chat thread ID - research will share the same checkpoint */
  threadId: string;
  /** Optional: selected source IDs for context */
  selectedSourceIds?: string[];
  /** Research configuration */
  config?: ResearchConfig;
}

// ==================== Event Types ====================

/**
 * Unified research event — mirrors the backend AgentEvent structure.
 * All research progress is carried as `update` events with `data.toolResponse`
 * identifying the step type. This matches the chat agent's event format exactly.
 */
export interface ResearchAgentEvent {
  type: 'update' | 'complete' | 'error';
  timestamp: number;
  data: {
    /** Graph node that produced this event */
    node?: string;
    /** Text message (token delta for synthesis, summary for other nodes) */
    message?: { role: string; content: string };
    /**
     * Structured step output. `tool` field identifies the step:
     *   research_query_analysis | research_multi_search |
     *   research_ingestion | research_canvas_organization
     */
    toolResponse?: ToolResponse<string, unknown>;
    /** Metadata for complete / error events */
    meta?: Record<string, unknown>;
  };
}

/** @deprecated Use ResearchAgentEvent */
export type ResearchEvent = ResearchAgentEvent;

// ==================== Response Types ====================

export interface ResearchHistoryResponse {
  threadId: string;
  query: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  steps: ResearchStep[];
  createdNodeIds: string[];
  frameId?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
}

// ==================== Internal State Types ====================

export interface SearchResult {
  query: string;
  nodeId: string;
  sourceId?: string;
  url: string;
  title: string;
  content?: string;
}

export interface ResearchStep {
  id: string;
  type: 'thinking' | 'searching' | 'ingesting' | 'synthesizing';
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  nodeIds?: string[];
  timestamp: number;
}

// ==================== Tool Response Types (for unified message display) ====================

/**
 * Research steps are now represented as tool responses for unified display.
 * This allows all agent intermediate steps to be shown consistently with ToolMessage component.
 */

export type ResearchThinkingToolResponse = ToolResponse<
  'research_thinking',
  {
    step: string;
    content: string;
  }
>;

export type ResearchSearchingToolResponse = ToolResponse<
  'research_searching',
  {
    query: string;
    resultCount: number;
  }
>;

export type ResearchNodeCreatedToolResponse = ToolResponse<
  'research_node_created',
  {
    nodeIds: string[];
    nodeCount: number;
  }
>;

export type ResearchSynthesisToolResponse = ToolResponse<
  'research_synthesis',
  {
    content: string;
    nodeId: string;
    relatedNodeIds: string[];
  }
>;

export type ResearchFrameCreatedToolResponse = ToolResponse<
  'research_frame_created',
  {
    frameId: string;
    label: string;
  }
>;

/** Union type for all research tool responses */
export type ResearchToolResponse =
  | ResearchThinkingToolResponse
  | ResearchSearchingToolResponse
  | ResearchNodeCreatedToolResponse
  | ResearchSynthesisToolResponse
  | ResearchFrameCreatedToolResponse;
