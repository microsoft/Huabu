/**
 * Staggers heavy Milkdown editor creation across NoteNodes.
 *
 * Each Crepe / ProseMirror instance costs ~100ms to build. A canvas with
 * many notes used to mount them all inside a single React commit, which
 * blocked the main thread for seconds on load (e.g. 27 notes froze the UI
 * for ~3s, leaving the loading spinner stuck on a single frame). This
 * scheduler hands out "you may mount your editor now" grants one per
 * animation frame, so the browser gets to paint between each build — the
 * loading placeholders keep spinning, panning stays responsive, and the
 * editors stream in instead of arriving in one blocking burst.
 *
 * The visual result is identical to mounting eagerly (it's the same
 * Milkdown editor); only the *timing* of the synchronous build work is
 * spread out.
 */

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

/** FIFO queue of pending hydration grants. */
const pending: Grant[] = [];

/** Active `requestAnimationFrame` handle, or 0 when idle. */
let rafId = 0;

function pump(): void {
  rafId = 0;
  // Grant exactly one node per frame. The granted node's editor build
  // runs synchronously in its React effect *after* this callback returns,
  // so processing more than one per frame would re-coalesce the builds
  // into a single blocking commit — defeating the staggering.
  const grant = pending.shift();
  grant?.();
  if (pending.length > 0) ensurePump();
}

function ensurePump(): void {
  if (rafId !== 0) return;
  rafId = raf(pump);
}

/**
 * Register a NoteNode for deferred editor hydration. `grant` is invoked
 * (at most once) when it is this node's turn to mount its Milkdown editor.
 *
 * Returns a cleanup that de-registers the node if it unmounts before its
 * turn (e.g. virtualized out of view), so we never grant to a dead node.
 */
export function requestNoteHydration(grant: Grant): () => void {
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
