/**
 * @file Space-directory handle arbitration.
 *
 * On Windows a live `fs.watch` handle anywhere inside a Space subtree makes
 * `renameSync` / `rmSync` of that directory fail with EPERM. The handle is
 * persistent, so retries never win and unwatching a subpath does not release
 * it — the only fix is to fully close it for the duration of the mutation.
 *
 * This module is the neutral meeting point between the two sides of that
 * problem. Anything that holds OS handles inside `<workspace>/<Space>/`
 * registers itself here against a `canvasId`; anything that renames or
 * deletes a Space directory brackets the mutation with
 * {@link withSpaceDirHandlesReleased}. Neither side has to know about the
 * other, and a Space with no registered owner costs nothing at all.
 */

/** A component holding OS handles inside one Space directory. */
export interface SpaceDirHandleOwner {
  /** Close every handle held inside the Space directory. */
  release(): void;
  /**
   * Re-acquire handles after the mutation. The Space directory may have been
   * renamed or deleted, so implementations must re-resolve their paths from
   * the canvas-directory index rather than reusing a cached path.
   */
  reacquire(): void;
}

const ownersByCanvas = new Map<string, Set<SpaceDirHandleOwner>>();
// Depth per canvasId so concurrent or nested mutations of the same Space
// (e.g. a rename racing a delete) share one release/reacquire cycle instead
// of thrashing the owner's handles.
const suspendDepth = new Map<string, number>();

/** Register `owner` against `canvasId`. Returns an idempotent unregister. */
export function registerSpaceDirHandleOwner(
  canvasId: string,
  owner: SpaceDirHandleOwner,
): () => void {
  let owners = ownersByCanvas.get(canvasId);
  if (!owners) {
    owners = new Set();
    ownersByCanvas.set(canvasId, owners);
  }
  owners.add(owner);
  return () => {
    const current = ownersByCanvas.get(canvasId);
    if (!current?.delete(owner)) return;
    if (current.size === 0) ownersByCanvas.delete(canvasId);
  };
}

/**
 * Run `fn` with every handle inside `canvasId`'s directory released, then let
 * the owners re-acquire.
 *
 * When no owner is registered for that Space — the common case, since handles
 * exist only while a Space has an open external-note stream — this is a plain
 * passthrough that touches no filesystem state.
 */
export async function withSpaceDirHandlesReleased<T>(
  canvasId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!ownersByCanvas.get(canvasId)?.size) return fn();

  const depth = suspendDepth.get(canvasId) ?? 0;
  if (depth === 0) {
    for (const owner of [...(ownersByCanvas.get(canvasId) ?? [])]) {
      owner.release();
    }
  }
  suspendDepth.set(canvasId, depth + 1);
  try {
    return await fn();
  } finally {
    const remaining = (suspendDepth.get(canvasId) ?? 1) - 1;
    if (remaining > 0) {
      suspendDepth.set(canvasId, remaining);
    } else {
      suspendDepth.delete(canvasId);
      // Re-read the owner set: a subscriber may have arrived or left while
      // the mutation ran. `reacquire` must therefore be idempotent.
      for (const owner of [...(ownersByCanvas.get(canvasId) ?? [])]) {
        owner.reacquire();
      }
    }
  }
}
