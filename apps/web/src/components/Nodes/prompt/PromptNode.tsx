import { buildPromptNodeContext } from '@sediment/shared';
import { type Node, type NodeProps, useReactFlow } from '@xyflow/react';
import { clsx } from 'clsx';
import { toPng } from 'html-to-image';
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';

import { useTextAutoSize } from '@/hooks/useTextAutoSize';
import useCanvasStore, { getCachedSpatialData } from '@/store/canvasStore.ts';

import { NodeWrapper } from '../NodeWrapper';

import type { CanvasPromptNodeData } from '../types';

export type PromptNodeType = Node<CanvasPromptNodeData, 'prompt'>;

/** Padding inside the node (px). */
const NODE_PADDING = 12;

/**
 * Capture a screenshot of the entire React Flow viewport.
 * Returns a base64 data URL, or undefined if capture fails.
 */
async function captureViewportScreenshot(): Promise<string | undefined> {
  const viewport = document.querySelector(
    '.react-flow__viewport',
  ) as HTMLElement | null;
  if (!viewport) return undefined;
  try {
    return await toPng(viewport, { pixelRatio: 2 });
  } catch {
    return undefined;
  }
}

export const PromptNode = memo(
  ({ id, data, selected, width, height }: NodeProps<PromptNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const rfInstance = useReactFlow();

    const inputContent =
      data.input?.kind === 'text' ? (data.input.content ?? '') : '';
    const [draft, setDraft] = useState(inputContent);

    // Sync draft from external store changes (undo/redo).
    useEffect(() => {
      if (!isEditing) {
        setDraft(data.input?.kind === 'text' ? (data.input.content ?? '') : '');
      }
    }, [data.input, isEditing]);

    // ------------------------------------------------------------------
    // Text auto-sizing (shared with TextNode)
    // ------------------------------------------------------------------
    const fontOpts = useMemo(
      () => ({
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontWeight: 'normal',
        fontStyle: 'normal',
        lineHeight: 1.5,
      }),
      [],
    );

    const {
      hasFixedSize,
      effectiveFontSize,
      autoWidth,
      autoHeight,
      handleResizeStart,
      handleResize,
      handleResizeEnd,
    } = useTextAutoSize({
      nodeId: id,
      text: draft,
      baseFontSize: 16,
      padding: NODE_PADDING,
      fontOpts,
      placeholder: 'Ask a question...',
      width,
      height,
    });

    const status = data.status ?? 'idle';

    /** Status pin colour (maps to design tokens). */
    const STATUS_PIN: Record<
      string,
      { bg: string; ring: string; animate?: boolean }
    > = {
      idle: { bg: 'bg-fg-subtle', ring: 'ring-fg-subtle/40' },
      pending: {
        bg: 'bg-warning',
        ring: 'ring-warning-light/40',
        animate: true,
      },
      running: { bg: 'bg-info', ring: 'ring-info-light/40', animate: true },
      done: { bg: 'bg-success', ring: 'ring-success/30' },
      error: { bg: 'bg-danger', ring: 'ring-danger/30' },
    };
    const pin = STATUS_PIN[status] ?? STATUS_PIN.idle;

    /** Sticky-note warm background colour (design token). */
    const STICKY_BG = 'var(--prompt-bg)';
    const STICKY_BG_DARK = 'var(--prompt-border)';

    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        // If pending/running, cancel first
        if (status === 'pending') {
          patchNodeSilent(id, { status: 'idle', runAt: undefined });
        }
        setIsEditing(true);
        setTimeout(() => textareaRef.current?.focus(), 50);
      },
      [id, status, patchNodeSilent],
    );

    const handleBlur = useCallback(async () => {
      setIsEditing(false);

      const trimmed = draft.trim();
      const contentChanged = trimmed !== inputContent;

      // Commit input to store if changed.
      if (contentChanged) {
        updateNodeData(id, {
          input: { kind: 'text', content: trimmed },
        });
      }

      // Only compute spatial context + screenshot when content actually changed.
      if (!trimmed || !contentChanged) return;

      // ── Run expensive work in a microtask so blur itself is non-blocking ──
      queueMicrotask(() => {
        // ── Spatial context (from cache, O(1) when canvas hasn't moved) ──
        const { spatialNodes } = getCachedSpatialData();
        const target = spatialNodes.find((n) => n.id === id);
        if (!target) return;

        const nodes = useCanvasStore.getState().nodes;
        const edges = useCanvasStore.getState().edges;

        const snippets = new Map<string, string>();
        for (const n of nodes) {
          const d = n.data as Record<string, unknown> | undefined;
          const snippet =
            (d?.label as string) ??
            (d?.content as string)?.slice(0, 120) ??
            (d?.src as string) ??
            '';
          if (snippet) snippets.set(n.id, snippet);
        }

        const spatialContext = buildPromptNodeContext(
          target,
          spatialNodes,
          edges.map((e) => ({ source: e.source, target: e.target })),
          snippets,
        );

        // ── Screenshot (fire-and-forget, non-blocking) ──
        try {
          const internalNode = rfInstance.getInternalNode(id);
          if (internalNode) {
            const zoom = rfInstance.getZoom();
            const vp = rfInstance.getViewport();
            const container = document.querySelector('.react-flow');
            if (container) {
              const rect = container.getBoundingClientRect();
              const absPos = internalNode.internals.positionAbsolute;
              const screenX = absPos.x * zoom + vp.x;
              const screenY = absPos.y * zoom + vp.y;
              const nodeW = internalNode.measured?.width ?? 200;
              const nodeH = internalNode.measured?.height ?? 100;
              const inViewport =
                screenX + nodeW * zoom > 0 &&
                screenX < rect.width &&
                screenY + nodeH * zoom > 0 &&
                screenY < rect.height;
              if (inViewport) {
                captureViewportScreenshot().then((screenshot) => {
                  if (screenshot) {
                    patchNodeSilent(id, { screenshot });
                  }
                });
              }
            }
          }
        } catch {
          // Screenshot is best-effort — ignore errors.
        }

        // ── Dev-only logging ──
        if (import.meta.env.DEV) {
          console.group(
            `%c[PromptNode] Blur context for "${trimmed.slice(0, 40)}…"`,
            'color: #f59e0b; font-weight: bold',
          );
          console.log('Semantic position:', spatialContext.semanticPosition);
          console.log('Layers:', spatialContext.layers);
          console.log('Groups:', spatialContext.groups);
          console.log('Relevant edges:', spatialContext.relevantEdges);
          console.groupEnd();
        }
      });
    }, [draft, inputContent, id, updateNodeData, rfInstance, patchNodeSilent]);

    return (
      <NodeWrapper
        id={id}
        data={{ ...data, style: { ...data.style, backgroundColor: STICKY_BG } }}
        type={'prompt'}
        selected={selected}
        keepAspectRatio={false}
        allowOverflow
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        className="rounded-2xl transition-all duration-200"
      >
        {/* Sticky-note content */}
        <div
          className={clsx(
            'relative',
            hasFixedSize ? 'h-full w-full' : undefined,
          )}
          style={{
            padding: `${NODE_PADDING}px`,
            ...(autoWidth !== undefined
              ? { width: autoWidth, height: autoHeight }
              : undefined),
          }}
        >
          {/* Status pin circle — top-center, overlapping the edge */}
          <div
            className={clsx(
              'absolute -top-6 left-1/2 z-10 h-8 w-8 -translate-x-1/2 rounded-full ring-2',
              pin.bg,
              pin.ring,
              pin.animate && 'animate-pulse',
            )}
            title={`Status: ${status}`}
          />

          {/* Inner dashed border */}
          <div
            className="pointer-events-none absolute -inset-2 rounded-xl border-2 border-dashed"
            style={{ borderColor: STICKY_BG_DARK }}
          />

          {/* Input area */}
          {!isEditing && (
            <div
              className="absolute inset-0 z-2 cursor-grab"
              onDoubleClick={handleDoubleClick}
            />
          )}
          <textarea
            ref={textareaRef}
            className={clsx(
              'text-fg-default placeholder:text-fg-default/40 relative z-1 h-full w-full resize-none overflow-hidden bg-transparent text-sm font-medium outline-none',
              isEditing ? 'nodrag nowheel cursor-text' : 'pointer-events-none',
            )}
            placeholder="Ask a question..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            readOnly={!isEditing}
            style={{
              padding: '4px',
              border: 'none',
              fontSize: `${effectiveFontSize}px`,
              lineHeight: 1.5,
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          />
        </div>
      </NodeWrapper>
    );
  },
);
