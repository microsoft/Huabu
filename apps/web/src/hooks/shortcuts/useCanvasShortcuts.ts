// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import { EDIT_EDGE_LABEL_EVENT } from '@/components/Panels/Canvas/edges/LabelledEdge';

import { isEditableTarget } from './isEditableTarget';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNoteNodeInput,
  textToTextNodeInput,
} from '../../handler/canvasCommand/nodeInputBuilders';
import { isSnapSessionActive } from '../../handler/snap/snapSession';
import useCanvasStore from '../../store/canvasStore';
import { useGesturePreviewStore } from '../../store/gesturePreviewStore';
import {
  parseHuabuClipboard,
  readHuabuClipboardPayload,
  readHuabuClipboardPayloadAsync,
} from '../../utils/io/clipboard';
import { looksLikeUrl } from '../../utils/io/media';

import type { EditEdgeLabelDetail } from '@/components/Panels/Canvas/edges/LabelledEdge';
import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';

/**
 * Refs shared between Canvas rendering and this shortcut hook.
 */
export interface CanvasShortcutRefs {
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  mousePositionRef: MutableRefObject<{ x: number; y: number }>;
}

export interface UseCanvasShortcutsOptions {
  disabled?: boolean;
}

export type CanvasTool = 'select' | 'lasso' | 'pan';

function hasNativeCopySelection(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return (
      target.selectionStart !== null &&
      target.selectionEnd !== null &&
      target.selectionStart !== target.selectionEnd
    );
  }

  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed;
}

/**
 * All keyboard / paste handling for the canvas, extracted from Canvas.tsx.
 *
 * Registers:
 *  - global mousemove tracker (for paste-at-cursor)
 *  - keydown listener (z-order, delete, undo, redo, frame, copy, intent)
 *  - paste listener (internal clipboard → files → images → URLs → text)
 *  - Space key: temporarily switch to pan mode while held
 *
 * Returns `{ tool, setTool }` so Canvas can pass it to the toolbar.
 */
export function useCanvasShortcuts(
  refs: CanvasShortcutRefs,
  options: UseCanvasShortcutsOptions = {},
): {
  tool: CanvasTool;
  setTool: React.Dispatch<React.SetStateAction<CanvasTool>>;
} {
  const { rfInstanceRef, mousePositionRef } = refs;
  const { disabled = false } = options;

  const frameSelectedNodes = useCanvasStore((s) => s.frameSelectedNodes);
  const copySelectedNodes = useCanvasStore((s) => s.copySelectedNodes);
  const pasteNodes = useCanvasStore((s) => s.pasteNodes);
  const sendSelectedToOrder = useCanvasStore((s) => s.sendSelectedToOrder);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const disconnectEdges = useCanvasStore((s) => s.disconnectEdges);
  const addNodes = useCanvasStore((s) => s.addNodes);
  const addNode = useCanvasStore((s) => s.addNode);
  const canvasId = useCanvasStore((s) => s.canvasId);

  // --- Tool state (select / lasso / pan) ---
  const [tool, setTool] = useState<CanvasTool>('select');
  const previousToolRef = useRef<Exclude<CanvasTool, 'pan'>>('select');
  const temporaryPanRef = useRef(false);
  const temporaryPanPointerRef = useRef<number | null>(null);
  const temporaryPanMouseUpPendingRef = useRef(false);
  const spacePressedRef = useRef(false);

  useEffect(() => {
    if (tool !== 'pan') {
      previousToolRef.current = tool;
    }
  }, [tool]);

  // Space key: temporarily switch to pan mode while held
  useEffect(() => {
    if (disabled) return;

    const restoreTemporaryPan = () => {
      if (!temporaryPanRef.current) return;
      temporaryPanRef.current = false;
      temporaryPanPointerRef.current = null;
      temporaryPanMouseUpPendingRef.current = false;
      spacePressedRef.current = false;
      setTool((prev) => (prev === 'pan' ? previousToolRef.current : prev));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      // While a node drag is in flight, Space is reinterpreted as
      // "opt out of auto-reparent" by the snap session (it owns the
      // keydown listener for the duration of the drag). Skip the
      // pan-tool switch so the two interpretations don't fight.
      if (isSnapSessionActive()) return;
      spacePressedRef.current = true;
      setTool((prev) => {
        if (prev === 'pan') return prev;
        e.preventDefault();
        temporaryPanRef.current = true;
        return 'pan';
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      spacePressedRef.current = false;
      if (
        temporaryPanPointerRef.current === null &&
        !temporaryPanMouseUpPendingRef.current
      ) {
        restoreTemporaryPan();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!temporaryPanRef.current || e.button !== 0 || !e.isPrimary) return;
      temporaryPanPointerRef.current = e.pointerId;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (temporaryPanPointerRef.current !== e.pointerId) return;
      temporaryPanPointerRef.current = null;
      if (e.pointerType !== 'mouse') {
        if (!spacePressedRef.current) restoreTemporaryPan();
        return;
      }
      temporaryPanMouseUpPendingRef.current = true;
    };
    const onMouseUp = () => {
      if (!temporaryPanMouseUpPendingRef.current) return;
      temporaryPanMouseUpPendingRef.current = false;
      if (!spacePressedRef.current) restoreTemporaryPan();
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (temporaryPanPointerRef.current !== e.pointerId) return;
      restoreTemporaryPan();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') restoreTemporaryPan();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', restoreTemporaryPan);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', restoreTemporaryPan);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      restoreTemporaryPan();
    };
  }, [disabled]);

  // Prevents double-paste between native paste event and async Clipboard API.
  const pasteHandledRef = useRef(false);

  // --- Shared paste helpers ---
  const getFlowPos = useCallback(() => {
    const instance = rfInstanceRef.current;
    if (!instance) return { x: 0, y: 0 };
    return instance.screenToFlowPosition({
      x: mousePositionRef.current.x,
      y: mousePositionRef.current.y,
    });
  }, [rfInstanceRef, mousePositionRef]);

  /** Upload files and create nodes at the given position. */
  const pasteFiles = useCallback(
    async (files: File[], basePos: { x: number; y: number }) => {
      if (!canvasId) return;
      const inputs = (
        await Promise.all(
          files.map(async (file, index) => {
            const offset = index * 30;
            const pos = { x: basePos.x + offset, y: basePos.y + offset };
            const input = await uploadFileToNodeInput(
              file,
              pos,
              { type: 'user-pasted' },
              canvasId,
            );
            // Strip auto-label for screenshot pastes (browser gives generic name)
            if (input?.data && file.name === 'pasted-image') {
              delete input.data.label;
            }
            return input;
          }),
        )
      ).filter((input): input is AddNodeInput => input !== null);

      if (inputs.length > 0) {
        addNodes(inputs);
      }
    },
    [addNodes, canvasId],
  );

  /** Paste text content — auto-detect URLs vs plain text. */
  const pasteText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const lines = trimmed.split('\n').filter((l) => l.trim());
      const allUrls = lines.length > 0 && lines.every((l) => looksLikeUrl(l));

      if (allUrls) {
        const basePos = getFlowPos();
        addNodes(
          lines.map((line, index) => {
            const offset = index * 30;
            return urlToNodeInput(
              line.trim(),
              { x: basePos.x + offset, y: basePos.y + offset },
              { type: 'user-pasted' },
            );
          }),
        );
        return;
      }

      // Plain text → text node for short single-line snippets, otherwise
      // note node. Threshold: trim, no embedded newlines, length < 30.
      // Users can flip the type with one click via the node toolbar.
      const SHORT_TEXT_MAX_LENGTH = 30;
      const isShortSingleLine =
        !trimmed.includes('\n') && trimmed.length < SHORT_TEXT_MAX_LENGTH;
      const builder = isShortSingleLine
        ? textToTextNodeInput
        : textToNoteNodeInput;
      addNode(builder(trimmed, getFlowPos(), { type: 'user-pasted' }));
    },
    [addNode, addNodes, getFlowPos],
  );

  // --- Track mouse position globally so paste can use it ---
  useEffect(() => {
    if (disabled) return;

    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [disabled, mousePositionRef]);

  // --- Keyboard shortcuts (keydown) ---
  useEffect(() => {
    if (disabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const mod = e.metaKey || e.ctrlKey;
      const editable = isEditableTarget(e.target);

      // [ and ] for z-order — no modifier required
      if ((key === '[' || key === '【') && !editable) {
        e.preventDefault();
        sendSelectedToOrder('bottom');
        return;
      }
      if ((key === ']' || key === '】') && !editable) {
        e.preventDefault();
        sendSelectedToOrder('top');
        return;
      }

      // Delete / Backspace — delete selected nodes and edges
      if ((key === 'Delete' || key === 'Backspace') && !editable) {
        e.preventDefault();
        const { nodes: cur, edges: curEdges } = useCanvasStore.getState();
        // When a stroke-level sketch selection is active, StrokeSelectionToolbar
        // owns node + stroke deletion and folds both into one undo entry;
        // skip node deletion here so the same keypress doesn't push a second
        // snapshot. Edges (never part of a stroke lasso) are still handled.
        const hasStrokeSelection =
          Object.keys(useGesturePreviewStore.getState().sketchStrokeSelection)
            .length > 0;
        const selectedNodeIds = hasStrokeSelection
          ? []
          : cur.filter((n) => n.selected).map((n) => n.id);
        const selectedEdgeIds = curEdges
          .filter((edge) => edge.selected)
          .map((edge) => edge.id);
        if (selectedNodeIds.length > 0) {
          deleteNodes(selectedNodeIds);
        }
        if (selectedEdgeIds.length > 0) {
          disconnectEdges(selectedEdgeIds);
        }
        return;
      }

      // Enter — edit the selected edge's label. Canvas elements stay out of
      // the DOM tab order, so selection acts as the keyboard's focus and
      // Enter is the way to descend into it (same pattern as tldraw/FigJam).
      // Requires exactly one edge and no nodes selected, so the target is
      // unambiguous.
      if (key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !editable) {
        const { nodes: cur, edges: curEdges } = useCanvasStore.getState();
        if (cur.some((n) => n.selected)) return;
        const selectedEdges = curEdges.filter((edge) => edge.selected);
        if (selectedEdges.length !== 1) return;
        e.preventDefault();
        const detail: EditEdgeLabelDetail = { edgeId: selectedEdges[0].id };
        window.dispatchEvent(
          new CustomEvent<EditEdgeLabelDetail>(EDIT_EDGE_LABEL_EVENT, {
            detail,
          }),
        );
        return;
      }

      if (!mod || e.altKey) return;

      const lowerKey = key.toLowerCase();

      // Cmd/Ctrl+Shift+Z → redo (must come before the shift guard)
      if (lowerKey === 'z' && e.shiftKey) {
        if (editable) return;
        e.preventDefault();
        redo();
        return;
      }

      // Cmd/Ctrl + '=' / '+' → zoom in (Shift+= produces '+' on US layouts).
      // Cmd/Ctrl + '-' / '_' → zoom out. Accept both forms so users don't
      // have to think about whether Shift is involved. preventDefault stops
      // the browser from zooming the whole page instead of the canvas.
      if (key === '=' || key === '+') {
        if (editable) return;
        e.preventDefault();
        rfInstanceRef.current?.zoomIn({ duration: 200 });
        return;
      }
      if (key === '-' || key === '_') {
        if (editable) return;
        e.preventDefault();
        rfInstanceRef.current?.zoomOut({ duration: 200 });
        return;
      }

      // Remaining shortcuts require Cmd/Ctrl without Shift
      if (e.shiftKey) return;

      if (lowerKey === 'z') {
        if (editable) return;
        e.preventDefault();
        undo();
      } else if (lowerKey === 'g') {
        if (editable) return;
        e.preventDefault();
        frameSelectedNodes();
      } else if (lowerKey === 'c') {
        // Editors can retain focus after their node is selected. Preserve
        // native copy only when the user has an actual text selection;
        // otherwise copy the selected Canvas nodes.
        if (hasNativeCopySelection(e.target)) return;
        e.preventDefault();
        copySelectedNodes();
      } else if (lowerKey === 'v') {
        if (editable) return;

        // Don't preventDefault — let the browser fire the native 'paste'
        // event so we can access clipboardData (files, images, etc.).
        // The native paste handler does all the work.
        // A setTimeout fallback covers the case where no native paste fires.
        pasteHandledRef.current = false;

        setTimeout(async () => {
          if (pasteHandledRef.current) return;

          // Native paste didn't fire — use Clipboard API as fallback
          try {
            const sysPayload = await readHuabuClipboardPayloadAsync();

            // Check for serialized canvas nodes
            const parsed = parseHuabuClipboard(sysPayload);
            if (parsed) {
              pasteNodes(
                getFlowPos(),
                parsed.nodes as Node[],
                parsed.edges as Edge[],
                parsed.srcCanvasId,
              );
              return;
            }

            // Try images via clipboard.read()
            try {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                const imgType = item.types.find((t) => t.startsWith('image/'));
                if (imgType) {
                  const blob = await item.getType(imgType);
                  const file = new File([blob], 'pasted-image', {
                    type: imgType,
                  });
                  await pasteFiles([file], getFlowPos());
                  return;
                }
              }
            } catch {
              // clipboard.read() not available
            }

            // Plain text / URLs
            const trimmed = sysPayload?.trim();
            if (trimmed) {
              pasteText(trimmed);
            }
          } catch {
            // Clipboard API denied
          }
        }, 150);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    disabled,
    frameSelectedNodes,
    copySelectedNodes,
    pasteNodes,
    sendSelectedToOrder,
    undo,
    redo,
    deleteNodes,
    disconnectEdges,
    mousePositionRef,
    getFlowPos,
    pasteFiles,
    pasteText,
    rfInstanceRef,
  ]);

  // --- Native paste event listener ---
  // Handles paste when the browser fires a native paste event, which gives
  // access to clipboardData (files, images, etc.).
  useEffect(() => {
    if (disabled) return;

    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;

      const dt = e.clipboardData;
      if (!dt) return;

      // Signal that native paste is handling it (prevents async fallback)
      pasteHandledRef.current = true;

      const text = dt.getData('text/plain');

      // Check for serialized canvas nodes. Single-image copies carry the
      // payload in `text/html` and keep `text/plain` human-readable, so the
      // payload has to be read through the helper rather than from `text`.
      const parsed = parseHuabuClipboard(readHuabuClipboardPayload(dt));
      if (parsed) {
        e.preventDefault();
        pasteNodes(
          getFlowPos(),
          parsed.nodes as Node[],
          parsed.edges as Edge[],
          parsed.srcCanvasId,
        );
        return;
      }

      // Files (e.g. dragged from Finder)
      const files = Array.from(dt.files);
      if (files.length > 0) {
        e.preventDefault();
        void pasteFiles(files, getFlowPos());
        return;
      }

      // Image item
      const imageItem = Array.from(dt.items).find((item) =>
        item.type.startsWith('image/'),
      );
      if (imageItem) {
        const blob = imageItem.getAsFile();
        if (blob) {
          e.preventDefault();
          const file = new File([blob], 'pasted-image', {
            type: imageItem.type,
          });
          void pasteFiles([file], getFlowPos());
          return;
        }
      }

      // Text (URLs or plain text)
      const trimmed = text?.trim();
      if (!trimmed) return;
      e.preventDefault();
      pasteText(trimmed);
    };

    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [disabled, getFlowPos, pasteFiles, pasteText, pasteNodes]);

  return { tool, setTool };
}
