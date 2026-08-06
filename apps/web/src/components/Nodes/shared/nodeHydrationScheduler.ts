// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Generic per-frame hydration scheduler for heavy node sub-trees.
 *
 * Each "heavy" piece of a node — a Crepe / ProseMirror instance, a
 * pdf.js `<Document>` capture, an iframe preview, etc. — costs tens to
 * hundreds of ms to build. Mounting them all inside a single React
 * commit on canvas open blocks the main thread for seconds (a 27-note
 * canvas used to freeze the spinner for ~3 s before this scheduler
 * existed for notes).
 *
 * This module hands out "you may mount your heavy bit now" grants one
 * per animation frame. The browser gets to paint between each build,
 * cheap placeholders keep rendering, and the heavy pieces stream in
 * instead of arriving in one blocking burst.
 *
 * The visual result is identical to mounting eagerly — only the
 * *timing* of the synchronous build work is spread out.
 *
 * One global rAF queue is shared across every node type that opts in,
 * so the total work-per-frame budget stays bounded regardless of how
 * many heavy types (notes, PDF thumbnails, web previews, …) exist on
 * the canvas.
 */

import { useEffect, useState } from 'react';

/**
 * `requestAnimationFrame` / `cancelAnimationFrame` with a `setTimeout`
 * fallback for non-DOM environments (e.g. unit tests, SSR).
 */
const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;

const cancelRaf: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle)
    : (handle) => clearTimeout(handle);

type Grant = () => void;

/** FIFO queue of pending hydration grants — shared across all node types. */
const pending: Grant[] = [];

/** Active `requestAnimationFrame` handle, or 0 when idle. */
let rafId = 0;

function pump(): void {
  rafId = 0;
  // Grant exactly one node per frame. The granted node's mount work
  // runs synchronously in its React effect *after* this callback
  // returns, so processing more than one per frame would re-coalesce
  // the builds into a single blocking commit — defeating the stagger.
  const grant = pending.shift();
  grant?.();
  if (pending.length > 0) ensurePump();
}

function ensurePump(): void {
  if (rafId !== 0) return;
  rafId = raf(pump);
}

/**
 * Register a node for deferred hydration. `grant` is invoked (at most
 * once) when it is this node's turn to mount its heavy bit.
 *
 * Returns a cleanup that de-registers the node if it unmounts before
 * its turn (e.g. virtualised out of view, canvas swap), so we never
 * grant to a dead node.
 */
export function requestNodeHydration(grant: Grant): () => void {
  pending.push(grant);
  ensurePump();
  return () => {
    const i = pending.indexOf(grant);
    if (i >= 0) pending.splice(i, 1);
    if (pending.length === 0 && rafId !== 0) {
      cancelRaf(rafId);
      rafId = 0;
    }
  };
}

/**
 * React hook wrapper around {@link requestNodeHydration}. Returns
 * `false` until this node receives a grant, then flips to `true` and
 * stays there for the lifetime of the component.
 *
 * Pass `skip = true` to bypass the queue entirely — useful when the
 * node is e.g. a semantic-zoom placeholder (no heavy bit to mount
 * yet) and shouldn't take up a slot ahead of nodes that *are* visible.
 * Flipping `skip` back to `false` re-enqueues the node.
 *
 * @example
 * const hydrated = useDeferredHydration(isMinimalLOD);
 * return hydrated ? <HeavyThing /> : <Placeholder />;
 */
export function useDeferredHydration(skip = false): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated || skip) return;
    // `requestNodeHydration` runs `grant` on a future animation frame.
    // Without this guard, a frame fired between scheduling and effect
    // cleanup would call `setHydrated(true)` on a possibly-unmounted
    // component. React 18 no-ops the setter, but we still want to
    // avoid the placeholder->heavy mount work being kicked off for a
    // node that's already on its way out (e.g. canvas swap mid-frame).
    let alive = true;
    const cancel = requestNodeHydration(() => {
      if (alive) setHydrated(true);
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [hydrated, skip]);
  return hydrated;
}
