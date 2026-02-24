/**
 * Deep Research - Type Definitions
 *
 * Types for the Deep Research feature that allows AI to autonomously
 * search, analyze, and organize findings into Canvas nodes.
 */

import type { PlacementStrategy } from './canvas.js';

// ==================== Request Types ====================

export interface ResearchConfig {
  /** Maximum number of sources to search (default: 5) */
  maxSources?: number;
  /** Search depth: basic (3 sources) or advanced (8+ sources) */
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
  /** Optional: selected source IDs for context */
  selectedSourceIds?: string[];
  /** Research configuration */
  config?: ResearchConfig;
}

// ==================== Event Types ====================

export type ResearchEventType =
  | 'thinking' // Query analysis and planning
  | 'searching' // Web search in progress
  | 'node_created' // Canvas node was created
  | 'ingesting' // Content ingestion in progress
  | 'synthesis' // AI synthesis/analysis
  | 'complete' // Research completed
  | 'error'; // Error occurred

export interface BaseResearchEvent {
  type: ResearchEventType;
  timestamp: number;
}

export interface ThinkingEvent extends BaseResearchEvent {
  type: 'thinking';
  data: {
    /** Current step description */
    step: string;
    /** Details about the thinking process */
    content: string;
  };
}

export interface SearchingEvent extends BaseResearchEvent {
  type: 'searching';
  data: {
    /** Search query */
    query: string;
    /** Number of results found */
    resultCount: number;
  };
}

export interface NodeCreatedEvent extends BaseResearchEvent {
  type: 'node_created';
  data: {
    nodeId: string;
    nodeType: 'text' | 'web' | 'note' | 'frame';
    position: { x: number; y: number };
    data: Record<string, unknown>;
  };
}

export interface IngestingEvent extends BaseResearchEvent {
  type: 'ingesting';
  data: {
    nodeId: string;
    sourceId: string;
    status: 'pending' | 'done' | 'error';
    error?: string;
  };
}

export interface SynthesisEvent extends BaseResearchEvent {
  type: 'synthesis';
  data: {
    /** AI-generated insight/analysis */
    content: string;
    /** Node ID containing the synthesis */
    nodeId: string;
    /** Related source node IDs */
    relatedNodeIds: string[];
  };
}

export interface CompleteEvent extends BaseResearchEvent {
  type: 'complete';
  data: {
    /** Frame ID wrapping all research nodes (if created) */
    frameId?: string;
    /** New canvas version after all updates */
    canvasVersion: number;
    /** Total nodes created */
    nodeCount: number;
    /** Research duration in milliseconds */
    duration: number;
  };
}

export interface ErrorEvent extends BaseResearchEvent {
  type: 'error';
  data: {
    /** User-facing error message */
    message: string;
    /** Step where error occurred */
    step?: string;
    /** Whether research can continue */
    recoverable: boolean;
  };
}

export type ResearchEvent =
  | ThinkingEvent
  | SearchingEvent
  | NodeCreatedEvent
  | IngestingEvent
  | SynthesisEvent
  | CompleteEvent
  | ErrorEvent;

// ==================== Response Types ====================

export interface ResearchStreamEvent {
  event: 'update' | 'end' | 'error';
  data: ResearchEvent | { message: string };
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
