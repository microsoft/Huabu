// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared post-commit graph cleanups that BOTH hosts (web + server) must
 * run after the executor's write result is committed.
 *
 * Pure data in, pure data out — no DOM, no callbacks, no async work.
 * Host-specific drains (preprocessing trigger, AI flag marking,
 * transition cleanup, deferred frame fit) live in their respective
 * `postEffects.web.ts` / future `postEffects.server.ts` files and read
 * the engine's `PendingEffects` manifest directly.
 *
 * Today this only handles edge handle recalculation, but the function
 * is the canonical place to add any future cleanup that must run on
 * every host (e.g. parent-child consistency checks).
 */

import { rerouteAllEdges } from './utils/edge.js';

import type {
  CanvasNode,
  CanvasEdge,
  CanvasWriteResult,
} from './interfaces.js';

export interface SharedPostEffectsInput {
  /** Newly-committed node array. */
  nodes: CanvasNode[];
  /** Newly-committed edge array. */
  edges: CanvasEdge[];
  /**
   * From `CanvasWriteResult.requiresEdgeReroute`. When `false` the
   * function is a cheap no-op that returns `input.edges` by reference.
   */
  requiresEdgeReroute: boolean;
}

export interface SharedPostEffectsOutput {
  /**
   * The post-cleanup edge array. **Reference-equal** to `input.edges`
   * when no rewrite was necessary, so callers can `if (out.edges !==
   * writeResult.edges)` to decide whether to schedule a re-render or
   * append delta entries.
   */
  edges: CanvasEdge[];
}

/**
 * Apply the host-agnostic post-commit cleanups described above.
 *
 * Web hosts merge `output.edges` into their single state-commit
 * `set({ nodes, edges })` to avoid a second render; server hosts will
 * append the rerouted edges as additional delta entries on the same
 * `delta_log` row.
 */
export function applySharedPostEffects(
  input: SharedPostEffectsInput,
): SharedPostEffectsOutput {
  if (!input.requiresEdgeReroute) {
    return { edges: input.edges };
  }
  const rerouted = rerouteAllEdges(input.nodes, input.edges);
  return { edges: rerouted };
}

/**
 * Convenience overload that takes a `CanvasWriteResult` directly. Most
 * call sites have one of these in hand from `executeCanvasCommands`.
 */
export function applySharedPostEffectsFromWriteResult(
  writeResult: CanvasWriteResult,
): SharedPostEffectsOutput {
  return applySharedPostEffects({
    nodes: writeResult.nodes,
    edges: writeResult.edges,
    requiresEdgeReroute: writeResult.requiresEdgeReroute,
  });
}
