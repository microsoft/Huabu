import { create } from 'zustand';

import type {
  ResearchAgentEvent,
  ResearchConfig,
  ResearchStep,
} from '@sediment/shared';

export type ResearchStatus = 'idle' | 'running' | 'completed' | 'error';
// TODO: compare with ChatStore and refine it
/**
 * Research Store - UI-only state for current research session
 * Note: Research state persistence is handled by backend checkpoint,
 * not by this store. This only manages temporary UI state.
 */
export interface ResearchState {
  /**
   * Current research status
   */
  status: ResearchStatus;

  /**
   * Research query
   */
  query: string;

  /**
   * Research configuration
   */
  config: ResearchConfig | null;

  /**
   * Current step
   */
  currentStep: string | null;

  /**
   * All steps in order
   */
  steps: ResearchStep[];

  /**
   * Created node IDs during research
   */
  createdNodeIds: string[];

  /**
   * Frame ID wrapping all research nodes
   */
  frameId: string | null;

  /**
   * Error message if any
   */
  error: string | null;

  /**
   * Start timestamp
   */
  startTime: number | null;

  /**
   * End timestamp
   */
  endTime: number | null;

  /**
   * Whether progress dialog is open
   */
  isProgressOpen: boolean;

  // Actions
  startResearch: (query: string, config: ResearchConfig) => void;
  handleEvent: (event: ResearchAgentEvent) => void;
  completeResearch: () => void;
  setError: (error: string) => void;
  reset: () => void;
  openProgress: () => void;
  closeProgress: () => void;
}

const initialState = {
  status: 'idle' as ResearchStatus,
  query: '',
  config: null,
  currentStep: null,
  steps: [],
  createdNodeIds: [],
  frameId: null,
  error: null,
  startTime: null,
  endTime: null,
  isProgressOpen: false,
};

export const useResearchStore = create<ResearchState>((set, get) => ({
  ...initialState,

  startResearch: (query, config) => {
    set({
      ...initialState,
      status: 'running',
      query,
      config,
      startTime: Date.now(),
      isProgressOpen: true,
    });
  },

  handleEvent: (event) => {
    const state = get();
    const { type, timestamp, data } = event;
    const tool = data.toolResponse?.tool as string | undefined;

    switch (type) {
      case 'update': {
        // --- Query analysis: planning step ---
        if (tool === 'research_query_analysis') {
          const d =
            data.toolResponse?.status === 'success'
              ? (data.toolResponse.data as {
                  query?: string;
                  subQueries?: string[];
                })
              : undefined;
          set({
            currentStep: 'Analyzing query...',
            steps: [
              ...state.steps.filter((s) => s.type !== 'thinking'),
              {
                id: `thinking-${timestamp}`,
                type: 'thinking',
                title: 'Query Analysis',
                status: 'done',
                detail: d?.subQueries?.join(', ') ?? d?.query ?? '',
                timestamp,
              },
            ],
          });
          break;
        }

        // --- Multi-search: searching step ---
        if (tool === 'research_multi_search') {
          const d =
            data.toolResponse?.status === 'success'
              ? (data.toolResponse.data as {
                  nodeCount?: number;
                  resultCount?: number;
                  queries?: string[];
                })
              : undefined;
          set({
            currentStep: 'Searching...',
            steps: [
              ...state.steps.map((s) =>
                s.type === 'thinking' ? { ...s, status: 'done' as const } : s,
              ),
              {
                id: `searching-${timestamp}`,
                type: 'searching',
                title: 'Web Search',
                status: 'done',
                detail: `Found ${d?.resultCount ?? 0} results across ${
                  d?.nodeCount ?? 0
                } nodes`,
                timestamp,
              },
            ],
          });
          break;
        }

        // --- Ingestion: processing step ---
        if (tool === 'research_ingestion') {
          const d =
            data.toolResponse?.status === 'success'
              ? (data.toolResponse.data as {
                  succeeded?: number;
                  failed?: number;
                })
              : undefined;
          set({
            currentStep: 'Processing content...',
            steps: [
              ...state.steps.map((s) =>
                s.type === 'searching' ? { ...s, status: 'done' as const } : s,
              ),
              {
                id: `ingesting-${timestamp}`,
                type: 'ingesting',
                title: 'Content Ingestion',
                status: 'done',
                detail: `Processed: ${d?.succeeded ?? 0} ok, ${
                  d?.failed ?? 0
                } failed`,
                timestamp,
              },
            ],
          });
          break;
        }

        // --- Canvas organization: organizing step ---
        if (tool === 'research_canvas_organization') {
          const d =
            data.toolResponse?.status === 'success'
              ? (data.toolResponse.data as {
                  frameId?: string;
                  nodeCount?: number;
                  grouped?: boolean;
                })
              : undefined;
          set({
            currentStep: 'Organizing canvas...',
            steps: [
              ...state.steps.map((s) =>
                s.type === 'ingesting' ? { ...s, status: 'done' as const } : s,
              ),
              {
                id: `organizing-${timestamp}`,
                type: 'synthesizing',
                title: 'Canvas Organization',
                status: 'done',
                detail: `${d?.nodeCount ?? 0} nodes${
                  d?.grouped ? ' grouped in frame' : ''
                }`,
                timestamp,
              },
            ],
          });
          break;
        }

        // --- Synthesis streaming (tokens from LLM, no toolResponse) ---
        if (data.node === 'synthesis' && !data.toolResponse) {
          set({ currentStep: 'Generating insights...' });
          break;
        }

        break;
      }

      case 'complete': {
        const frameId =
          typeof data.meta?.frameId === 'string' ? data.meta.frameId : null;
        set({
          status: 'completed',
          currentStep: 'Complete!',
          endTime: Date.now(),
          frameId,
          steps: state.steps.map((s) =>
            s.status === 'error' ? s : { ...s, status: 'done' as const },
          ),
        });
        break;
      }

      case 'error': {
        const message =
          typeof data.meta?.message === 'string'
            ? data.meta.message
            : 'An unknown error occurred';
        set({
          status: 'error',
          error: message,
          currentStep: `Error: ${message}`,
          steps: [
            ...state.steps,
            {
              id: `error-${Date.now()}`,
              type: 'thinking',
              title: 'Error',
              status: 'error',
              detail: message,
              timestamp,
            },
          ],
        });
        break;
      }
    }
  },

  completeResearch: () => {
    set({
      status: 'completed',
      endTime: Date.now(),
    });
  },

  setError: (error) => {
    set({
      status: 'error',
      error,
      endTime: Date.now(),
    });
  },

  reset: () => {
    set(initialState);
  },

  openProgress: () => {
    set({ isProgressOpen: true });
  },

  closeProgress: () => {
    set({ isProgressOpen: false });
  },
}));
