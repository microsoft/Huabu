import { buildPromptNodeContext } from '@sediment/shared';
import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  Check,
  Clock,
  Loader,
  MessageSquare,
  Pencil,
  Play,
  Square,
  X,
} from 'lucide-react';
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { Tooltip } from '@/components/Common/Tooltip.tsx';
import { useTextAutoSize } from '@/hooks/useTextAutoSize';
import useCanvasStore, { getCachedSpatialData } from '@/store/canvasStore.ts';
import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';

import { NodeWrapper } from '../NodeWrapper';

import type { CanvasPromptNodeData } from '../types';

export type PromptNodeType = Node<CanvasPromptNodeData, 'prompt'>;

/** Padding inside the node (px). */
const NODE_PADDING = 12;

/**
 * Yield control to the browser via MessageChannel.
 * Unlike setTimeout(0) which has a ≥4 ms clamped delay,
 * MessageChannel fires as the next macrotask with no minimum delay.
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(undefined);
  });
}

export const PromptNode = memo(
  ({ id, data, selected, width, height }: NodeProps<PromptNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const processingRef = useRef<AbortController>();

    const inputContent =
      data.input?.kind === 'text' ? (data.input.content ?? '') : '';
    const [draft, setDraft] = useState(inputContent);

    // Focus textarea when entering edit mode, cursor at end.
    useEffect(() => {
      if (isEditing) {
        // Wait for the next frame so readOnly/pointer-events are updated.
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          const len = ta.value.length;
          ta.selectionStart = len;
          ta.selectionEnd = len;
        });
      }
    }, [isEditing]);

    // Sync draft from external store changes (undo/redo).
    useEffect(() => {
      if (!isEditing) {
        setDraft(data.input?.kind === 'text' ? (data.input.content ?? '') : '');
      }
    }, [data.input, isEditing]);

    // Abort any in-flight blur processing on unmount.
    useEffect(() => () => processingRef.current?.abort(), []);

    // ------------------------------------------------------------------
    // Text auto-sizing (shared with TextNode)
    // ------------------------------------------------------------------
    const fontOpts = useMemo(
      () => ({
        fontFamily: '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
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
    const viewed = data.viewed ?? false;

    /** Sticky-note warm background colour (design token). */
    const STICKY_BG = 'var(--prompt-bg)';

    // ------------------------------------------------------------------
    // Countdown seconds for pending label
    // ------------------------------------------------------------------
    const [countdownSecs, setCountdownSecs] = useState(0);

    useEffect(() => {
      if (status !== 'pending' || !data.runAt) {
        setCountdownSecs(0);
        return;
      }
      const tick = () => {
        const remaining = Math.max(0, (data.runAt ?? 0) - Date.now());
        setCountdownSecs(Math.ceil(remaining / 1000));
      };
      tick();
      const interval = setInterval(tick, 500);
      return () => clearInterval(interval);
    }, [status, data.runAt]);

    /** Whether this node has been executed at least once. */
    const hasRun = status === 'done' || status === 'error';

    // ------------------------------------------------------------------
    // Open prompt thread in chat panel
    // ------------------------------------------------------------------
    const openPromptThread = useChatStore((s) => s.openPromptThread);
    const requestOpenRightPanel = usePanelStore((s) => s.requestOpenRightPanel);

    const openInChat = useCallback(() => {
      if (!data.threadId) return;
      openPromptThread(id, data.threadId);
      requestOpenRightPanel();
      // Mark as viewed (persisted via autosave, no undo entry).
      if (!data.viewed) {
        patchNodeSilent(id, { viewed: true });
      }
    }, [
      id,
      data.threadId,
      data.viewed,
      openPromptThread,
      requestOpenRightPanel,
      patchNodeSilent,
    ]);

    // ------------------------------------------------------------------
    // Double-click: edit (idle/pending) or open chat (done/error)
    // ------------------------------------------------------------------
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();

        // After execution, double-click opens the conversation in chat panel
        if (hasRun && data.threadId) {
          openInChat();
          return;
        }

        // Before execution: enter edit mode
        processingRef.current?.abort();
        if (status === 'pending') {
          patchNodeSilent(id, { status: 'idle', runAt: undefined });
        }
        setIsEditing(true);
      },
      [id, status, hasRun, data.threadId, patchNodeSilent, openInChat],
    );

    // ------------------------------------------------------------------
    // Toolbar
    // ------------------------------------------------------------------
    const promptToolbar = useMemo(
      () => (
        <>
          {/* Edit prompt (before execution) or View conversation (after execution) */}
          {hasRun && data.threadId ? (
            <FloatingToolbar.ActionButton
              title="View conversation"
              onClick={openInChat}
            >
              <MessageSquare size={14} />
            </FloatingToolbar.ActionButton>
          ) : status !== 'running' && status !== 'pending' ? (
            <FloatingToolbar.ActionButton
              title="Edit prompt"
              onClick={() => {
                processingRef.current?.abort();
                setIsEditing(true);
              }}
            >
              <Pencil size={14} />
            </FloatingToolbar.ActionButton>
          ) : null}

          {/* Cancel — only when pending/running */}
          {(status === 'pending' || status === 'running') && (
            <>
              <FloatingToolbar.Divider />
              <FloatingToolbar.ActionButton
                title="Cancel"
                onClick={() => {
                  processingRef.current?.abort();
                  patchNodeSilent(id, { status: 'idle', runAt: undefined });
                }}
              >
                <Square size={14} />
              </FloatingToolbar.ActionButton>
            </>
          )}

          {/* Run now — only when pending */}
          {status === 'pending' && (
            <FloatingToolbar.ActionButton
              title="Run now"
              onClick={() => patchNodeSilent(id, { runAt: Date.now() })}
            >
              <Play size={14} />
            </FloatingToolbar.ActionButton>
          )}
        </>
      ),
      [id, status, hasRun, data.threadId, patchNodeSilent, openInChat],
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

      // Cancel any in-flight pipeline from a prior blur.
      processingRef.current?.abort();
      const controller = new AbortController();
      processingRef.current = controller;
      const { signal } = controller;

      // ── Async pipeline: yield to the browser (MessageChannel) between
      //    each step so the main thread stays responsive. ──

      const t0 = performance.now();

      // Step 1: compute spatial context
      await yieldToMain();
      if (signal.aborted) return;

      const tYield1 = performance.now();

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

      buildPromptNodeContext(
        target,
        spatialNodes,
        edges.map((e) => ({ source: e.source, target: e.target })),
        snippets,
      );

      const tSpatial = performance.now();

      // Step 2: set pending (triggers React re-render in a new macrotask)
      await yieldToMain();
      if (signal.aborted) return;

      const tYield2 = performance.now();

      const delay = (data.autoRunDelay as number | undefined) ?? 10;
      patchNodeSilent(id, {
        status: 'pending',
        runAt: Date.now() + delay * 1000,
      });

      const tPending = performance.now();

      if (import.meta.env.DEV) {
        const fmt = (ms: number) => `${ms.toFixed(1)}ms`;
        console.log(
          `%c[PromptNode] Blur pipeline timing:
  yield1 (wait):     ${fmt(tYield1 - t0)}
  spatialContext:     ${fmt(tSpatial - tYield1)}
  yield2 (wait):     ${fmt(tYield2 - tSpatial)}
  patchPending:      ${fmt(tPending - tYield2)}
  ─────────────────
  TOTAL:             ${fmt(tPending - t0)}`,
          'color: #f59e0b; font-weight: bold',
        );
      }
    }, [
      draft,
      inputContent,
      id,
      data.autoRunDelay,
      updateNodeData,
      patchNodeSilent,
    ]);

    const isDoneUnviewed = status === 'done' && !viewed;

    return (
      <NodeWrapper
        id={id}
        data={{ ...data, style: { ...data.style, backgroundColor: STICKY_BG } }}
        type={'prompt'}
        selected={selected}
        toolbar={promptToolbar}
        keepAspectRatio={false}
        allowOverflow
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        className={clsx(
          'prompt-sticky rounded-2xl transition-all duration-200',
          isDoneUnviewed && 'prompt-node-done-unviewed',
        )}
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
          {/* Status pill badge (top-left) */}
          {status !== 'idle' &&
            (() => {
              const isViewed = status === 'done' && viewed;
              const cfg = {
                pending: {
                  icon: Clock,
                  label:
                    countdownSecs > 0
                      ? `Starts in ${countdownSecs}s`
                      : 'Pending',
                  iconBg: 'var(--warning)',
                  pillBg: 'color-mix(in srgb, var(--warning) 10%, white 20%))',
                  pillFg: 'var(--warning)',
                },
                running: {
                  icon: Loader,
                  label: 'Running',
                  iconBg: 'var(--info)',
                  pillBg: 'color-mix(in srgb, var(--info) 10%, white 20%))',
                  pillFg: 'var(--info)',
                },
                done: {
                  icon: Check,
                  label: isViewed ? 'Done' : 'Done',
                  iconBg: 'var(--success)',
                  pillBg: 'color-mix(in srgb, var(--success) 10%, white 20%)',
                  pillFg: 'var(--success)',
                  glow: !isViewed,
                },
                error: {
                  icon: X,
                  label: 'Error',
                  iconBg: 'var(--danger)',
                  pillBg: 'color-mix(in srgb, var(--danger) 10%, white 20%)',
                  pillFg: 'var(--danger)',
                },
              }[status];
              if (!cfg) return null;
              const Icon = cfg.icon;
              const hasGlow = 'glow' in cfg && cfg.glow;

              const badgeAnimation =
                status === 'error'
                  ? 'prompt-badge-shake 0.5s ease-in-out'
                  : undefined;

              const iconAnimation =
                status === 'running'
                  ? 'prompt-icon-spin 4s linear infinite'
                  : undefined;

              const badge = (
                <div
                  className="absolute -top-8 -left-1 z-10 flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 shadow-sm"
                  style={{
                    backgroundColor: cfg.pillBg,
                    color: cfg.pillFg,
                    ...(hasGlow && {
                      boxShadow: `0 0 8px 3px color-mix(in srgb, var(--success) 45%, transparent)`,
                    }),
                    ...(badgeAnimation && { animation: badgeAnimation }),
                  }}
                >
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-full"
                    style={{ backgroundColor: cfg.iconBg }}
                  >
                    <Icon
                      size={20}
                      color="white"
                      style={
                        iconAnimation ? { animation: iconAnimation } : undefined
                      }
                    />
                  </div>
                  <span className="text-lg font-semibold">{cfg.label}</span>
                </div>
              );
              if (status === 'error' && data.errorMessage) {
                return <Tooltip content={data.errorMessage}>{badge}</Tooltip>;
              }
              return badge;
            })()}

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
              'placeholder:text-fg-default/40 relative z-1 h-full w-full resize-none overflow-hidden bg-transparent outline-none',
              isEditing ? 'nodrag nowheel cursor-text' : 'pointer-events-none',
            )}
            placeholder="Ask a question..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            readOnly={!isEditing}
            style={{
              padding: 0,
              border: 'none',
              color: 'var(--prompt-fg)',
              fontFamily:
                '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive',
              fontWeight: 'normal',
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
