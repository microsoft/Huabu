// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single source of truth for the height (CSS pixels) of the HTML-painted
 * window chrome strip rendered by `WindowChrome` in the renderer.
 *
 * The value is consumed in two places:
 *
 *   1. The main process feeds it to Electron's `titleBarOverlay.height`
 *      on Windows so the OS-drawn caption buttons (min/max/close)
 *      vertically align with our HTML row.
 *   2. `WindowChrome` reads it through the preload `electronBridge` to
 *      size its own root element.
 *
 * ⚠️ Also hard-coded in `apps/desktop/src/preload.ts` as a literal —
 * sandboxed preload scripts cannot `require` sibling modules (only a
 * tiny built-in allowlist), so the value must be duplicated there.
 * Keep the two in sync whenever you change the height.
 *
 * Changing this number updates main.ts at compile time; update
 * `preload.ts`'s literal manually to match. Do NOT hard-code 36
 * anywhere else in the codebase.
 */
export const TITLE_BAR_HEIGHT = 36;
