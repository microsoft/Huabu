// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow } from '@xyflow/react';
import { ArrowUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getSelectionBounds,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Spinner } from '@/components/Common/Spinner';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import { computeAdjacentNodePlacement } from '@/components/Nodes/nodePlacement';
import { createQuestionNode } from '@/components/Nodes/question/questionCompose';
import { SketchControls } from '@/components/Nodes/sketch/SketchControls';
import { getSketchStrokeSelectionBounds } from '@/components/Nodes/sketch/sketchHitTest';
import {
  buildEraseCommands,
  commitStrokeCommands,
} from '@/components/Nodes/sketch/sketchMerge';
import {
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from '@/components/Nodes/sketch/sketchPath';
import {
  blobToDataUrl,
  captureVisibleCanvasGrounding,
} from '@/handler/canvasCommand/utils/screenshot';
import {
  dispatchAgentTurn,
  prepareAgentTurn,
} from '@/hooks/agentTurnController';
import { isOutsideCanvasInteraction } from '@/hooks/shortcuts/isEditableTarget';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadLastAction,
  useChatStore,
} from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { resolveQuestionAgentPresentation } from '@/utils/questionAgentPresentation';

import './NodeToolbar.css';

import {
  deriveInkSubmissionCandidate,
  groundingOperandsFromContext,
  inkLassoIdentity,
  inkSelectionIdentity,
  retainedLassoBounds,
  unionSelectionBounds,
} from './inkQuestionSubmission';

import type { CanvasSketchNodeData } from '@/components/Nodes/types';
import type { ChatSession } from '@/hooks/useChatSession';
import type {
  AgentMode,
  CanvasCommand,
  CanvasNodeId,
  SketchStroke,
  VisibleCanvasGrounding,
} from '@huabu/shared';

interface InkSubmissionAttempt {
  identity: string;
  session: ChatSession;
  mode: AgentMode;
  groundingVisual?: VisibleCanvasGrounding;
}

/**
 * Floating toolbar for a Stage 2 stroke-level lasso selection. Aligns with
 * the sketch node's own controls: color + thickness edit the selected
 * strokes. Delete is **touch-only** (desktop uses the keyboard). Toolbar
 * arbitration guarantees at most one floating toolbar:
 *   - pure stroke selection → color + size (+ delete on touch) + submit;
 *   - mixed (strokes + nodes) → submit metadata (+ delete on touch), while
 *     style controls and node toolbars stay suppressed;
 *   - pure node selection → the node toolbars own the surface.
 */
export const StrokeSelectionToolbar = () => {
  const { t } = useTranslation();
  const { getViewport } = useReactFlow();
  // Subscribe to `nodes` so the anchor + representative style track edits.
  const nodes = useCanvasStore((s) => s.nodes);
  const addNode = useCanvasStore((s) => s.addNode);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const beginNodeDataGesture = useCanvasStore((s) => s.beginNodeDataGesture);
  const endNodeDataGesture = useCanvasStore((s) => s.endNodeDataGesture);
  const selection = useGesturePreviewStore((s) => s.sketchStrokeSelection);
  const selectionPolygon = useGesturePreviewStore(
    (s) => s.sketchSelectionPolygon,
  );
  const selectionMove = useGesturePreviewStore(
    (s) => s.sketchStrokeMovePreview,
  );
  const clearSelection = useGesturePreviewStore(
    (s) => s.clearSketchStrokeSelection,
  );
  const setInkSubmissionPreparing = useGesturePreviewStore(
    (s) => s.setInkSubmissionPreparing,
  );
  const isNotMouse = useIsNotMouse();
  const attemptRef = useRef<InkSubmissionAttempt | null>(null);
  const preparationRef = useRef<{
    token: object;
    lassoIdentity: string;
  } | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);

  const hasSelection = Object.keys(selection).length > 0;
  const hasNodeSelection = nodes.some((n) => n.selected);
  const isMixed = hasSelection && hasNodeSelection;

  const strokeBounds = useMemo(() => {
    if (!hasSelection) return null;
    void nodes; // recompute as sketches move / resize
    return getSketchStrokeSelectionBounds(selection);
  }, [selection, hasSelection, nodes]);
  const anchor = useMemo(
    () => retainedLassoBounds(selectionPolygon, selectionMove) ?? strokeBounds,
    [selectionMove, selectionPolygon, strokeBounds],
  );
  const candidate = useMemo(
    () => deriveInkSubmissionCandidate(nodes, selection),
    [nodes, selection],
  );
  const targetThreadId =
    candidate.kind === 'ready' ? candidate.target?.threadId : undefined;
  const cachedTargetBinding = useChatStore((state) =>
    targetThreadId ? selectThreadBinding(state, targetThreadId) : null,
  );
  const cachedTargetMode = useChatStore((state) =>
    targetThreadId ? selectThreadLastAction(state, targetThreadId) : null,
  );
  const agentProfiles = useAcpProfilesStore((state) => state.profiles);

  const currentLassoIdentity = useCallback(
    () =>
      inkLassoIdentity(
        useCanvasStore.getState().canvasId,
        useGesturePreviewStore.getState().sketchStrokeSelection,
        useGesturePreviewStore.getState().sketchSelectionPolygon,
      ),
    [],
  );
  const renderedLassoIdentity = inkLassoIdentity(
    useCanvasStore.getState().canvasId,
    selection,
    selectionPolygon,
  );
  useEffect(() => {
    const active = preparationRef.current;
    if (!active || active.lassoIdentity === renderedLassoIdentity) return;
    attemptRef.current = null;
    preparationRef.current = null;
    setInkSubmissionPreparing(false);
    setIsPreparing(false);
  }, [renderedLassoIdentity, setInkSubmissionPreparing]);
  const handleSubmit = useCallback(async () => {
    if (preparationRef.current) return;
    const canvas = useCanvasStore.getState();
    const strokeSelection =
      useGesturePreviewStore.getState().sketchStrokeSelection;
    const freshCandidate = deriveInkSubmissionCandidate(
      canvas.nodes,
      strokeSelection,
    );
    if (freshCandidate.kind !== 'ready') return;
    const identity = inkSelectionIdentity(
      canvas.canvasId,
      canvas.nodes,
      strokeSelection,
    );
    const lassoIdentity = inkLassoIdentity(
      canvas.canvasId,
      strokeSelection,
      useGesturePreviewStore.getState().sketchSelectionPolygon,
    );
    const capturedSources = {
      canvasId: canvas.canvasId,
      canvasContext: canvas.getAgentChatContext({
        nodeIds: freshCandidate.selectedNodeIds,
        strokeSelection: freshCandidate.strokeSelection,
        excludeNodeIds: freshCandidate.target
          ? [freshCandidate.target.nodeId]
          : undefined,
      }),
    };
    const groundingOperands = groundingOperandsFromContext(
      capturedSources.canvasContext,
    );
    const preparationToken = {};
    preparationRef.current = {
      token: preparationToken,
      lassoIdentity,
    };
    setInkSubmissionPreparing(true);
    setIsPreparing(true);
    const releasePreparation = () => {
      if (preparationRef.current?.token !== preparationToken) return;
      preparationRef.current = null;
      setInkSubmissionPreparing(false);
      setIsPreparing(false);
    };
    let retainReservation = false;
    try {
      let attempt =
        attemptRef.current?.identity === identity ? attemptRef.current : null;
      if (!attempt) {
        let groundingVisual: VisibleCanvasGrounding | undefined;
        const groundingNodeIds = groundingOperands.selectedNodeIds;
        if (groundingNodeIds.length > 0) {
          const ordinaryNodeIds = new Set(groundingNodeIds);
          const selectedNodes = canvas.nodes.filter((node) =>
            ordinaryNodeIds.has(node.id),
          );
          const nodeBounds = getSelectionBounds(selectedNodes, canvas.nodes);
          const currentStrokeBounds =
            getSketchStrokeSelectionBounds(strokeSelection);
          const sourceBounds = unionSelectionBounds(
            currentStrokeBounds,
            nodeBounds
              ? {
                  x: nodeBounds.minX,
                  y: nodeBounds.minY,
                  width: nodeBounds.width,
                  height: nodeBounds.height,
                }
              : null,
          );
          if (!sourceBounds) return;
          const viewport = getViewport();
          const captured = await captureVisibleCanvasGrounding({
            bounds: {
              x: sourceBounds.x * viewport.zoom + viewport.x,
              y: sourceBounds.y * viewport.zoom + viewport.y,
              width: sourceBounds.width * viewport.zoom,
              height: sourceBounds.height * viewport.zoom,
            },
          });
          const currentViewport = getViewport();
          if (
            currentLassoIdentity() !== lassoIdentity ||
            currentViewport.x !== viewport.x ||
            currentViewport.y !== viewport.y ||
            currentViewport.zoom !== viewport.zoom
          ) {
            throw new Error(
              'Canvas view changed during Ink grounding capture. Submit again.',
            );
          }
          const dataUrl = await blobToDataUrl(captured.blob);
          groundingVisual = {
            kind: 'visible-canvas',
            dataUrl,
            viewport: {
              x: viewport.x,
              y: viewport.y,
              zoom: viewport.zoom,
              width: captured.viewport.width,
              height: captured.viewport.height,
              devicePixelRatio: captured.devicePixelRatio,
            },
            crop: captured.crop,
            selectedNodeIds: groundingNodeIds,
            strokeSubsets: groundingOperands.strokeSubsets,
          };
        }
        if (freshCandidate.target) {
          const { nodeId, threadId, mode } = freshCandidate.target;
          attempt = {
            identity,
            mode:
              mode ?? selectThreadLastAction(useChatStore.getState(), threadId),
            groundingVisual,
            session: {
              canvasId: canvas.canvasId,
              ownerCanvasId: canvas.canvasId,
              threadId,
              conversationView: {
                presentationAnchor: { canvasId: canvas.canvasId, nodeId },
                conversationOwner: {
                  canvasId: canvas.canvasId,
                  nodeId,
                  threadId,
                },
              },
            },
          };
        } else {
          const selectedNodes = canvas.nodes.filter((node) => node.selected);
          const nodeBounds = getSelectionBounds(selectedNodes, canvas.nodes);
          const currentStrokeBounds =
            getSketchStrokeSelectionBounds(strokeSelection);
          const sourceBounds = unionSelectionBounds(
            currentStrokeBounds,
            nodeBounds
              ? {
                  x: nodeBounds.minX,
                  y: nodeBounds.minY,
                  width: nodeBounds.width,
                  height: nodeBounds.height,
                }
              : null,
          );
          if (!sourceBounds) return;
          const placementPoint = computeAdjacentNodePlacement({
            nodes: canvas.nodes as NestableNode[],
            source: sourceBounds,
            nodeType: 'question',
            side: 'bottom',
          });
          const created = createQuestionNode({
            addNode,
            placementPoint,
            canvasId: canvas.canvasId,
            binding: { kind: 'internal' },
            mode: 'operate',
            label: 'New ink request',
            pendingInkIntentLabel: true,
          });
          attempt = {
            identity,
            mode: 'operate',
            groundingVisual,
            session: {
              canvasId: canvas.canvasId,
              ownerCanvasId: canvas.canvasId,
              threadId: created.threadId,
              conversationView: created.conversationView,
            },
          };
        }
        attemptRef.current = attempt;
      }

      const prepared = prepareAgentTurn({
        session: attempt.session,
        inputKind: 'ink-intent',
        content: '',
        mode: attempt.mode,
        groundingVisual: attempt.groundingVisual,
        sources: capturedSources,
      });
      const result = await dispatchAgentTurn(prepared, {
        canDispatch: () => currentLassoIdentity() === lassoIdentity,
        onAccepted: () => {
          releasePreparation();
          if (currentLassoIdentity() !== lassoIdentity) return;
          attemptRef.current = null;
          clearSelection();
          useCanvasStore.getState().selectNodes([]);
        },
        onAcceptanceRejected: releasePreparation,
      });
      if (!result.accepted && result.error) {
        toast(result.error.message, { tone: 'danger' });
      }
      retainReservation = result.status === 'unknown' && !result.accepted;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), {
        tone: 'danger',
      });
    } finally {
      if (!retainReservation) releasePreparation();
    }
  }, [
    addNode,
    clearSelection,
    currentLassoIdentity,
    getViewport,
    setInkSubmissionPreparing,
  ]);

  // Representative color / size for the swatches: the first selected stroke.
  const { color, size } = useMemo(() => {
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      const node = nodes.find((n) => n.id === nodeId);
      const strokes = (node?.data as CanvasSketchNodeData | undefined)?.strokes;
      if (!strokes) continue;
      const idSet = new Set(strokeIds);
      const first = strokes.find((s) => idSet.has(s.id));
      if (first) {
        return {
          color: first.color ?? DEFAULT_STROKE_COLOR,
          size: first.size ?? DEFAULT_STROKE_SIZE,
        };
      }
    }
    return { color: DEFAULT_STROKE_COLOR, size: DEFAULT_STROKE_SIZE };
  }, [selection, nodes]);

  // Apply a per-stroke patch (color / size) to only the selected strokes.
  const patchSelected = useCallback(
    (patch: Partial<SketchStroke>) => {
      const patches: Extract<
        CanvasCommand,
        { type: 'MERGE_NODE_DATA' }
      >['patches'] = [];
      for (const [nodeId, strokeIds] of Object.entries(selection)) {
        const node = nodes.find((n) => n.id === nodeId);
        const strokes = (node?.data as CanvasSketchNodeData | undefined)
          ?.strokes;
        if (!strokes) continue;
        const idSet = new Set(strokeIds);
        patches.push({
          nodeId: nodeId as CanvasNodeId,
          patch: {
            strokes: strokes.map((s) =>
              idSet.has(s.id) ? { ...s, ...patch } : s,
            ),
          },
        });
      }
      if (patches.length > 0) {
        executeCommands([{ type: 'MERGE_NODE_DATA', patches }]);
      }
    },
    [selection, nodes, executeCommands],
  );

  const handleDelete = useCallback(() => {
    const strokeCommands: CanvasCommand[] = [];
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      if (strokeIds.length === 0) continue;
      strokeCommands.push(
        ...buildEraseCommands(nodeId as CanvasNodeId, new Set(strokeIds)),
      );
    }
    // Whole nodes the same lasso also selected are removed TOGETHER with the
    // strokes, as a single undo entry (mirrors the mixed stroke-move
    // gesture). Sketch nodes are never whole-node selected, so these are the
    // non-sketch members of a mixed selection.
    const selectedNodeIds = useCanvasStore
      .getState()
      .nodes.filter((n) => n.selected)
      .map((n) => n.id);
    clearSelection();
    if (selectedNodeIds.length > 0) {
      // Node delete takes its own snapshot + records the intent trace; fold
      // the stroke erase into that SAME undo entry.
      deleteNodes(selectedNodeIds);
      commitStrokeCommands(strokeCommands, { foldIntoOpenGesture: true });
    } else {
      commitStrokeCommands(strokeCommands);
    }
  }, [selection, clearSelection, deleteNodes]);

  // Keyboard delete: the delete button is touch-only, so desktop deletes
  // the stroke selection via Delete / Backspace. Coexists with React Flow's
  // node delete (a mixed selection removes both on one press).
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isOutsideCanvasInteraction(e.target)) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      ) {
        return;
      }
      handleDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection, handleDelete]);

  const showStyle = !isMixed; // style controls only for a pure stroke selection
  const showDelete = isNotMouse; // delete button is touch-only
  const showSubmit =
    candidate.kind === 'ready' || candidate.reason !== 'no-ink';
  const open =
    hasSelection && anchor !== null && (showStyle || showDelete || showSubmit);
  const submitDisabled = candidate.kind !== 'ready' || isPreparing;
  const submitTitle = isPreparing
    ? t('toolbar.sendingInkRequest')
    : candidate.kind === 'ready'
      ? t('toolbar.sendInkRequest')
      : candidate.reason === 'multiple-question-targets'
        ? t('toolbar.multipleQuestionTargets')
        : t('toolbar.invalidQuestionTarget');
  const agentTargetHint = useMemo(() => {
    if (candidate.kind === 'blocked') {
      if (candidate.reason === 'no-ink') return null;
      return candidate.reason === 'multiple-question-targets'
        ? {
            label: t('toolbar.multipleInkAgentTargets'),
            description: t('toolbar.multipleQuestionTargets'),
          }
        : {
            label: t('toolbar.invalidInkAgentTarget'),
            description: t('toolbar.invalidQuestionTarget'),
          };
    }
    if (!candidate.target) {
      return {
        label: t('toolbar.newInkAgentTarget'),
        description: t('toolbar.newInkAgentTargetDescription'),
      };
    }
    const presentation = resolveQuestionAgentPresentation({
      binding:
        candidate.target.binding ??
        cachedTargetBinding ??
        ({ kind: 'internal' } as const),
      profiles: agentProfiles,
      agentMode: candidate.target.mode ?? cachedTargetMode ?? 'ask',
    });
    return {
      label: presentation.alias,
      description: t('toolbar.inkAgentTarget', {
        name: presentation.alias,
      }),
    };
  }, [agentProfiles, cachedTargetBinding, cachedTargetMode, candidate, t]);

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={open}
      offset={12}
      side="top"
      className={`${FLOATING_TOOLBAR_CLASS} canvas-context-toolbar`}
    >
      {showStyle && (
        <SketchControls
          floating
          colorTriggerClassName="node-toolbar-color"
          color={color}
          size={size}
          touch={isNotMouse}
          onColorChange={(c) => patchSelected({ color: c })}
          onSizeChange={(s) => patchSelected({ size: s })}
          onSizeDragStart={beginNodeDataGesture}
          onSizeDragEnd={endNodeDataGesture}
        />
      )}
      {showStyle && showDelete && <FloatingToolbar.Divider />}
      {showDelete && (
        <FloatingToolbar.ActionButton
          title={t('toolbar.deleteSelected')}
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          <Trash2 />
        </FloatingToolbar.ActionButton>
      )}
      {(showStyle || showDelete) && showSubmit && <FloatingToolbar.Divider />}
      {showSubmit && (
        <>
          <span
            className="text-fg-subtle px-1 text-xs tabular-nums"
            aria-label={t('toolbar.inkSourceCount', {
              count: candidate.sourceCount,
            })}
          >
            {candidate.sourceCount}{' '}
            {t('chat.sourceLabel', { count: candidate.sourceCount })}
          </span>
          {agentTargetHint && (
            <Tooltip content={agentTargetHint.description}>
              <span
                className="text-fg-muted inline-block max-w-28 min-w-0 truncate px-1 text-xs"
                aria-label={agentTargetHint.description}
                role="status"
              >
                {agentTargetHint.label}
              </span>
            </Tooltip>
          )}
          <Button
            variant="solid"
            className="canvas-context-submit"
            shape="pill"
            iconOnly
            size="sm"
            type="button"
            title={isPreparing ? undefined : submitTitle}
            aria-label={submitTitle}
            disabled={submitDisabled}
            onClick={(event) => {
              event.stopPropagation();
              void handleSubmit();
            }}
          >
            {isPreparing ? <Spinner size="xs" /> : <ArrowUp />}
          </Button>
        </>
      )}
    </CanvasFloatingPopover>
  );
};
