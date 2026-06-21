/**
 * Search store.
 *
 * Owns the canvas-search overlay's open/closed state, the current query
 * string, the streamed result list, and the in-flight `AbortController`
 * so a follow-up keystroke cleanly cancels the previous request.
 *
 * Scope:
 *   - `'canvas'` — the global search overlay (Cmd+F outside a preview).
 *     Results span every node on the active canvas.
 *   - `'node'` — the in-preview search bar (Cmd+F while focus is inside
 *     `ExpandedNodePanel`). Results are restricted to one node id and
 *     `field === 'content'` so the highlight layer can paint matches
 *     inline.
 *
 * One store handles both modes because (a) only one is ever active at
 * a time (Cmd+F dispatches by focus), and (b) sharing the cancellation
 * + debounce plumbing across modes keeps the implementation small.
 */

import { create } from 'zustand';

import { streamCanvasSearch } from '../api/canvasSearch';

import type {
  CanvasSearchEvent,
  CanvasSearchMatch,
  CanvasSearchRequest,
} from '@sediment/shared';

/** Where the overlay is mounted. `null` = nothing open. */
export type SearchScope =
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'node'; canvasId: string; nodeId: string };

export interface SearchResultRow {
  /** Stable key (`${nodeId}:${field}:${matchStart}`) for React lists. */
  key: string;
  tier: 'meta' | 'content';
  match: CanvasSearchMatch;
}

interface SearchState {
  scope: SearchScope | null;
  query: string;
  results: SearchResultRow[];
  /** True between request start and `done`/`error` frame (or abort). */
  isStreaming: boolean;
  /** Last `done` frame's `truncated` flag. */
  truncated: boolean;
  /** `meta`-tier streaming has finished; the `content` tier is running. */
  contentPhase: boolean;
  /** Most recent error message (cleared on next query). */
  error: string | null;

  open: (scope: SearchScope) => void;
  close: () => void;
  setQuery: (query: string) => void;
  clearResults: () => void;
}

/** Module-scope ref so debounce/abort survive React re-renders. */
let currentController: AbortController | null = null;
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 200;

function cancelInFlight(): void {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
}

export const useSearchStore = create<SearchState>((set, get) => ({
  scope: null,
  query: '',
  results: [],
  isStreaming: false,
  truncated: false,
  contentPhase: false,
  error: null,

  open: (scope) => {
    cancelInFlight();
    set({
      scope,
      query: '',
      results: [],
      isStreaming: false,
      truncated: false,
      contentPhase: false,
      error: null,
    });
  },

  close: () => {
    cancelInFlight();
    set({
      scope: null,
      query: '',
      results: [],
      isStreaming: false,
      truncated: false,
      contentPhase: false,
      error: null,
    });
  },

  clearResults: () => {
    cancelInFlight();
    set({
      results: [],
      isStreaming: false,
      truncated: false,
      contentPhase: false,
      error: null,
    });
  },

  setQuery: (query) => {
    set({ query });
    const trimmed = query.trim();
    cancelInFlight();
    if (!trimmed) {
      set({
        results: [],
        isStreaming: false,
        truncated: false,
        contentPhase: false,
        error: null,
      });
      return;
    }
    debounceHandle = setTimeout(() => {
      void runSearch(trimmed, set, get);
    }, DEBOUNCE_MS);
  },
}));

async function runSearch(
  query: string,
  set: (
    partial: Partial<SearchState> | ((s: SearchState) => Partial<SearchState>),
  ) => void,
  get: () => SearchState,
): Promise<void> {
  const scope = get().scope;
  if (!scope) return;

  const controller = new AbortController();
  currentController = controller;

  set({
    results: [],
    isStreaming: true,
    truncated: false,
    contentPhase: false,
    error: null,
  });

  try {
    await streamCanvasSearch(scope.canvasId, {
      request: buildRequest(scope, query),
      signal: controller.signal,
      onEvent: (event) => {
        // Drop events from a superseded request — controller swapped
        // between the call site `await` and the chunk arriving.
        if (controller !== currentController) return;
        handleEvent(event, set);
      },
    });
    // Stream completed naturally (server emitted `done` and ended).
    if (controller === currentController) {
      set({ isStreaming: false });
      currentController = null;
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    if (controller !== currentController) return;
    set({
      isStreaming: false,
      error: err instanceof Error ? err.message : String(err),
    });
    currentController = null;
  }
}

function buildRequest(scope: SearchScope, query: string): CanvasSearchRequest {
  if (scope.kind === 'node') {
    return { query, nodeId: scope.nodeId, fields: ['content'], limit: 200 };
  }
  return { query, limit: 100 };
}

function handleEvent(
  event: CanvasSearchEvent,
  set: (
    partial: Partial<SearchState> | ((s: SearchState) => Partial<SearchState>),
  ) => void,
): void {
  switch (event.type) {
    case 'match': {
      const row: SearchResultRow = {
        key: `${event.match.nodeId}:${event.match.field}:${event.match.matchStart}:${event.tier}`,
        tier: event.tier,
        match: event.match,
      };
      set((s) => ({ results: [...s.results, row] }));
      return;
    }
    case 'progress':
      if (event.phase === 'meta-done') set({ contentPhase: true });
      return;
    case 'done':
      set({ isStreaming: false, truncated: event.truncated });
      return;
    case 'error':
      set({ isStreaming: false, error: event.message });
      return;
  }
}
