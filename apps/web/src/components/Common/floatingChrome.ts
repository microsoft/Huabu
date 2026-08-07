// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * DOM contract for chrome that is portalled out of the surface it
 * belongs to — floating toolbars, their colour pickers, anchored
 * popovers.
 *
 * Attention tracking (`useTrackAttention`) treats an interaction inside
 * marked chrome as *neutral*: it leaves the current verdict untouched
 * instead of reading as "the user moved to a new surface". Neutral
 * rather than "belongs to surface X" because ownership depends on who
 * opened the popover, and hard-coding it gets one of the two cases
 * wrong — unmarked chrome vanishes under its own pointer, chrome marked
 * as the wrong surface drags attention back to a surface the user left.
 *
 * Spread onto every portalled root, including popovers a toolbar
 * portals out of itself:
 *
 * ```tsx
 * <div {...FLOATING_CHROME_PROPS} />
 * ```
 */
export const FLOATING_CHROME_PROPS = { 'data-floating-chrome': '' } as const;

/** Matches any element inside marked floating chrome. */
export const FLOATING_CHROME_SELECTOR = '[data-floating-chrome]';
