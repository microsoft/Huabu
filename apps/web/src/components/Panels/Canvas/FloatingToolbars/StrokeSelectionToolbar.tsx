// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useReactFlow, useStore } from '@xyflow/react';
import { ArrowUp, Ellipsis, Shapes, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
  getSelectionBounds,
  inkSigilLayout,
  MAX_INK_RESOURCE_REFERENCES,
  projectInkResourceBindings,
  selectedInkResourceReferences,
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
import { NODE_ICON } from '@/config/nodeIcons';
import {
  blobToDataUrl,
  prepareVisibleCanvasGrounding,
  type PreparedVisibleCanvasGrounding,
} from '@/handler/canvasCommand/utils/screenshot';
import {
  dispatchAgentTurn,
  prepareAgentTurn,
  type CapturedAgentTurnSources,
} from '@/hooks/agentTurnController';
import { isOutsideCanvasInteraction } from '@/hooks/shortcuts/isEditableTarget';
import { useIsNotMouse } from '@/hooks/useInputMode';
import {
  getDefaultAgentBinding,
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
import { useInkSigilStore } from '@/store/inkSigilStore';

import './NodeToolbar.css';

import {
  InkAgentDestinationPicker,
  type InkAgentConversationOption,
  type InkAgentDestinationIssue,
} from './InkAgentDestinationPicker';
import {
  deriveInkSubmissionCandidate,
  canReceiveInk,
  groundingOperandsFromContext,
  inkLassoIdentity,
  inkSelectionIdentity,
  retainedLassoBounds,
  resolveInkQuestionTarget,
  unionSelectionBounds,
  type InkQuestionTarget,
} from './inkQuestionSubmission';
import {
  useInkConversationDestination,
  type InkDestination,
} from './useInkConversationDestination';

import type { CanvasSketchNodeData } from '@/components/Nodes/types';
import type { ChatSession } from '@/hooks/useChatSession';
import type {
  AgentMode,
  AgentInputKind,
  AgentBinding,
  AgentIcon,
  CanvasCommand,
  CanvasNodeId,
  SketchStroke,
  VisibleCanvasGrounding,
  InkResourceReference,
} from '@huabu/shared';

interface InkSubmissionAttempt {
  identity: string;
  inputKind: AgentInputKind;
  session: ChatSession;
  mode: AgentMode;
  sources: CapturedAgentTurnSources;
  groundingVisual?: VisibleCanvasGrounding;
  inkResources?: InkResourceReference[];
  pendingGrounding?: {
    snapshot: PreparedVisibleCanvasGrounding;
    viewport: { x: number; y: number; zoom: number };
    selectedNodeIds: string[];
    strokeSubsets: Array<{ nodeId: string; strokeIds: string[] }>;
  };
}

function disposePendingGrounding(attempt: InkSubmissionAttempt): void {
  attempt.pendingGrounding?.snapshot.dispose();
  delete attempt.pendingGrounding;
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

function inkTargetAgent(target: InkQuestionTarget) {
  const chat = useChatStore.getState();
  return {
    binding: target.binding ?? selectThreadBinding(chat, target.threadId),
    mode: target.mode ?? selectThreadLastAction(chat, target.threadId),
  };
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
 *   - pure node lasso → overflow + Agent submit; ordinary node clicks retain
 *     their node toolbars.
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
  const selectionSessionIdsRef = useRef({
    next: 1,
    values: new WeakMap<object, number>(),
  });
  const mountedRef = useRef(true);
  const preparationRef = useRef<{ token: object } | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [startedDestination, setStartedDestination] = useState<{
    nodeId: string;
    threadId: string;
  } | null>(null);

  const hasStrokes = Object.keys(selection).length > 0;
  const hasNodeSelection = nodes.some((n) => n.selected);
  const hasSelection =
    hasStrokes || (selectionPolygon !== null && hasNodeSelection);
  const isMixed = hasStrokes && hasNodeSelection;
  const pendingSigil = useInkSigilStore((state) => state.pending);
  const sigilSelection = useMemo(
    () =>
      selectedInkResourceReferences(
        projectInkResourceBindings(nodes),
        selection,
      ),
    [nodes, selection],
  );
  const sigilIssue = pendingSigil
    ? t('sigil.finishBinding')
    : sigilSelection.brokenCount
      ? t('sigil.brokenSelection')
      : sigilSelection.references.length > MAX_INK_RESOURCE_REFERENCES
        ? t('sigil.tooMany')
        : undefined;

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
  const conversations = useMemo<
    (InkAgentConversationOption & {
      threadId?: string;
      inkCompatible: boolean;
    })[]
  >(() => {
    void chatState;
    void pendingForks;
    if (!hasSelection) return [];
    return nodes
      .filter((node) => node.type === 'question')
      .map((node) => {
        const target = resolveInkQuestionTarget(node);
        const { binding, mode } = target
          ? inkTargetAgent(target)
          : { binding: { kind: 'internal' } as const, mode: 'ask' as const };
        return {
          nodeId: node.id,
          threadId: target?.threadId,
          inkCompatible: !target || canReceiveInk({ binding, mode }),
          title:
            typeof node.data.label === 'string' && node.data.label.trim()
              ? node.data.label
              : t('chat.newQuestion'),
          binding,
          mode,
          fallbackIcon: node.data.agentIcon as AgentIcon | undefined,
          disabledReason:
            !target || !canReceiveInk({ binding, mode })
              ? {
                  kind: 'unavailable',
                  message: t('toolbar.inkAgentPicker.unavailable'),
                }
              : isInkTargetBusy(node.id)
                ? { kind: 'busy', message: t('toolbar.inkAgentPicker.busy') }
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
      threadId: conversation.threadId,
      available: !conversation.disabledReason,
      inkCompatible: conversation.inkCompatible,
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
  const unavailableReason: InkAgentDestinationIssue | undefined =
    destination.kind === 'unresolved'
      ? {
          kind: 'unavailable',
          message: loadingDestination
            ? t('toolbar.inkAgentPicker.loadingConversation')
            : destinationError
              ? t('toolbar.inkAgentPicker.loadFailed', {
                  message: destinationError.message,
                })
              : t('toolbar.inkAgentPicker.chooseConversation'),
        }
      : destination.kind === 'continue'
        ? !selectedConversation ||
          resolveInkQuestionTarget(
            nodes.find((node) => node.id === selectedTargetId),
          )?.threadId !== destination.threadId
          ? {
              kind: 'unavailable',
              message: t('toolbar.inkAgentPicker.unavailable'),
            }
          : selectedConversation.disabledReason
        : destination.choice?.binding.kind === 'external' &&
            !selectableProfileIds.includes(destination.choice.binding.profileId)
          ? {
              kind: 'unavailable',
              message: t('toolbar.inkAgentPicker.unavailable'),
            }
          : undefined;
  const isOwnSubmission =
    isPreparing &&
    destination.kind === 'continue' &&
    startedDestination?.nodeId === destination.nodeId &&
    startedDestination.threadId === destination.threadId;
  const compatibleConversations = conversations.filter(
    (conversation) => conversation.inkCompatible,
  );
  const pickerConversations = isOwnSubmission
    ? compatibleConversations.map((conversation) =>
        conversation.nodeId === startedDestination.nodeId &&
        conversation.disabledReason?.kind === 'busy'
          ? { ...conversation, disabledReason: undefined }
          : conversation,
      )
    : compatibleConversations;
  const pickerIssue =
    isOwnSubmission && unavailableReason?.kind === 'busy'
      ? undefined
      : unavailableReason;

  useEffect(() => {
    if (hasSelection && !useAcpProfilesStore.getState().loaded) {
      void useAcpProfilesStore.getState().init();
    }
  }, [hasSelection]);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const changeDestination = (next: InkDestination) => {
    if (preparationRef.current) return;
    if (next.kind === 'new' && next.choice) {
      rememberConversationAgentBinding(next.choice.binding);
    }
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
    const sigilProjections = projectInkResourceBindings(canvas.nodes);
    const selectedSigils = selectedInkResourceReferences(
      sigilProjections,
      strokeSelection,
    );
    if (
      useInkSigilStore.getState().pending ||
      selectedSigils.brokenCount ||
      selectedSigils.references.length > MAX_INK_RESOURCE_REFERENCES
    ) {
      toast(
        t(
          useInkSigilStore.getState().pending
            ? 'sigil.finishBinding'
            : selectedSigils.brokenCount
              ? 'sigil.brokenSelection'
              : 'sigil.tooMany',
        ),
        { tone: 'danger' },
      );
      return;
    }
    let selectionSessionId: number | null = null;
    if (selectionSession) {
      const sessionIds = selectionSessionIdsRef.current;
      selectionSessionId = sessionIds.values.get(selectionSession) ?? null;
      if (selectionSessionId === null) {
        selectionSessionId = sessionIds.next;
        sessionIds.next += 1;
        sessionIds.values.set(selectionSession, selectionSessionId);
      }
    }
    const identity = JSON.stringify([
      sourceIdentity,
      destinationIdentity,
      selectionSessionId,
    ]);
    const lassoIdentity = inkLassoIdentity(
      canvas.canvasId,
      strokeSelection,
      useGesturePreviewStore.getState().sketchSelectionPolygon,
    );
    const preparationToken = {};
    const isCurrentAttempt = () =>
      preparationRef.current?.token === preparationToken;
    preparationRef.current = { token: preparationToken };
    setInkSubmissionPreparing(true);
    setIsPreparing(true);
    let interactionReserved = true;
    const releaseInteractionReservation = () => {
      if (!interactionReserved) return;
      interactionReserved = false;
      setInkSubmissionPreparing(false);
    };
    const releasePreparation = () => {
      if (preparationRef.current?.token !== preparationToken) return;
      preparationRef.current = null;
      setStartedDestination(null);
      releaseInteractionReservation();
      setIsPreparing(false);
    };
    let retainReservation = false;
    try {
      for (const [attemptIdentity, previous] of attemptsRef.current) {
        if (attemptIdentity === identity || !previous.pendingGrounding)
          continue;
        disposePendingGrounding(previous);
        attemptsRef.current.delete(attemptIdentity);
      }
      let attempt = attemptsRef.current.get(identity);
      if (!attempt) {
        const capturedSources = {
          canvasId: canvas.canvasId,
          canvasContext: canvas.getAgentChatContext({
            nodeIds: freshCandidate.selectedNodeIds,
            strokeSelection: freshCandidate.strokeSelection,
            excludeNodeIds: freshCandidate.excludedNodeIds,
            lasso: true,
          }),
        };
        const groundingOperands = groundingOperandsFromContext(
          capturedSources.canvasContext,
        );
        const groundingNodeIds = groundingOperands.selectedNodeIds;
        const ordinaryNodeIds = new Set(groundingNodeIds);
        const selectedNodes = canvas.nodes.filter((node) =>
          ordinaryNodeIds.has(node.id),
        );
        const nodeBounds = getSelectionBounds(selectedNodes, canvas.nodes);
        const currentStrokeBounds =
          getSketchStrokeSelectionBounds(strokeSelection);
        let sourceBounds = unionSelectionBounds(
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
        const includedSigilIds = new Set(
          selectedSigils.references.map((reference) => reference.id),
        );
        for (const projection of sigilProjections) {
          if (includedSigilIds.has(projection.binding.id)) {
            const annotation = document.querySelector<HTMLElement>(
              `[data-ink-sigil="${CSS.escape(projection.binding.id)}"]`,
            );
            const width = Number(annotation?.dataset.inkSigilLabelWidth);
            const height = Number(annotation?.dataset.inkSigilLabelHeight);
            if (
              !annotation ||
              !Number.isFinite(width) ||
              width <= 0 ||
              !Number.isFinite(height) ||
              height <= 0
            ) {
              throw new Error(t('sigil.unavailable'));
            }
            const label = annotation.querySelector<HTMLElement>(
              '[data-ink-sigil-label]',
            );
            if (!label) throw new Error(t('sigil.unavailable'));
            const labelStyle = getComputedStyle(label);
            if (
              document.fonts &&
              !document.fonts.check(
                `${labelStyle.fontSize} ${labelStyle.fontFamily}`,
                projection.label,
              )
            ) {
              throw new Error(t('sigil.fontsUnavailable'));
            }
            sourceBounds = unionSelectionBounds(
              sourceBounds,
              inkSigilLayout(projection.bounds, width, height).semanticBounds,
            );
          }
        }
        if (!sourceBounds) {
          throw new Error(t('toolbar.invalidQuestionTarget'));
        }
        let pendingGrounding: InkSubmissionAttempt['pendingGrounding'];
        try {
          if (
            freshCandidate.inputKind === 'ink-intent' &&
            (groundingNodeIds.length > 0 ||
              selectedSigils.references.length > 0)
          ) {
            const viewport = getViewport();
            pendingGrounding = {
              snapshot: prepareVisibleCanvasGrounding({
                bounds: {
                  x: sourceBounds.x * viewport.zoom + viewport.x,
                  y: sourceBounds.y * viewport.zoom + viewport.y,
                  width: sourceBounds.width * viewport.zoom,
                  height: sourceBounds.height * viewport.zoom,
                },
              }),
              viewport,
              selectedNodeIds: groundingNodeIds,
              strokeSubsets: groundingOperands.strokeSubsets,
            };
          }
          if (freshCandidate.target) {
            if (!canReceiveInk(inkTargetAgent(freshCandidate.target))) {
              throw new Error(t('toolbar.inkAgentPicker.unavailable'));
            }
            if (isInkTargetBusy(freshCandidate.target.nodeId)) {
              throw new Error(t('toolbar.inkAgentPicker.busy'));
            }
            const { nodeId, threadId } = freshCandidate.target;
            attempt = {
              identity,
              inputKind: freshCandidate.inputKind,
              mode: inkTargetAgent(freshCandidate.target).mode,
              pendingGrounding,
              sources: capturedSources,
              inkResources: selectedSigils.references,
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
            const binding =
              destination.kind === 'new' && destination.choice
                ? destination.choice.binding
                : getDefaultAgentBinding();
            const profiles = useAcpProfilesStore.getState();
            if (
              binding.kind === 'external' &&
              !profiles.selectableProfileIds.includes(binding.profileId)
            ) {
              throw new Error(t('toolbar.inkAgentPicker.unavailable'));
            }
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
            if (!canReceiveInk({ binding, mode })) {
              throw new Error(t('toolbar.inkAgentPicker.unavailable'));
            }
            const created = createQuestionNode({
              addNode,
              placementPoint,
              canvasId: canvas.canvasId,
              binding,
              mode,
              label:
                freshCandidate.inputKind === 'ink-intent'
                  ? 'New ink request'
                  : 'New selection request',
              pendingInkIntentLabel: true,
            });
            attempt = {
              identity,
              inputKind: freshCandidate.inputKind,
              mode,
              pendingGrounding,
              sources: capturedSources,
              inkResources: selectedSigils.references,
              session: {
                canvasId: canvas.canvasId,
                ownerCanvasId: canvas.canvasId,
                threadId: created.threadId,
                conversationView: created.conversationView,
              },
            };
          }
        } catch (error) {
          pendingGrounding?.snapshot.dispose();
          throw error;
        }
        attemptsRef.current.set(identity, attempt);
      }
      releaseInteractionReservation();
      if (attempt.pendingGrounding && !attempt.groundingVisual) {
        const pendingGrounding = attempt.pendingGrounding;
        let captured: Awaited<
          ReturnType<PreparedVisibleCanvasGrounding['capture']>
        >;
        try {
          captured = await pendingGrounding.snapshot.capture();
        } catch (error) {
          if (!mountedRef.current) {
            disposePendingGrounding(attempt);
            attemptsRef.current.delete(identity);
          }
          throw error;
        }
        const dataUrl = await blobToDataUrl(captured.blob);
        attempt.groundingVisual = {
          kind: 'visible-canvas',
          dataUrl,
          viewport: {
            x: pendingGrounding.viewport.x,
            y: pendingGrounding.viewport.y,
            zoom: pendingGrounding.viewport.zoom,
            width: captured.viewport.width,
            height: captured.viewport.height,
            devicePixelRatio: captured.devicePixelRatio,
          },
          crop: captured.crop,
          selectedNodeIds: pendingGrounding.selectedNodeIds,
          strokeSubsets: pendingGrounding.strokeSubsets,
        };
        disposePendingGrounding(attempt);
      }

      const prepared = prepareAgentTurn({
        session: attempt.session,
        inputKind: attempt.inputKind,
        content: '',
        mode: attempt.mode,
        groundingVisual: attempt.groundingVisual,
        inkResources: attempt.inkResources,
        sources: attempt.sources,
      });
      let dispatchInvalidReason: string | undefined;
      const result = await dispatchAgentTurn(prepared, {
        onStarted: () => {
          const owner = attempt.session.conversationView?.conversationOwner;
          if (owner && isCurrentAttempt()) {
            setStartedDestination({
              nodeId: owner.nodeId,
              threadId: owner.threadId,
            });
          }
        },
        canDispatch: () => {
          if (!isCurrentAttempt()) {
            dispatchInvalidReason = t('toolbar.inkAgentPicker.changed');
            return false;
          }
          const owner = attempt.session.conversationView?.conversationOwner;
          const currentCanvas = useCanvasStore.getState();
          if (owner && currentCanvas.canvasId === owner.canvasId) {
            const target = resolveInkQuestionTarget(
              currentCanvas.nodes.find((node) => node.id === owner.nodeId),
            );
            if (target && !canReceiveInk(inkTargetAgent(target))) {
              dispatchInvalidReason = t('toolbar.inkAgentPicker.unavailable');
              return false;
            }
          }
          return true;
        },
        onAccepted: () => {
          const stillCurrent = isCurrentAttempt();
          const stillCapturedSelection =
            currentLassoIdentity() === lassoIdentity &&
            inkSelectionIdentity(
              useCanvasStore.getState().canvasId,
              useCanvasStore.getState().nodes,
              useGesturePreviewStore.getState().sketchStrokeSelection,
            ) === sourceIdentity;
          releasePreparation();
          if (!stillCurrent || !stillCapturedSelection) return;
          for (const pendingAttempt of attemptsRef.current.values()) {
            disposePendingGrounding(pendingAttempt);
          }
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
        toast(t('toolbar.inkAgentPicker.busy'), { tone: 'info' });
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
    selectionSession,
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
    if (!hasStrokes) return;
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
  }, [hasStrokes, handleDelete]);

  const showStyle = hasStrokes && !isMixed;
  const selectionTypeLabel = t(
    isMixed || !hasStrokes
      ? 'toolbar.multipleSelectedObjects'
      : 'toolbar.inkSelection',
  );
  const InkIcon = NODE_ICON.sketch;
  const showSubmit = hasSelection;
  const open = hasSelection && anchor !== null && (showStyle || showSubmit);
  const submitDisabled =
    Boolean(sigilIssue) ||
    candidate.kind !== 'ready' ||
    confirmingDestination ||
    isPreparing ||
    Boolean(unavailableReason);
  const submitTitle = isPreparing
    ? t(
        hasStrokes
          ? 'toolbar.sendingInkRequest'
          : 'toolbar.sendingSelectionRequest',
      )
    : confirmingDestination
      ? t('toolbar.inkAgentPicker.loadingConversation')
      : (sigilIssue ??
        unavailableReason?.message ??
        (candidate.kind === 'ready'
          ? t(
              hasStrokes
                ? 'toolbar.sendInkRequest'
                : 'toolbar.sendSelectionRequest',
            )
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
            {isMixed || !hasStrokes ? (
              <Shapes size={14} />
            ) : (
              <InkIcon size={14} />
            )}
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
            conversations={pickerConversations}
            selectedNodeId={selectedTargetId}
            disabled={isPreparing}
            unavailableReason={
              destination.kind === 'unresolved' && !destinationError
                ? undefined
                : (pickerIssue ??
                  (profileError
                    ? { kind: 'unavailable', message: profileError.message }
                    : undefined))
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
            aria-busy={isPreparing || undefined}
            disabled={submitDisabled}
            onClick={(event) => {
              event.stopPropagation();
              void handleSubmit();
            }}
          >
            {isPreparing ? <Spinner size="sm" /> : <ArrowUp />}
          </Button>
        </FloatingToolbar.Group>
      )}
      {sigilSelection.partialCount > 0 ? (
        <span
          role="status"
          className="text-fg-muted bg-surface rounded px-2 py-1 text-xs"
        >
          {t('sigil.partialSelection')}
        </span>
      ) : null}
    </CanvasFloatingPopover>
  );
};
