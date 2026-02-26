import { create } from 'zustand';

import type {
  ResearchConfig,
  ResearchEvent,
  ResearchStep,
} from '@sediment/shared';

export type ResearchStatus = 'idle' | 'running' | 'completed' | 'error';

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
  handleEvent: (event: ResearchEvent) => void;
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

    switch (event.type) {
      case 'thinking': {
        set({
          currentStep: event.data.step,
          steps: [
            ...state.steps.filter((s) => s.type !== 'thinking'),
            {
              id: `thinking-${event.timestamp}`,
              type: 'thinking',
              title: event.data.step,
              status: 'running',
              detail: event.data.content,
              timestamp: event.timestamp,
            },
          ],
        });
        break;
      }

      case 'searching': {
        set({
          currentStep: 'Searching...',
          steps: [
            ...state.steps.map((s) =>
              s.type === 'thinking' ? { ...s, status: 'done' as const } : s,
            ),
            {
              id: `searching-${event.timestamp}`,
              type: 'searching',
              title: `Searching: ${event.data.query}`,
              status: 'running',
              detail: `Found ${event.data.resultCount} results`,
              timestamp: event.timestamp,
            },
          ],
        });
        break;
      }

      case 'node_created': {
        set({
          createdNodeIds: [...state.createdNodeIds, event.data.nodeId],
          steps: state.steps.map((s) =>
            s.type === 'searching' ? { ...s, status: 'done' as const } : s,
          ),
        });
        break;
      }

      case 'ingesting': {
        const ingestingId = `ingesting-${event.data.nodeId}`;
        const existingStep = state.steps.find((s) => s.id === ingestingId);

        if (existingStep) {
          // Update existing ingesting step
          set({
            currentStep: 'Processing content...',
            steps: state.steps.map((s) =>
              s.id === ingestingId
                ? {
                    ...s,
                    status: event.data.status === 'done' ? 'done' : 'running',
                    detail: event.data.error,
                    timestamp: event.timestamp,
                  }
                : s,
            ),
          });
        } else {
          // Add new ingesting step
          set({
            currentStep: 'Processing content...',
            steps: [
              ...state.steps,
              {
                id: ingestingId,
                type: 'ingesting',
                title: 'Ingesting content',
                status: event.data.status === 'done' ? 'done' : 'running',
                detail: event.data.error,
                nodeIds: [event.data.nodeId],
                timestamp: event.timestamp,
              },
            ],
          });
        }
        break;
      }

      case 'synthesis': {
        set({
          currentStep: 'Generating insights...',
          steps: [
            ...state.steps.map((s) =>
              s.type === 'ingesting' ? { ...s, status: 'done' as const } : s,
            ),
            {
              id: `synthesis-${event.timestamp}-${event.data.nodeId}`,
              type: 'synthesizing',
              title: 'AI Synthesis',
              status: 'done',
              detail: event.data.content.slice(0, 100) + '...',
              nodeIds: [event.data.nodeId, ...event.data.relatedNodeIds],
              timestamp: event.timestamp,
            },
          ],
          createdNodeIds: [
            ...state.createdNodeIds,
            event.data.nodeId,
            ...event.data.relatedNodeIds.filter(
              (id: string) => !state.createdNodeIds.includes(id),
            ),
          ],
        });
        break;
      }

      case 'complete': {
        set({
          status: 'completed',
          currentStep: 'Complete!',
          endTime: Date.now(),
          frameId: event.data.frameId ?? null,
          steps: state.steps.map((s) =>
            s.status === 'error' ? s : { ...s, status: 'done' as const },
          ),
        });
        break;
      }

      case 'error': {
        if (event.data.recoverable) {
          // Recoverable error: add a step but keep the current running status
          set({
            steps: [
              ...state.steps,
              {
                id: `error-${Date.now()}`,
                type: 'thinking',
                title: 'Error',
                status: 'error',
                detail: event.data.message,
                timestamp: event.timestamp,
              },
            ],
          });
        } else {
          set({
            status: 'error',
            error: event.data.message,
            currentStep: `Error: ${event.data.message}`,
            steps: [
              ...state.steps,
              {
                id: `error-${Date.now()}`,
                type: 'thinking',
                title: 'Error',
                status: 'error',
                detail: event.data.message,
                timestamp: event.timestamp,
              },
            ],
          });
        }
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
