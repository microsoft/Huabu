import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import { isEditableTarget } from './isEditableTarget';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNoteNodeInput,
  textToTextNodeInput,
} from '../../handler/canvasCommand/nodeInputBuilders';
import { isSnapSessionActive } from '../../handler/snap/snapSession';
import useCanvasStore from '../../store/canvasStore';
import { useIntentStore } from '../../store/intentStore';
import { parseSedimentClipboard } from '../../utils/io/clipboard';
import { looksLikeUrl } from '../../utils/io/media';

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

  useEffect(() => {
    if (tool !== 'pan') {
      previousToolRef.current = tool;
    }
  }, [tool]);

  // Space key: temporarily switch to pan mode while held
  useEffect(() => {
    if (disabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      // While a node drag is in flight, Space is reinterpreted as
      // "opt out of auto-reparent" by the snap session (it owns the
      // keydown listener for the duration of the drag). Skip the
      // pan-tool switch so the two interpretations don't fight.
      if (isSnapSessionActive()) return;
      setTool((prev) => {
        if (prev === 'pan') return prev;
        e.preventDefault();
        return 'pan';
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      setTool((prev) => (prev === 'pan' ? previousToolRef.current : prev));
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
        if (editable) return;
        // If the user has selected text (e.g. in a panel), let the browser
        // handle the native copy instead of overwriting the clipboard with
        // serialized node data.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
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
            const sysText = await navigator.clipboard.readText();

            // Check for serialized canvas nodes
            const parsed = parseSedimentClipboard(sysText);
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
            const trimmed = sysText?.trim();
            if (trimmed) {
              pasteText(trimmed);
            }
          } catch {
            // Clipboard API denied
          }
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

      // Check for serialized canvas nodes
      const parsed = parseSedimentClipboard(text);
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
