import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import { uploadImage, uploadPdf, uploadVideo } from '../api/artifact';
import useCanvasStore from '../store/canvasStore';
import { useIntentStore } from '../store/intentStore';
import {
  detectNodeType,
  detectNodeTypeFromMime,
  looksLikeUrl,
  normalizeUrl,
  getImageDimensionsFromBlob,
} from '../utils/mediaUtils';
import { buildNode } from '../utils/nodeFactory';

import type { ReactFlowInstance } from '@xyflow/react';

// Marker written to the system clipboard when copying canvas nodes.
// If the system clipboard still contains this text on paste, we know
// the user hasn't copied anything else externally.
const CANVAS_CLIPBOARD_MARKER = '__sediment_canvas_copy__';

/**
 * Refs shared between Canvas rendering and this shortcut hook.
 */
export interface CanvasShortcutRefs {
  rfInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  mousePositionRef: MutableRefObject<{ x: number; y: number }>;
}

/**
 * All keyboard / paste handling for the canvas, extracted from Canvas.tsx.
 *
 * Registers:
 *  - global mousemove tracker (for paste-at-cursor)
 *  - keydown listener (z-order, delete, undo, redo, frame, copy, intent)
 *  - paste listener (internal clipboard → files → images → URLs → text)
 */
export function useCanvasShortcuts(refs: CanvasShortcutRefs): void {
  const { rfInstanceRef, mousePositionRef } = refs;

  const frameSelectedNodes = useCanvasStore((s) => s.frameSelectedNodes);
  const copySelectedNodes = useCanvasStore((s) => s.copySelectedNodes);
  const pasteNodes = useCanvasStore((s) => s.pasteNodes);
  const sendSelectedToOrder = useCanvasStore((s) => s.sendSelectedToOrder);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const dispatch = useCanvasStore((s) => s.dispatch);
  const addNode = useCanvasStore((s) => s.addNode);
  const layoutAll = useCanvasStore((s) => s.layoutAll);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);

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
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const type = file.type
          ? detectNodeTypeFromMime(file.type)
          : detectNodeType(file.name);
        const offset = i * 30;
        const pos = { x: basePos.x + offset, y: basePos.y + offset };

        try {
          if (type === 'image') {
            const [url, dims] = await Promise.all([
              uploadImage(file),
              getImageDimensionsFromBlob(file),
            ]);
            addNode(
              buildNode({
                type: 'image',
                position: pos,
                data: {
                  src: url,
                  label: file.name !== 'pasted-image' ? file.name : undefined,
                  origin: { type: 'user-pasted' },
                },
                naturalDimensions: dims,
              }),
            );
          } else if (type === 'video') {
            const url = await uploadVideo(file);
            addNode(
              buildNode({
                type: 'video',
                position: pos,
                data: {
                  src: url,
                  label: file.name,
                  origin: { type: 'user-pasted' },
                },
              }),
            );
          } else if (type === 'pdf') {
            const url = await uploadPdf(file);
            addNode(
              buildNode({
                type: 'pdf',
                position: pos,
                data: {
                  src: url,
                  label: file.name,
                  origin: { type: 'user-pasted' },
                },
              }),
            );
          }
        } catch (error) {
          console.error(`Failed to paste file ${file.name}:`, error);
        }
      }
    },
    [addNode],
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
        lines.forEach((line, i) => {
          const finalUrl = normalizeUrl(line.trim());
          const nodeType = detectNodeType(finalUrl);
          const offset = i * 30;
          addNode(
            buildNode({
              type: nodeType,
              position: { x: basePos.x + offset, y: basePos.y + offset },
              data: {
                src: finalUrl,
                origin: { type: 'user-pasted' },
              },
            }),
          );
        });
        return;
      }

      // Plain text → note node (label auto-derived by handleAddNode)
      addNode(
        buildNode({
          type: 'note',
          position: getFlowPos(),
          data: {
            content: trimmed,
            origin: { type: 'user-pasted' },
          },
        }),
      );
    },
    [addNode, getFlowPos],
  );

  // --- Track mouse position globally so paste can use it ---
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [mousePositionRef]);

  // --- Keyboard shortcuts (keydown) ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const mod = e.metaKey || e.ctrlKey;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();

      const isNativeInput = tag === 'input' || tag === 'textarea';
      const isRichEditor =
        target?.isContentEditable ||
        target?.getAttribute?.('role') === 'textbox';

      // [ and ] for z-order — no modifier required
      if ((key === '[' || key === '【') && !isNativeInput && !isRichEditor) {
        e.preventDefault();
        sendSelectedToOrder('bottom');
        return;
      }
      if ((key === ']' || key === '】') && !isNativeInput && !isRichEditor) {
        e.preventDefault();
        sendSelectedToOrder('top');
        return;
      }

      // Delete / Backspace — delete selected nodes and edges
      if (
        (key === 'Delete' || key === 'Backspace') &&
        !isNativeInput &&
        !isRichEditor
      ) {
        e.preventDefault();
        const { nodes: cur, edges: curEdges } = useCanvasStore.getState();
        const selectedNodeIds = cur.filter((n) => n.selected).map((n) => n.id);
        const selectedEdgeIds = curEdges
          .filter((edge) => edge.selected)
          .map((edge) => edge.id);
        if (selectedNodeIds.length > 0) {
          dispatch({ type: 'DELETE_NODES', nodeIds: selectedNodeIds });
        }
        if (selectedEdgeIds.length > 0) {
          dispatch({ type: 'DISCONNECT_EDGES', edgeIds: selectedEdgeIds });
        }
        return;
      }

      if (!mod || e.altKey) return;

      const lowerKey = key.toLowerCase();

      // Cmd/Ctrl+Shift+Z → redo (must come before the shift guard)
      if (lowerKey === 'z' && e.shiftKey) {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        redo();
        return;
      }

      // Cmd/Ctrl+Shift+L → layout all
      if (lowerKey === 'l' && e.shiftKey) {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        layoutAll();
        return;
      }

      // Cmd/Ctrl+Shift+A → toggle auto layout
      if (lowerKey === 'a' && e.shiftKey) {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        toggleAutoLayout();
        return;
      }

      // Remaining shortcuts require Cmd/Ctrl without Shift
      if (e.shiftKey) return;

      if (lowerKey === 'z') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        undo();
      } else if (lowerKey === 'g') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        frameSelectedNodes();
      } else if (lowerKey === 'c') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        copySelectedNodes();
        // Write marker to system clipboard so we can detect external copies later
        void navigator.clipboard
          .writeText(CANVAS_CLIPBOARD_MARKER)
          .catch(() => {
            // Clipboard API unavailable — internal clipboard still works
          });
      } else if (lowerKey === 'v') {
        if (isNativeInput || isRichEditor) return;

        const { clipboard } = useCanvasStore.getState();

        if (clipboard.length > 0) {
          // We have internal nodes. Check the marker asynchronously to
          // decide whether to paste nodes or external content.
          // Must preventDefault synchronously because we might need it.
          e.preventDefault();
          void (async () => {
            let sysText: string | null = null;
            try {
              sysText = await navigator.clipboard.readText();
            } catch {
              // Clipboard API denied — paste internal nodes
              pasteNodes(getFlowPos());
              return;
            }
            if (sysText === CANVAS_CLIPBOARD_MARKER) {
              // Marker intact — paste canvas nodes
              pasteNodes(getFlowPos());
            } else {
              // User copied something else — clear internal, paste external
              useCanvasStore.setState({ clipboard: [] });
              pasteText(sysText ?? '');
            }
          })();
          return;
        }

        // No internal clipboard. Don't preventDefault so the browser fires
        // the native 'paste' event which provides clipboardData with actual
        // file blobs (e.g. PDF from Finder). Native paste handler sets
        // pasteHandledRef. After a delay, Clipboard API fallback runs.
        pasteHandledRef.current = false;

        setTimeout(async () => {
          if (pasteHandledRef.current) return;

          // Try Clipboard API as fallback (when native paste doesn't fire)
          let sysText: string | null = null;
          try {
            sysText = await navigator.clipboard.readText();
          } catch {
            return;
          }

          if (!sysText || sysText === CANVAS_CLIPBOARD_MARKER) return;

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

          pasteText(sysText);
        }, 150);
      } else if (lowerKey === 'i') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        useIntentStore
          .getState()
          .triggerIntent(
            mousePositionRef.current.x,
            mousePositionRef.current.y,
          );
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    frameSelectedNodes,
    copySelectedNodes,
    pasteNodes,
    sendSelectedToOrder,
    undo,
    redo,
    dispatch,
    mousePositionRef,
    getFlowPos,
    pasteFiles,
    pasteText,
    layoutAll,
    toggleAutoLayout,
  ]);

  // --- Fallback: native paste event listener ---
  // Handles paste when the browser fires a native paste event (e.g. when an
  // element has focus). This catches cases where navigator.clipboard API
  // is not available (HTTP, permission denied).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (
        target?.isContentEditable ||
        target?.getAttribute?.('role') === 'textbox'
      )
        return;

      const dt = e.clipboardData;
      if (!dt) return;

      // Signal that native paste is handling it (prevents async fallback)
      pasteHandledRef.current = true;

      // Check if this is an internal canvas paste (marker text)
      const text = dt.getData('text/plain');
      const { clipboard } = useCanvasStore.getState();
      if (text === CANVAS_CLIPBOARD_MARKER && clipboard.length > 0) {
        e.preventDefault();
        pasteNodes(getFlowPos());
        return;
      }

      // Clear stale internal clipboard
      if (clipboard.length > 0) {
        useCanvasStore.setState({ clipboard: [] });
      }

      // Files
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
  }, [getFlowPos, pasteFiles, pasteText, pasteNodes]);
}
