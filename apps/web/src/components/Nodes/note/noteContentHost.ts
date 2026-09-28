// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NOTE_SURFACE_DESIGN_CONFIG } from './noteDesign';
import { NODE_TYPOGRAPHY_STYLE } from '../design/nodeTypography';

/**
 * Shared geometry of a note's content host.
 *
 * The offscreen measurer and the mounted note must produce the same
 * number for the same markdown, and the only way to guarantee that is to
 * build the same box. Anything here that affects layout — width, padding,
 * display, and descendant spacing scope — is imported by both, so a
 * change to one cannot silently diverge from the other.
 *
 * Colour and background are deliberately excluded: they differ between
 * the two surfaces (accent tints, `visibility: hidden`) and cannot affect
 * height.
 */

/**
 * Classes that determine the content host's box. The mounted note adds
 * `min-h-full` to fill its viewport while allowing a natural scrollable
 * document height; the offscreen measurer needs only the natural height.
 */
export const NOTE_CONTENT_HOST_SCOPE_CLASS = 'huabu-note-content-host';
export const NOTE_FIRST_BLOCK_CLASS = 'huabu-note-first-block';
export const NOTE_CONTENT_HOST_CLASS = `${NOTE_CONTENT_HOST_SCOPE_CLASS} flex flex-col rounded`;
export const NOTE_CONTENT_HOST_STYLE = {
  ...NODE_TYPOGRAPHY_STYLE,
  boxSizing: 'border-box',
  paddingBlock: `${NOTE_SURFACE_DESIGN_CONFIG.contentPaddingBlock}px`,
  paddingInline: `${NOTE_SURFACE_DESIGN_CONFIG.contentPaddingInline}px`,
} as const;

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
