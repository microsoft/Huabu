/**
 * Research Graph State
 *
 * LangGraph state definition for the deep research workflow.
 */

import { Annotation } from '@langchain/langgraph';

import type { BaseMessage } from '@langchain/core/messages';
import type { ResearchConfig, SearchResult } from '@sediment/shared';

/**
 * Research State
 *
 * Tracks all state throughout the research graph execution.
 */
export const ResearchState = Annotation.Root({
  // ==================== Input ====================

  /** The research query/question */
  query: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),

  /** Canvas ID to add nodes to */
  canvasId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),

  /** Thread ID (for checkpoint and grouping nodes) */
  threadId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),

  /** Current canvas version (for optimistic locking) */
  canvasVersion: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),

  /** Optional: selected source IDs for context */
  selectedSourceIds: Annotation<string[]>({
    reducer: (x, y) => y ?? x ?? [],
  }),

  /** Research configuration */
  config: Annotation<ResearchConfig>({
    reducer: (x, y) => ({ ...x, ...y }),
  }),

  // ==================== Working State ====================

  /** Sub-queries generated from query analysis */
  subQueries: Annotation<string[]>({
    reducer: (x, y) => y ?? x ?? [],
  }),

  /** Search results from all queries */
  searchResults: Annotation<SearchResult[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  /** Node IDs created during research */
  createdNodeIds: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  /** Synthesis (insight) node IDs */
  synthesisNodeIds: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  /** Messages (for LLM interaction) */
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  // ==================== Output ====================

  /** Frame ID wrapping all research nodes (if created) */
  frameId: Annotation<string | null>({
    reducer: (x, y) => y ?? x ?? null,
  }),

  /** Final canvas version after all updates */
  finalCanvasVersion: Annotation<number | null>({
    reducer: (x, y) => y ?? x ?? null,
  }),

  /** Errors encountered during research */
  errors: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  /** Research start timestamp */
  startTime: Annotation<number>({
    reducer: (x, y) => y ?? x ?? Date.now(),
  }),

  /** Research end timestamp */
  endTime: Annotation<number | null>({
    reducer: (x, y) => y ?? x ?? null,
  }),
});

/**
 * Type helper to extract the state type
 */
export type ResearchStateType = typeof ResearchState.State;
