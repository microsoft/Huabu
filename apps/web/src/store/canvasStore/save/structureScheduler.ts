// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Debounced scheduler for the canvas structure save
 * (`PUT /api/canvas/:id`). Holds a single module-scoped timer and
 * exposes three operations:
 *
 *   • {@link StructureScheduler.schedule} — middleware path
 *     (debounce window resets on every store mutation that the dirty
 *     detector flagged as structural).
 *   • {@link StructureScheduler.flushAsync} — canvas-switch path
 *     (`loadCanvas` awaits this before clearing state so trailing
 *     edits land before the new canvas overwrites them).
 *   • {@link StructureScheduler.cancelPending} — unload path
 *     (`beforeunload` listener uses this to decide whether to fire a
 *     `keepalive` PUT; the scheduler itself can't await on unload).
 *
 * The actual save action lives in the store slice
 * (`saveCanvas` on `useCanvasStore`) because it touches OCC state
 * (`isSaving`, `pendingSave`, `versionConflict`, `version`). This
 * module only owns the *timer*, not the work.
 */

import { CanvasConflictError } from '@/api/canvas';

/**
 * Public shape returned by {@link createStructureScheduler}.
 */
export type StructureScheduler = {
  /**
   * Start (or reset) the debounce timer. When it fires, calls
   * `getSaveCanvas()()` and swallows `CanvasConflictError` (the
   * sticky `versionConflict` flag in the store already gates further
   * saves and surfaces the toast).
   */
  schedule(): void;

  /**
   * If a save is currently pending, cancel its timer and immediately
   * await the regular (non-keepalive) save. Swallows
   * `CanvasConflictError` for the same reason as {@link schedule}.
   * No-op when no save is pending.
   */
  flushAsync(): Promise<void>;

  /**
   * Cancel any pending save timer. Returns `true` when a timer was
   * actually cancelled, `false` when nothing was pending. The unload
   * listener uses the return value to decide whether the latest
   * structure mutation needs a `keepalive` PUT — if no timer was
   * pending, the server already has the latest state.
   */
  cancelPending(): boolean;
};

/**
 * Build a {@link StructureScheduler}. Inject the save action via
 * `getSaveCanvas` (a lazy getter, not a bound reference) so the
 * scheduler always picks up the latest slice closure even if the
 * store is recreated (e.g. HMR).
 */
export function createStructureScheduler(opts: {
  getSaveCanvas: () => () => Promise<void>;
  delayMs: number;
}): StructureScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const logIfNotConflict = (label: string, err: unknown): void => {
    if (!(err instanceof CanvasConflictError)) {
      console.error(`${label}:`, err);
    }
  };

  return {
    schedule(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        opts
          .getSaveCanvas()()
          .catch((err) => logIfNotConflict('Autosave failed', err));
      }, opts.delayMs);
    },

    async flushAsync(): Promise<void> {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      try {
        await opts.getSaveCanvas()();
      } catch (err) {
        logIfNotConflict('Failed to flush autosave', err);
      }
    },

    cancelPending(): boolean {
      if (!timer) return false;
      clearTimeout(timer);
      timer = null;
      return true;
    },
  };
}
