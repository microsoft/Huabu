// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Note-node fixed-height seeding constants and helpers.
 *
 * Shared between `NoteNode` (corner "show all content" affordance) and
 * `NodeFloatingToolbar` (toolbar auto/fixed toggle). Keeping the seed
 * logic in one place ensures the two entry points stay in lock-step —
 * a previous duplication had the toolbar silently diverge from the node.
 *
 * The auto-height *minimum* is not here: it belongs to the shared height
 * policy (`canvas-engine/height/policy.ts`), because the headless engine
 * has to apply the identical floor when it materializes a height.
 */

/**
 * Default height (px) used when the user toggles a previously auto-sized
 * note into fixed-height mode and we have neither a remembered height
 * nor a rendered measurement to seed from.
 */
export const NOTE_DEFAULT_FIXED_HEIGHT = 400;

/**
 * Upper bound (px) when seeding the fixed height from the current
 * rendered content. Prevents toggling a very long note into fixed mode
 * from creating a gigantic node on the canvas.
 */
export const NOTE_MAX_SEED_FIXED_HEIGHT = 800;

/**
 * Resolve the height to use when an auto-height note is being pinned to
 * a fixed height.
 *
 * Priority:
 *  1. The most recently observed pinned height (`remembered`) — so a
 *     "collapse → expand → collapse" round-trip restores the previous
 *     fixed size exactly.
 *  2. The currently rendered measurement, capped at
 *     `NOTE_MAX_SEED_FIXED_HEIGHT` — prevents long content from
 *     producing a giant node.
 *  3. `NOTE_DEFAULT_FIXED_HEIGHT` as the final fallback (e.g. brand-new
 *     note that hasn't been measured yet).
 */
export function seedNoteFixedHeight(
  remembered: number | undefined,
  measured: number | undefined,
): number {
  if (typeof remembered === 'number' && remembered > 0) {
    return remembered;
  }
  if (typeof measured === 'number' && measured > 0) {
    return Math.min(measured, NOTE_MAX_SEED_FIXED_HEIGHT);
  }
  return NOTE_DEFAULT_FIXED_HEIGHT;
}
