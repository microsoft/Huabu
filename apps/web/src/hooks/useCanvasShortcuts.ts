import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import useCanvasStore from '../store/canvasStore';
import { useIntentStore } from '../store/intentStore';
import { looksLikeUrl } from '../utils/io/media';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNodeInput,
} from '../utils/io/nodeInputBuilders';

import type { AddNodeInput } from '../canvas/uiIntent';
import type { ReactFlowInstance } from '@xyflow/react';

/** Returns true when the target is an editable element (input/textarea/contentEditable). */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  return (
    el?.isContentEditable || el?.getAttribute?.('role') === 'textbox' || false
  );
}

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

export interface UseCanvasShortcutsOptions {
  disabled?: boolean;
}

export type CanvasTool = 'select' | 'pan';

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
  const layoutAll = useCanvasStore((s) => s.layoutAll);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);

  // --- Tool state (select / pan) ---
  const [tool, setTool] = useState<CanvasTool>('select');

  // Space key: temporarily switch to pan mode while held
  useEffect(() => {
    if (disabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      setTool((prev) => {
        if (prev === 'pan') return prev;
        e.preventDefault();
        return 'pan';
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      setTool((prev) => (prev === 'pan' ? 'select' : prev));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
      const inputs = (
        await Promise.all(
          files.map(async (file, index) => {
            const offset = index * 30;
            const pos = { x: basePos.x + offset, y: basePos.y + offset };
            const input = await uploadFileToNodeInput(file, pos, {
              type: 'user-pasted',
            });
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
    [addNodes],
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

      // Plain text → note node (label auto-derived by CREATE_NODES)
      addNode(textToNodeInput(trimmed, getFlowPos(), { type: 'user-pasted' }));
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
        const selectedNodeIds = cur.filter((n) => n.selected).map((n) => n.id);
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

      if (!mod || e.altKey) return;

      const lowerKey = key.toLowerCase();

      // Cmd/Ctrl+Shift+Z → redo (must come before the shift guard)
      if (lowerKey === 'z' && e.shiftKey) {
        if (editable) return;
        e.preventDefault();
        redo();
        return;
      }

      // Cmd/Ctrl+Shift+L → layout all
      if (lowerKey === 'l' && e.shiftKey) {
        if (editable) return;
        e.preventDefault();
        layoutAll();
        return;
      }

      // Cmd/Ctrl+Shift+A → toggle auto layout
      if (lowerKey === 'a' && e.shiftKey) {
        if (editable) return;
        e.preventDefault();
        toggleAutoLayout();
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
        if (editable) return;
        e.preventDefault();
        copySelectedNodes();
        // Write marker to system clipboard so we can detect external copies later
        void navigator.clipboard
          .writeText(CANVAS_CLIPBOARD_MARKER)
          .catch(() => {
            // Clipboard API unavailable — internal clipboard still works
          });
      } else if (lowerKey === 'v') {
        if (editable) return;

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
        if (editable) return;
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
    layoutAll,
    toggleAutoLayout,
  ]);

  // --- Fallback: native paste event listener ---
  // Handles paste when the browser fires a native paste event (e.g. when an
  // element has focus). This catches cases where navigator.clipboard API
  // is not available (HTTP, permission denied).
  useEffect(() => {
    if (disabled) return;

    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;

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
  }, [disabled, getFlowPos, pasteFiles, pasteText, pasteNodes]);

  return { tool, setTool };
}
