/**
 * Public type definitions for the Milkdown wrapper.
 *
 * These are the only Milkdown-related types that downstream code sees.
 * Anything Crepe / ProseMirror specific stays internal.
 */

import type { ReactNode } from 'react';

/**
 * Optional decoration spec (reserved for Phase 4 provenance).
 *
 * Phase 1b accepts the type but does not render decorations — Phase 4
 * wires this through to ProseMirror `Decoration.node` / `Decoration.widget`.
 * Lines are 0-based; `endLine` is exclusive.
 */
export interface MilkdownDecorationSpec {
  ranges: Array<{
    startLine: number;
    endLine: number;
    className: string;
    /** Optional widget rendered at the block boundary (e.g. accept/reject buttons). */
    accessory?: ReactNode;
  }>;
}

/**
 * Fired when the user starts dragging a block (or multiple blocks) out
 * of the editor surface.
 *
 * `MilkdownPreview` owns the drag-image lifecycle (it builds the
 * preview inside its Shadow DOM so the editor's full stylesheet stack
 * — Crepe theme, our overrides, KaTeX — applies to the rendered image
 * exactly as it appears in the live editor). Consumers only need to
 * stash `markdown` on the dataTransfer (for the canvas drop handler);
 * they should NOT call `dataTransfer.setDragImage` themselves.
 */
export interface MilkdownBlockDragEvent {
  /** Markdown of the block(s) being dragged. */
  markdown: string;
  /** Native DragEvent, so callers can call setData. */
  nativeEvent: DragEvent;
}
