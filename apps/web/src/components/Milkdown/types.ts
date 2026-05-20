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
 * Fired when the user starts dragging a block out of the editor surface.
 *
 * Phase 5 will wire this into the canvas drop targets. Phase 1b leaves
 * the handler unattached (no-op).
 */
export interface MilkdownBlockDragEvent {
  /** Markdown substring of the block being dragged. */
  markdown: string;
  /** Native DragEvent, so callers can call setData / setDragImage. */
  nativeEvent: DragEvent;
  /** Visible DOM node of the block (useful as a setDragImage fallback). */
  blockElement: HTMLElement;
}
