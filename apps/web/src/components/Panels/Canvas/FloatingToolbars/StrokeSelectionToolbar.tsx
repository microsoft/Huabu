// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow, useStore } from '@xyflow/react';
import { ArrowUp, Ellipsis, Shapes, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
  getSelectionBounds,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
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
import { NODE_ICON } from '@/config/nodeIcons';
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
import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  rememberConversationAgentBinding,
  selectDefaultConversationProfileId,
  useAcpProfilesStore,
} from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadIsLoading,
  selectThreadLastAction,
  useChatStore,
} from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import './NodeToolbar.css';

import {
  InkAgentDestinationPicker,
  type InkAgentConversationOption,
} from './InkAgentDestinationPicker';
import {
  deriveInkSubmissionCandidate,
  groundingOperandsFromContext,
  inkLassoIdentity,
  inkSelectionIdentity,
  isViewportStableForBounds,
  retainedLassoBounds,
  resolveInkQuestionTarget,
  unionSelectionBounds,
} from './inkQuestionSubmission';
import {
  useInkConversationDestination,
  type InkDestination,
} from './useInkConversationDestination';

import type { CanvasSketchNodeData } from '@/components/Nodes/types';
import type { ChatSession } from '@/hooks/useChatSession';
import type {
  AgentMode,
  AgentBinding,
  AgentIcon,
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

function inkDestinationIdentity(
  destination: InkDestination,
  defaultProfileId: string | null,
): string {
  if (destination.kind === 'unresolved') return 'unresolved';
  if (destination.kind === 'continue')
    return JSON.stringify([
      'continue',
      destination.nodeId,
      destination.threadId,
    ]);
  const binding = destination.choice?.binding;
  const profileId = binding
    ? binding.kind === 'internal'
      ? 'huabu'
      : binding.profileId
    : defaultProfileId;
  const mode =
    destination.choice?.mode ?? (profileId === 'huabu' ? 'operate' : 'ask');
  return JSON.stringify(['new', profileId, mode]);
}

function isInkTargetBusy(nodeId: string): boolean {
  const node = useCanvasStore
    .getState()
    .nodes.find((entry) => entry.id === nodeId);
  const threadId = node?.data.threadId;
  const chat = useChatStore.getState();
  return (
    node?.data.status === 'running' ||
    (typeof threadId === 'string' &&
      (selectThreadIsLoading(chat, threadId) ||
        useCanvasStore.getState().pendingForkThreadIds[threadId] === true))
  );
}

/**
 * Floating toolbar for a Stage 2 stroke-level lasso selection. Aligns with
 * the sketch node's own controls: color + thickness edit the selected
 * strokes. Secondary actions live in the shared overflow menu, while desktop
 * also retains its keyboard Delete shortcut. Toolbar arbitration guarantees at
 * most one floating toolbar:
 *   - pure stroke selection → color + size + overflow, then Agent submit;
 *   - mixed (strokes + nodes) → overflow, then Agent submit, while
 *     style controls and node toolbars stay suppressed;
 *   - pure node selection → the node toolbars own the surface.
 */
export const StrokeSelectionToolbar = () => {
  const { t } = useTranslation();
  const { getViewport } = useReactFlow();
  const selecting = useStore((state) => state.userSelectionActive);
  // Subscribe to `nodes` so the anchor + representative style track edits.
  const nodes = useCanvasStore((s) => s.nodes);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const pendingForks = useCanvasStore((s) => s.pendingForkThreadIds);
  const addNode = useCanvasStore((s) => s.addNode);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const beginNodeDataGesture = useCanvasStore((s) => s.beginNodeDataGesture);
  const endNodeDataGesture = useCanvasStore((s) => s.endNodeDataGesture);
  const selection = useGesturePreviewStore((s) => s.sketchStrokeSelection);
  const selectionPolygon = useGesturePreviewStore(
    (s) => s.sketchSelectionPolygon,
  );
  const selectionSession = useGesturePreviewStore(
    (s) => s.sketchSelectionSession,
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
  const attemptsRef = useRef(new Map<string, InkSubmissionAttempt>());
  const attemptScopeRef = useRef({ canvasId, selectionSession });
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
  const chatState = useChatStore(
    useShallow((state) => {
      const values: Array<boolean | AgentBinding | AgentMode> = [];
      if (!hasSelection) return values;
      for (const node of nodes) {
        if (node.type !== 'question' || typeof node.data.threadId !== 'string')
          continue;
        values.push(
          selectThreadIsLoading(state, node.data.threadId),
          selectThreadBinding(state, node.data.threadId),
          selectThreadLastAction(state, node.data.threadId),
        );
      }
      return values;
    }),
  );
  const agentProfiles = useAcpProfilesStore((state) => state.profiles);
  const selectableProfileIds = useAcpProfilesStore(
    (state) => state.selectableProfileIds,
  );
  const profileError = useAcpProfilesStore((state) => state.error);
  const recentProfileId = useAcpProfilesStore(
    selectDefaultConversationProfileId,
  );
  const selectableProfiles = useMemo(
    () =>
      agentProfiles.filter((profile) =>
        selectableProfileIds.includes(profile.id),
      ),
    [agentProfiles, selectableProfileIds],
  );
  const defaultBinding = recentProfileId ? getDefaultAgentBinding() : null;
  const conversations = useMemo<InkAgentConversationOption[]>(() => {
    void chatState;
    void pendingForks;
    if (!hasSelection) return [];
    const chat = useChatStore.getState();
    return nodes
      .filter((node) => node.type === 'question')
      .map((node) => {
        const target = resolveInkQuestionTarget(node);
        const binding =
          target?.binding ??
          (target
            ? selectThreadBinding(chat, target.threadId)
            : ({ kind: 'internal' } as const));
        return {
          nodeId: node.id,
          title:
            typeof node.data.label === 'string' && node.data.label.trim()
              ? node.data.label
              : t('chat.newQuestion'),
          binding,
          mode:
            target?.mode ??
            (target ? selectThreadLastAction(chat, target.threadId) : 'ask'),
          fallbackIcon: node.data.agentIcon as AgentIcon | undefined,
          disabledReason: !target
            ? t('toolbar.inkAgentPicker.unavailable')
            : isInkTargetBusy(node.id)
              ? t('toolbar.inkAgentPicker.busy')
              : undefined,
        };
      });
  }, [nodes, chatState, pendingForks, hasSelection, t]);
  const {
    destination,
    loading: loadingDestination,
    confirming: confirmingDestination,
    error: destinationError,
    choose: chooseDestination,
    retryDefault,
  } = useInkConversationDestination({
    canvasId,
    hasSelection,
    selecting,
    selectionSession,
    conversations: conversations.map((conversation) => ({
      nodeId: conversation.nodeId,
      threadId: resolveInkQuestionTarget(
        nodes.find((node) => node.id === conversation.nodeId),
      )?.threadId,
      available: !conversation.disabledReason,
    })),
  });
  const selectedTargetId =
    destination.kind === 'continue' ? destination.nodeId : undefined;
  const candidate = useMemo(
    () => deriveInkSubmissionCandidate(nodes, selection, selectedTargetId),
    [nodes, selection, selectedTargetId],
  );
  const destinationIdentity = inkDestinationIdentity(
    destination,
    recentProfileId,
  );
  const destinationIdentityRef = useRef(destinationIdentity);
  destinationIdentityRef.current = destinationIdentity;
  const selectedConversation = conversations.find(
    (entry) => entry.nodeId === selectedTargetId,
  );
  const currentBinding =
    destination.kind === 'continue'
      ? (selectedConversation?.binding ?? null)
      : destination.kind === 'new'
        ? (destination.choice?.binding ?? defaultBinding)
        : null;
  const currentMode =
    destination.kind === 'continue'
      ? (selectedConversation?.mode ?? 'ask')
      : ((destination.kind === 'new' ? destination.choice?.mode : undefined) ??
        (currentBinding?.kind === 'internal' ? 'operate' : 'ask'));
  const unavailableReason =
    destination.kind === 'unresolved'
      ? loadingDestination
        ? t('toolbar.inkAgentPicker.loadingConversation')
        : destinationError
          ? t('toolbar.inkAgentPicker.loadFailed', {
              message: destinationError.message,
            })
          : t('toolbar.inkAgentPicker.chooseConversation')
      : destination.kind === 'continue'
        ? (selectedConversation?.disabledReason ??
          (!selectedConversation ||
          resolveInkQuestionTarget(
            nodes.find((node) => node.id === selectedTargetId),
          )?.threadId !== destination.threadId
            ? t('toolbar.inkAgentPicker.unavailable')
            : undefined))
        : destination.choice?.binding.kind === 'external' &&
            !selectableProfileIds.includes(destination.choice.binding.profileId)
          ? t('toolbar.inkAgentPicker.unavailable')
          : undefined;

  useEffect(() => {
    if (hasSelection && !useAcpProfilesStore.getState().loaded) {
      void useAcpProfilesStore.getState().init();
    }
    if (selecting) return;
    const previous = attemptScopeRef.current;
    if (
      !hasSelection ||
      previous.canvasId !== canvasId ||
      previous.selectionSession !== selectionSession
    ) {
      attemptsRef.current.clear();
    }
    attemptScopeRef.current = { canvasId, selectionSession };
  }, [hasSelection, selecting, selectionSession, canvasId]);

  const changeDestination = (next: InkDestination) => {
    if (preparationRef.current) return;
    if (next.kind === 'new' && next.choice) {
      rememberConversationAgentBinding(next.choice.binding);
    }
    destinationIdentityRef.current = inkDestinationIdentity(
      next,
      recentProfileId,
    );
    chooseDestination(next);
  };

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
    attemptsRef.current.clear();
    preparationRef.current = null;
    setInkSubmissionPreparing(false);
    setIsPreparing(false);
  }, [renderedLassoIdentity, setInkSubmissionPreparing]);
  const handleSubmit = useCallback(async () => {
    if (preparationRef.current) return;
    if (confirmingDestination) {
      toast(t('toolbar.inkAgentPicker.loadingConversation'), { tone: 'info' });
      return;
    }
    const canvas = useCanvasStore.getState();
    const strokeSelection =
      useGesturePreviewStore.getState().sketchStrokeSelection;
    const freshCandidate = deriveInkSubmissionCandidate(
      canvas.nodes,
      strokeSelection,
      selectedTargetId,
    );
    if (
      destination.kind === 'unresolved' ||
      (destination.kind === 'continue' &&
        (freshCandidate.kind !== 'ready' ||
          freshCandidate.target?.threadId !== destination.threadId)) ||
      freshCandidate.kind !== 'ready' ||
      (selectedTargetId && isInkTargetBusy(selectedTargetId))
    ) {
      toast(t('toolbar.inkAgentPicker.unavailable'), { tone: 'danger' });
      return;
    }
    const sourceIdentity = inkSelectionIdentity(
      canvas.canvasId,
      canvas.nodes,
      strokeSelection,
    );
    const identity = JSON.stringify([sourceIdentity, destinationIdentity]);
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
        excludeNodeIds: freshCandidate.excludedNodeIds,
      }),
    };
    const groundingOperands = groundingOperandsFromContext(
      capturedSources.canvasContext,
    );
    const preparationToken = {};
    const isCurrentAttempt = () =>
      preparationRef.current?.token === preparationToken &&
      destinationIdentityRef.current === destinationIdentity &&
      currentLassoIdentity() === lassoIdentity &&
      inkSelectionIdentity(
        useCanvasStore.getState().canvasId,
        useCanvasStore.getState().nodes,
        useGesturePreviewStore.getState().sketchStrokeSelection,
      ) === sourceIdentity;
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
      let attempt = attemptsRef.current.get(identity);
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
            !isViewportStableForBounds(viewport, currentViewport, sourceBounds)
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
        if (!isCurrentAttempt())
          throw new Error(t('toolbar.inkAgentPicker.changed'));
        if (freshCandidate.target) {
          if (isInkTargetBusy(freshCandidate.target.nodeId)) {
            throw new Error(t('toolbar.inkAgentPicker.busy'));
          }
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
          let binding: AgentBinding;
          if (destination.kind === 'new' && destination.choice) {
            await useAcpProfilesStore.getState().refresh();
            const profiles = useAcpProfilesStore.getState();
            if (profiles.error) throw profiles.error;
            binding = destination.choice.binding;
            if (
              binding.kind === 'external' &&
              !profiles.selectableProfileIds.includes(binding.profileId)
            ) {
              throw new Error(t('toolbar.inkAgentPicker.unavailable'));
            }
          } else {
            binding = await loadDefaultAgentBinding();
          }
          if (!isCurrentAttempt()) {
            throw new Error(
              'Canvas selection changed while preparing the Ink Agent. Submit again.',
            );
          }
          const selectedNodes = canvas.nodes.filter((node) =>
            freshCandidate.selectedNodeIds.includes(node.id),
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
          const placementPoint = computeAdjacentNodePlacement({
            nodes: canvas.nodes as NestableNode[],
            source: sourceBounds,
            nodeType: 'question',
            side: 'bottom',
          });
          const mode =
            destination.kind === 'new' && destination.choice
              ? destination.choice.mode
              : binding.kind === 'internal'
                ? 'operate'
                : 'ask';
          const created = createQuestionNode({
            addNode,
            placementPoint,
            canvasId: canvas.canvasId,
            binding,
            mode,
            label: 'New ink request',
            pendingInkIntentLabel: true,
          });
          attempt = {
            identity,
            mode,
            groundingVisual,
            session: {
              canvasId: canvas.canvasId,
              ownerCanvasId: canvas.canvasId,
              threadId: created.threadId,
              conversationView: created.conversationView,
            },
          };
        }
        attemptsRef.current.set(identity, attempt);
      }

      const prepared = prepareAgentTurn({
        session: attempt.session,
        inputKind: 'ink-intent',
        content: '',
        mode: attempt.mode,
        groundingVisual: attempt.groundingVisual,
        sources: capturedSources,
      });
      let dispatchInvalidReason: string | undefined;
      const result = await dispatchAgentTurn(prepared, {
        canDispatch: () => {
          if (!isCurrentAttempt()) {
            dispatchInvalidReason = t('toolbar.inkAgentPicker.changed');
            return false;
          }
          if (selectedTargetId) {
            const current = deriveInkSubmissionCandidate(
              useCanvasStore.getState().nodes,
              useGesturePreviewStore.getState().sketchStrokeSelection,
              selectedTargetId,
            );
            const eligible =
              current.kind === 'ready' &&
              current.target?.threadId === attempt.session.threadId &&
              !isInkTargetBusy(selectedTargetId);
            if (!eligible)
              dispatchInvalidReason = t('toolbar.inkAgentPicker.unavailable');
            return eligible;
          }
          return true;
        },
        onAccepted: () => {
          const stillCurrent =
            preparationRef.current?.token === preparationToken &&
            destinationIdentityRef.current === destinationIdentity &&
            currentLassoIdentity() === lassoIdentity;
          releasePreparation();
          if (!stillCurrent) return;
          attemptsRef.current.clear();
          clearSelection();
          useCanvasStore.getState().selectNodes([]);
        },
        onAcceptanceRejected: releasePreparation,
      });
      if (!result.accepted && result.error) {
        toast(result.error.message, { tone: 'danger' });
      } else if (!result.accepted && dispatchInvalidReason) {
        toast(dispatchInvalidReason, { tone: 'warning' });
      } else if (!result.accepted && result.status === 'busy') {
        toast(t('toolbar.inkAgentPicker.busy'), { tone: 'warning' });
      } else if (
        !result.accepted &&
        result.status === 'rejected' &&
        !isCurrentAttempt()
      ) {
        toast(t('toolbar.inkAgentPicker.changed'), { tone: 'warning' });
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
    confirmingDestination,
    currentLassoIdentity,
    getViewport,
    setInkSubmissionPreparing,
    destination,
    destinationIdentity,
    selectedTargetId,
    t,
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
  const selectionTypeLabel = t(
    isMixed ? 'toolbar.multipleSelectedObjects' : 'toolbar.inkSelection',
  );
  const InkIcon = NODE_ICON.sketch;
  const showSubmit = hasSelection;
  const open = hasSelection && anchor !== null && (showStyle || showSubmit);
  const submitDisabled =
    candidate.kind !== 'ready' ||
    confirmingDestination ||
    isPreparing ||
    Boolean(unavailableReason);
  const submitTitle = isPreparing
    ? t('toolbar.sendingInkRequest')
    : confirmingDestination
      ? t('toolbar.inkAgentPicker.loadingConversation')
      : (unavailableReason ??
        (candidate.kind === 'ready'
          ? t('toolbar.sendInkRequest')
          : t('toolbar.invalidQuestionTarget')));

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={open}
      offset={12}
      side="top"
      className="ink-context-toolbar"
    >
      <FloatingToolbar.Group
        className={`${FLOATING_TOOLBAR_CLASS} canvas-context-toolbar ink-toolbar-surface ink-edit-group`}
      >
        <Tooltip content={selectionTypeLabel}>
          <div
            role="img"
            aria-label={selectionTypeLabel}
            className="text-fg-subtle flex shrink-0 items-center px-1"
          >
            {isMixed ? <Shapes size={14} /> : <InkIcon size={14} />}
          </div>
        </Tooltip>
        <FloatingToolbar.Divider />
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
        {showStyle && <FloatingToolbar.Divider />}
        <DropdownMenu
          floating
          align="bottom-left"
          className="node-toolbar-overflow"
          trigger={
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={t('toolbar.more')}
            >
              <Ellipsis />
            </Button>
          }
        >
          <DropdownMenuItem
            icon={<Trash2 />}
            className="text-danger"
            onClick={handleDelete}
          >
            {t('actions.delete')}
          </DropdownMenuItem>
        </DropdownMenu>
      </FloatingToolbar.Group>
      {showSubmit && (
        <FloatingToolbar.Group
          className={`${FLOATING_TOOLBAR_CLASS} canvas-context-toolbar ink-toolbar-surface ink-agent-group min-w-0`}
        >
          <InkAgentDestinationPicker
            unresolved={destination.kind === 'unresolved'}
            loading={loadingDestination}
            binding={currentBinding}
            mode={currentMode}
            profiles={selectableProfiles}
            conversations={conversations}
            selectedNodeId={selectedTargetId}
            disabled={isPreparing}
            unavailableReason={
              destination.kind === 'unresolved' && !destinationError
                ? undefined
                : (unavailableReason ?? profileError?.message)
            }
            onNewConversation={(choice) =>
              changeDestination({ kind: 'new', choice })
            }
            onContinueConversation={(nodeId) => {
              const target = resolveInkQuestionTarget(
                useCanvasStore
                  .getState()
                  .nodes.find((node) => node.id === nodeId),
              );
              if (!target) {
                toast(t('toolbar.inkAgentPicker.unavailable'), {
                  tone: 'danger',
                });
                return;
              }
              changeDestination({
                kind: 'continue',
                nodeId,
                threadId: target.threadId,
              });
            }}
            onRefreshProfiles={() => {
              if (destinationError) retryDefault();
              return useAcpProfilesStore.getState().refresh();
            }}
          />
          <Button
            variant="solid"
            className="canvas-context-submit"
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
            {isPreparing ? <Square /> : <ArrowUp />}
          </Button>
        </FloatingToolbar.Group>
      )}
    </CanvasFloatingPopover>
  );
};
