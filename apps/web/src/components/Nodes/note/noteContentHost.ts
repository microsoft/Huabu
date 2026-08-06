// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared geometry of a note's content host.
 *
 * The offscreen measurer and the mounted note must produce the same
 * number for the same markdown, and the only way to guarantee that is to
 * build the same box. Anything here that affects layout — width, padding,
 * display — is imported by both, so a change to one cannot silently
 * diverge from the other.
 *
 * Colour and background are deliberately excluded: they differ between
 * the two surfaces (accent tints, `visibility: hidden`) and cannot affect
 * height.
 */

/**
 * Classes that determine the content host's box. `h-full` is *not* here:
 * the mounted note is constrained to the node's layout height, while the
 * measurer needs the host's natural height.
 */
export const NOTE_CONTENT_HOST_CLASS = 'flex flex-col rounded p-2';

/**
 * Read a note's intrinsic content height from its content host.
 *
 * Measures `.ProseMirror` rather than `host.scrollHeight`, because
 * Crepe's block-edit plugin parks an absolutely positioned
 * `.milkdown-block-handle` at the bottom of `.milkdown`, inflating
 * `scrollHeight` by ~34px and leaving dead space under the text. The
 * host's own vertical padding is added back, since `.ProseMirror` does
 * not include it.
 *
 * Returns `0` when there is nothing measurable yet (editor not mounted).
 */
export function readNoteIntrinsicHeight(host: HTMLElement): number {
  const prose = host.querySelector('.ProseMirror') as HTMLElement | null;
  if (!prose) return host.scrollHeight;
  const style = getComputedStyle(host);
  const padY =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0);
  return prose.scrollHeight + padY;
}
