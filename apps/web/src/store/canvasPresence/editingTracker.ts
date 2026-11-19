// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Decides which node this page reports as "being edited".
 *
 * That report is the other pages' edit lock on the node (see `editLock.ts`),
 * so it must not outlive the editing:
 *
 *  - it follows focus: a text control of the node has focus on a page that
 *    itself has focus and is visible;
 *  - it ends after `EDIT_IDLE_RELEASE_MS` without a key press, pointer press
 *    or input on the page, so a caret left in a note does not hold the lock;
 *  - when it ends, the node's queued content is saved first and the release
 *    is reported after the server answered (at most `EDIT_RELEASE_CAP_MS`
 *    later), so a page that starts editing right after it has that text.
 *
 * A node another page is editing is never taken: when the caret gets into a
 * control of it — the person clicks into it, or comes back to a control the
 * other page has started editing meanwhile — the control is blurred instead
 * of the node being reported.
 */

/** Longest a release waits for the last save of the node. */
export const EDIT_RELEASE_CAP_MS = 5_000;
/** Time without input after which a focused editor stops holding the lock. */
export const EDIT_IDLE_RELEASE_MS = 120_000;

export interface EditingTrackerOptions {
  /** The node whose text control has focus now, if any. */
  focusedNodeId: () => string | null;
  /** Whether the page has focus and is visible. */
  pageActive: () => boolean;
  /** Tell the other pages which node this page is editing. */
  report: (nodeId: string | null) => void;
  /** Record the node for this page's own lock check. */
  setLocal: (nodeId: string | null) => void;
  /** Save the node's queued content; settles when the server has answered. */
  save: (nodeId: string) => Promise<void>;
  /**
   * This page is about to report `nodeId`, which it does not report now.
   * Returns `true` when another page is editing it; the caller has then
   * taken focus away.
   */
  yieldIfHeldElsewhere: (nodeId: string) => boolean;
}

export interface EditingTracker {
  /** Focus changed, or the page regained focus or became visible. */
  sync(): void;
  /** A key press, pointer press or input happened on the page. */
  activity(): void;
  stop(): void;
}

export function createEditingTracker(
  options: EditingTrackerOptions,
): EditingTracker {
  let reported: string | null = null;
  let release = 0;
  let releaseCap: ReturnType<typeof setTimeout> | null = null;
  let idle = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = Date.now();
  let stopped = false;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdleTimer = (): void => {
    clearIdleTimer();
    const wait = Math.max(0, lastActivity + EDIT_IDLE_RELEASE_MS - Date.now());
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (Date.now() - lastActivity < EDIT_IDLE_RELEASE_MS) {
        armIdleTimer();
        return;
      }
      idle = true;
      sync();
    }, wait);
  };

  function sync(): void {
    if (stopped) return;
    const focused = options.focusedNodeId();
    let id = focused && !idle && options.pageActive() ? focused : null;
    // A node this page is not reporting may be another page's by now. However
    // the caret got into one of its controls — a click, or coming back to
    // the page — the node is not taken from the page that is editing it.
    if (id && id !== reported && options.yieldIfHeldElsewhere(id)) id = null;
    options.setLocal(id);
    if (id === reported) return;
    const previous = reported;
    reported = id;
    const token = ++release;
    if (releaseCap !== null) clearTimeout(releaseCap);
    releaseCap = null;
    if (id) armIdleTimer();
    else clearIdleTimer();
    const saved = previous ? options.save(previous) : null;
    if (id || !saved) {
      options.report(id);
      return;
    }
    const send = (): void => {
      if (releaseCap !== null) clearTimeout(releaseCap);
      releaseCap = null;
      if (stopped || token !== release) return;
      // The cap and the save both end here; whichever is second does nothing.
      release += 1;
      options.report(null);
    };
    releaseCap = setTimeout(send, EDIT_RELEASE_CAP_MS);
    void saved.then(send, send);
  }

  return {
    sync,
    activity() {
      if (stopped) return;
      lastActivity = Date.now();
      if (!idle) return;
      idle = false;
      sync();
    },
    stop() {
      stopped = true;
      clearIdleTimer();
      if (releaseCap !== null) clearTimeout(releaseCap);
      releaseCap = null;
    },
  };
}
