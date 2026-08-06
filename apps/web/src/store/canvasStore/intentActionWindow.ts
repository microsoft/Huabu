/**
 * In-memory short-window action history for the intent recogniser.
 *
 * Lives OUTSIDE the Zustand store on purpose. No React component
 * subscribes to this buffer — it's read exactly once per agent /
 * intent request via `useCanvasStore.getIntentContext()`. Keeping it
 * on the store forced `dispatchUiIntent` to fire a *second*
 * `set({ actionHistory })` after `executeCommands` had already
 * committed the geometry write, so every Zustand subscriber re-ran
 * its selector twice per click for a value none of them care about.
 *
 * Scope: purely local, never uploaded. The full server-bound action
 * log flows through the separate `canvasEvents` buffer
 * (`./save/eventBuffer.ts`); this window is just the short,
 * in-memory snapshot (cap 10, no timestamps) that rides on the
 * outgoing intent / agent request body as `IntentContext.recentActions`.
 *
 * Lifecycle:
 *  - `push` / `pushMany` — called from `dispatchUiIntent`,
 *    `undo`, `redo` in `canvasStore.ts`.
 *  - `snapshot`         — called from `getIntentContext` when
 *    building the intent-recogniser payload.
 *  - `clear`            — called from `switchCanvas` so a fresh
 *    canvas doesn't inherit the previous canvas's trail.
 *
 * Future cleanup
 * --------------
 * This whole module is a stopgap. Once the server-side action-log /
 * memory pipeline (see `docs/architecture/canvas-action-log.md`) lands, the recogniser
 * will pull "recent actions" from the persisted JSONL on demand
 * instead of trusting whatever short window the client happens to
 * be holding. At that point:
 *   - drop the `recentActions` field from `IntentContext`,
 *   - drop the `push`/`snapshot` plumbing in `dispatchUiIntent` /
 *     `undo` / `redo`,
 *   - delete this file.
 * The mirror call to `canvasEvents.buffer*` already feeds that
 * pipeline today, so removing this window won't lose any data.
 */

import { pushAction } from '@/handler/canvasCommand/utils';

import type { RecentAction } from '@huabu/shared';

export type IntentActionWindow = {
  /** Append a single action to the window (caps at the shared {@link pushAction} max). */
  push(action: RecentAction): void;
  /** Append many actions in order. No-op on an empty list. */
  pushMany(actions: readonly RecentAction[]): void;
  /**
   * Return the current window contents. The returned array is the
   * live internal reference, but it is safe to share: `pushAction`
   * always allocates a new array, so subsequent mutations never
   * touch a previously returned snapshot.
   */
  snapshot(): RecentAction[];
  /** Drop all entries. Called from `switchCanvas`. */
  clear(): void;
};

export function createIntentActionWindow(): IntentActionWindow {
  let history: RecentAction[] = [];

  return {
    push(action) {
      history = pushAction(history, action);
    },
    pushMany(actions) {
      if (actions.length === 0) return;
      for (const action of actions) {
        history = pushAction(history, action);
      }
    },
    snapshot() {
      return history;
    },
    clear() {
      history = [];
    },
  };
}
