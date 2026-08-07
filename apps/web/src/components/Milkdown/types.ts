// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Public type definitions for the Milkdown wrapper.
 *
 * These are the only Milkdown-related types that downstream code sees.
 * Anything Crepe / ProseMirror specific stays internal.
 */

import type { AccentToken } from '@huabu/shared';

export type MilkdownToolbarMode = 'none' | 'huabu';

export type MilkdownInlineMark = 'bold' | 'italic' | 'strike' | 'inlineCode';

export type MilkdownBlockType =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'blockquote'
  | 'divider'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'table'
  | 'math'
  | 'code-block';

export type MilkdownTextColor = AccentToken;
export type MilkdownBackgroundColor = AccentToken;

export interface MilkdownFormattingState {
  blockType: MilkdownBlockType;
  activeMarks: ReadonlySet<MilkdownInlineMark>;
  textColor: MilkdownTextColor | null;
  backgroundColor: MilkdownBackgroundColor | null;
}

/**
 * Phase 4 decoration spec.
 *
 * Decorations are keyed by **block fingerprints** (see
 * `apps/web/src/utils/blockProvenance.ts`) — same identity used by the
 * provenance engine, so a single map drives both the highlight and any
 * tombstone overlay drawn by the surrounding component.
 *
 * `tombstones` is intentionally part of the spec for symmetry but the
 * editor itself does not render them — `NotePreview` portals a
 * `TombstoneOverlay` onto the DOM resolved via
 * `MilkdownInstance.getBlockDOMByKey(anchorKey)`.
 */
export interface MilkdownDecorationSpec {
  /** Highlight a top-level block with `className`. */
  blocks: Array<{ key: string; className: string }>;
  /** Reserved for `NotePreview` to consume; the editor ignores this. */
  tombstones?: Array<{
    deletedKey: string;
    anchorKey: string | null;
    markdown: string;
  }>;
}

/**
 * Fired when the user starts dragging a block (or multiple blocks) out
 * of the editor surface.
 *
 * `MilkdownPreview` owns the drag-image lifecycle (it builds the
 * preview in `document.body` so the editor's full stylesheet stack
 * — Crepe theme, our overrides, KaTeX — applies to the rendered image
 * exactly as it appears in the live editor). Consumers only need to
 * stash `markdown` on the dataTransfer (for the canvas drop handler);
 * they should NOT call `dataTransfer.setDragImage` themselves.
 */
export interface MilkdownBlockDragEvent {
  /** Markdown of the block(s) being dragged. */
  markdown: string;
  /** Markdown the source doc would hold if the dragged range were deleted. */
  sourceContentAfterMove: string;
  /** Native DragEvent, so callers can call setData. */
  nativeEvent: DragEvent;
}
