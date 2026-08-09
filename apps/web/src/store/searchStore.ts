// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Search store.
 *
 * Owns the canvas-search overlay's open/closed state, the current query
 * string, the streamed result list, and the in-flight `AbortController`
 * so a follow-up keystroke cleanly cancels the previous request.
 *
 * Scope is canvas-wide. In-preview find has its own store so its query,
 * lifecycle, and PDF text index cannot open or mutate the Layers panel.
 */

import { create } from 'zustand';

import { streamCanvasSearch } from '../api/canvasSearch';

import type {
  CanvasNodeType,
  CanvasSearchEvent,
  CanvasSearchMatch,
  CanvasSearchRequest,
} from '@huabu/shared';

/** Where the overlay is mounted. `null` = nothing open. */
export type SearchScope = { kind: 'canvas'; canvasId: string };

export interface SearchResultRow {
  /** Stable key (`${nodeId}:${field}:${occurrenceIndex}:${tier}`) for React lists. */
  key: string;
  tier: 'meta' | 'content' | 'conversation';
  match: CanvasSearchMatch;
}

interface SearchState {
  scope: SearchScope | null;
  query: string;
  /**
   * Optional type whitelist passed through to the server’s
   * `CanvasSearchRequest.nodeTypes`. Sourced from the layer
   * panel’s chip toolbar so chip toggles narrow the canvas
   * search live, in addition to filtering the layer tree below.
   * Empty array → no type constraint (server treats it the same
   * as `undefined`). Identity is replaced on every mutation so
   * React memoisation can compare by reference.
   */
  nodeTypes: readonly CanvasNodeType[];
  results: SearchResultRow[];
  /** True between request start and `done`/`error` frame (or abort). */
  isStreaming: boolean;
  /** Last `done` frame's `truncated` flag. */
  truncated: boolean;
  /** `meta`-tier streaming has finished; the `content` tier is running. */
  contentPhase: boolean;
  /** Most recent error message (cleared on next query). */
  error: string | null;
  /**
   * Per-node collapse state for the canvas-scope overlay (VS Code-style
   * grouped results). Identity is replaced on every mutation so React
   * memoisation can compare by reference.
   */
  collapsedNodeIds: Set<string>;

  open: (scope: SearchScope) => void;
  close: () => void;
  setQuery: (query: string) => void;
  /**
   * Replace the type whitelist. If a query is currently active the
   * search is re-run with the new filter; if the query is empty the
   * filter is just stored for the next keystroke.
   */
  setNodeTypes: (nodeTypes: readonly CanvasNodeType[]) => void;
  clearResults: () => void;
  toggleNodeCollapse: (nodeId: string) => void;
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
  nodeTypes: [],
  results: [],
  isStreaming: false,
  truncated: false,
  contentPhase: false,
  error: null,
  collapsedNodeIds: new Set<string>(),

  open: (scope) => {
    cancelInFlight();
    set({
      scope,
      query: '',
      // Intentionally NOT clearing `nodeTypes` here: the chip
      // whitelist lives in the layer panel UI which outlives any
      // single search session, so opening a fresh scope should
      // inherit whatever chips the user already has selected.
      results: [],
      isStreaming: false,
      truncated: false,
      contentPhase: false,
      error: null,
      collapsedNodeIds: new Set<string>(),
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
      collapsedNodeIds: new Set<string>(),
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
      collapsedNodeIds: new Set<string>(),
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
        collapsedNodeIds: new Set<string>(),
      });
      return;
    }
    debounceHandle = setTimeout(() => {
      void runSearch(trimmed, set, get);
    }, DEBOUNCE_MS);
  },

  setNodeTypes: (nodeTypes) => {
    // Skip the re-search when the filter is effectively unchanged.
    // Chip toggles fire frequently while the user audits a busy
    // canvas, and a no-op set still pays for one React render so
    // the early-return shaves the wasted work entirely.
    const prev = get().nodeTypes;
    const sameLength = prev.length === nodeTypes.length;
    const sameMembers = sameLength && prev.every((t, i) => t === nodeTypes[i]);
    if (sameMembers) return;
    set({ nodeTypes });
    const trimmed = get().query.trim();
    cancelInFlight();
    if (!trimmed) return;
    debounceHandle = setTimeout(() => {
      void runSearch(trimmed, set, get);
    }, DEBOUNCE_MS);
  },

  toggleNodeCollapse: (nodeId) => {
    set((s) => {
      const next = new Set(s.collapsedNodeIds);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { collapsedNodeIds: next };
    });
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
      request: buildRequest(query, get().nodeTypes),
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

function buildRequest(
  query: string,
  nodeTypes: readonly CanvasNodeType[],
): CanvasSearchRequest {
  // Spread to a mutable array because the wire schema asks for
  // a plain `CanvasNodeType[]`. Omit the field entirely when the
  // whitelist is empty so the server's "no constraint" branch
  // wins (avoids an empty-array → "match nothing" interpretation
  // ambiguity at the wire layer).
  if (nodeTypes.length === 0) {
    return { query, limit: 1000 };
  }
  return { query, limit: 1000, nodeTypes: [...nodeTypes] };
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
        // `matchStart` is the offset *inside the snippet*, not the
        // original haystack — distinct hits in the same field can
        // collide on it after `buildSnippet` collapses whitespace.
        // `occurrenceIndex` is the server-stamped 0-based ordinal per
        // `(nodeId, field)` and is guaranteed unique within a stream,
        // so we use it as the disambiguator in the React key.
        key: `${event.match.nodeId}:${event.match.field}:${event.match.occurrenceIndex}:${event.tier}`,
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
