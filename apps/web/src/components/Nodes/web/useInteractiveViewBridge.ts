// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef } from 'react';

import { ApiError } from '@/api/_client';
import {
  getInteractiveViewRuntime,
  replaceInteractiveViewState,
  submitInteractiveViewAction,
} from '@/api/interactiveView';
import { focusNodesOnCanvas } from '@/components/Panels/CanvasLayerPanel/focusNodesOnCanvas';
import useCanvasStore from '@/store/canvasStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import type {
  InteractiveViewBootstrapV1,
  InteractiveViewDataSnapshotV1,
  InteractiveViewDataUpdateV1,
  InteractiveViewIntentV1,
  InteractiveViewJsonValue,
  InteractiveViewOutcomeV1,
  InteractiveViewResource,
} from '@huabu/shared';
import type { RefObject } from 'react';

const MAX_RECENT_REQUESTS = 200;
const MAX_REQUESTS_PER_SECOND = 20;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_COLLECTION_SIZE = 1_000;
const MAX_JSON_STRING_LENGTH = 65_536;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBoundedJsonValue(value: unknown): value is InteractiveViewJsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_JSON_STRING_LENGTH) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_COLLECTION_SIZE) return false;
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    const record = asRecord(current.value);
    if (!record) return false;
    const entries = Object.entries(record);
    if (entries.length > MAX_JSON_COLLECTION_SIZE) return false;
    for (const [key, entry] of entries) {
      if (key.length > 1_024) return false;
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

function parseIntent(value: unknown): InteractiveViewIntentV1 | null {
  const input = asRecord(value);
  if (
    input?.type !== 'huabu.view.intent' ||
    input.protocolVersion !== 1 ||
    typeof input.nodeId !== 'string' ||
    input.nodeId.length === 0 ||
    typeof input.requestId !== 'string' ||
    input.requestId.length === 0 ||
    input.requestId.length > 128 ||
    typeof input.actionId !== 'string' ||
    input.actionId.length === 0 ||
    input.actionId.length > 128 ||
    (input.bindingRevision !== undefined &&
      (typeof input.bindingRevision !== 'string' ||
        input.bindingRevision.length === 0)) ||
    (input.input !== undefined && !isBoundedJsonValue(input.input))
  ) {
    return null;
  }
  return input as InteractiveViewIntentV1;
}

function bootstrapOf(
  resource: InteractiveViewResource,
  data: Record<string, InteractiveViewDataSnapshotV1>,
): InteractiveViewBootstrapV1 {
  return {
    type: 'huabu.view.bootstrap',
    protocolVersion: 1,
    nodeId: resource.nodeId,
    revision: resource.revision,
    state: resource.definition.state.value,
    data,
    actions: resource.definition.actions.map(({ actionId, kind }) => ({
      actionId,
      kind,
    })),
  };
}

function postOutcome(port: MessagePort, outcome: InteractiveViewOutcomeV1) {
  port.postMessage(outcome);
}

export function useInteractiveViewBridge(input: {
  enabled: boolean;
  canvasId: string | null;
  nodeId: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { enabled, canvasId, nodeId, iframeRef } = input;
  const resourceRef = useRef<InteractiveViewResource | null>(null);
  const dataRef = useRef<Record<string, InteractiveViewDataSnapshotV1>>({});
  const portRef = useRef<MessagePort | null>(null);
  const runtimeCleanupRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);

  const closePort = useCallback(() => {
    generationRef.current += 1;
    runtimeCleanupRef.current?.();
    runtimeCleanupRef.current = null;
    portRef.current?.close();
    portRef.current = null;
  }, []);

  useEffect(() => closePort, [closePort]);
  useEffect(() => {
    if (!enabled) closePort();
  }, [closePort, enabled]);

  const connect = useCallback(async () => {
    closePort();
    if (!enabled || !canvasId || !iframeRef.current?.contentWindow) return;

    const generation = generationRef.current;
    let runtime;
    try {
      runtime = await getInteractiveViewRuntime(canvasId, nodeId);
    } catch (error) {
      console.error('[interactive-view] bootstrap failed', error);
      return;
    }
    if (
      generationRef.current !== generation ||
      !iframeRef.current?.contentWindow
    ) {
      return;
    }
    resourceRef.current = runtime.resource;
    dataRef.current = runtime.data;

    const channel = new MessageChannel();
    const port = channel.port1;
    portRef.current = port;
    const seen = new Set<string>();
    const requestTimes: number[] = [];
    const refreshData = async (bindingId?: string) => {
      const next = await getInteractiveViewRuntime(canvasId, nodeId);
      if (portRef.current !== port) return null;
      resourceRef.current = next.resource;
      const data =
        bindingId === undefined
          ? next.data
          : next.data[bindingId]
            ? { [bindingId]: next.data[bindingId] }
            : {};
      dataRef.current =
        bindingId === undefined ? next.data : { ...dataRef.current, ...data };
      const update: InteractiveViewDataUpdateV1 = {
        type: 'huabu.view.data',
        protocolVersion: 1,
        nodeId,
        data,
      };
      port.postMessage(update);
      return data;
    };

    port.onmessage = (event: MessageEvent<unknown>) => {
      const intent = parseIntent(event.data);
      if (!intent || intent.nodeId !== nodeId) return;
      if (seen.has(intent.requestId)) {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'error',
          code: 'duplicate_request',
          message: 'requestId has already been used',
        });
        return;
      }
      seen.add(intent.requestId);
      if (seen.size > MAX_RECENT_REQUESTS) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }

      const now = Date.now();
      while (requestTimes[0] !== undefined && requestTimes[0] <= now - 1_000) {
        requestTimes.shift();
      }
      if (requestTimes.length >= MAX_REQUESTS_PER_SECOND) {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'error',
          code: 'rate_limited',
          message: 'Too many Interactive View requests',
        });
        return;
      }
      requestTimes.push(now);

      const current = resourceRef.current;
      const grant = current?.definition.actions.find(
        (candidate) => candidate.actionId === intent.actionId,
      );
      if (!current || !grant) {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'unauthorized',
          code: 'action_not_granted',
          message: 'The requested action is not granted to this View',
        });
        return;
      }
      if (grant.kind === 'data.refresh') {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'pending',
        });
        void refreshData(grant.bindingId)
          .then((data) => {
            if (!data || portRef.current !== port) return;
            postOutcome(port, {
              type: 'huabu.view.outcome',
              requestId: intent.requestId,
              status: 'success',
              result: data as unknown as InteractiveViewJsonValue,
            });
          })
          .catch((error: unknown) => {
            if (portRef.current !== port) return;
            postOutcome(port, {
              type: 'huabu.view.outcome',
              requestId: intent.requestId,
              status: 'error',
              code: 'data_refresh_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to refresh bound data',
            });
          });
        return;
      }
      if (grant.kind === 'agent.submit') {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'pending',
        });
        void submitInteractiveViewAction(canvasId, nodeId, intent.actionId, {
          ...(intent.input === undefined ? {} : { input: intent.input }),
        })
          .then(() => {
            if (portRef.current !== port) return;
            postOutcome(port, {
              type: 'huabu.view.outcome',
              requestId: intent.requestId,
              status: 'success',
              result: { accepted: true },
            });
          })
          .catch((error: unknown) => {
            if (portRef.current !== port) return;
            postOutcome(port, {
              type: 'huabu.view.outcome',
              requestId: intent.requestId,
              status: 'error',
              code:
                error instanceof ApiError
                  ? (error.code ?? 'agent_submit_failed')
                  : 'agent_submit_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to submit Interactive View action',
            });
          });
        return;
      }
      if (
        grant.kind === 'navigation.open-node' ||
        grant.kind === 'navigation.open-thread'
      ) {
        const target = asRecord(intent.input);
        const snapshot = grant.bindingId
          ? dataRef.current[grant.bindingId]
          : undefined;
        const targetId =
          grant.kind === 'navigation.open-node'
            ? target?.nodeId
            : target?.threadId;
        const allowedIds =
          grant.kind === 'navigation.open-node'
            ? snapshot?.references.nodeIds
            : snapshot?.references.threadIds;
        if (
          typeof targetId !== 'string' ||
          !snapshot ||
          !allowedIds?.includes(targetId)
        ) {
          postOutcome(port, {
            type: 'huabu.view.outcome',
            requestId: intent.requestId,
            status: 'unauthorized',
            code: 'navigation_target_not_bound',
            message: 'The navigation target is not present in bound data',
          });
          return;
        }

        const canvas = useCanvasStore.getState();
        const targetNode =
          grant.kind === 'navigation.open-node'
            ? canvas.nodes.find((node) => node.id === targetId)
            : canvas.nodes.find(
                (node) =>
                  (node.data as { threadId?: string }).threadId === targetId,
              );
        if (!targetNode) {
          postOutcome(port, {
            type: 'huabu.view.outcome',
            requestId: intent.requestId,
            status: 'error',
            code: 'navigation_target_missing',
            message: 'The bound navigation target no longer exists',
          });
          return;
        }

        canvas.selectNodes([targetNode.id], false);
        if (canvas.rfInstance) {
          focusNodesOnCanvas(canvas.rfInstance, [targetNode.id], 400);
        }
        if (grant.kind === 'navigation.open-thread') {
          openPreviewNode(targetNode.id);
        }
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'success',
          result:
            grant.kind === 'navigation.open-node'
              ? { nodeId: targetNode.id }
              : { threadId: targetId },
        });
        return;
      }
      if (grant.kind !== 'state.replace') {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'error',
          code: 'action_not_available',
          message: `${grant.kind} is not available in this release`,
        });
        return;
      }

      const stateInput = asRecord(intent.input);
      if (
        typeof stateInput?.revision !== 'string' ||
        !Object.prototype.hasOwnProperty.call(stateInput, 'value')
      ) {
        postOutcome(port, {
          type: 'huabu.view.outcome',
          requestId: intent.requestId,
          status: 'error',
          code: 'invalid_input',
          message: 'state.replace requires { revision, value }',
        });
        return;
      }

      postOutcome(port, {
        type: 'huabu.view.outcome',
        requestId: intent.requestId,
        status: 'pending',
      });
      void replaceInteractiveViewState(canvasId, nodeId, {
        revision: stateInput.revision,
        value: stateInput.value as InteractiveViewJsonValue,
      })
        .then((next) => {
          if (portRef.current !== port) return;
          resourceRef.current = next;
          postOutcome(port, {
            type: 'huabu.view.outcome',
            requestId: intent.requestId,
            status: 'success',
            result: {
              revision: next.revision,
              state: next.definition.state.value,
            },
          });
        })
        .catch((error: unknown) => {
          if (portRef.current !== port) return;
          const conflict =
            error instanceof ApiError && error.code === 'view_conflict';
          const details = conflict ? asRecord(error.details) : null;
          postOutcome(port, {
            type: 'huabu.view.outcome',
            requestId: intent.requestId,
            status: conflict ? 'conflict' : 'error',
            code:
              error instanceof ApiError
                ? (error.code ?? 'state_replace_failed')
                : 'state_replace_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to replace Interactive View state',
            ...(typeof details?.currentRevision === 'string'
              ? { currentRevision: details.currentRevision }
              : {}),
          });
        });
    };
    port.start();

    iframeRef.current.contentWindow.postMessage(
      {
        type: 'huabu.view.connect',
        protocolVersion: 1,
        nodeId,
      },
      '*',
      [channel.port2],
    );
    port.postMessage(bootstrapOf(runtime.resource, runtime.data));

    const bindings = runtime.resource.definition.bindings;
    const pollInterval = bindings.reduce<number | null>((minimum, binding) => {
      const candidate = binding.refresh?.pollIntervalMs;
      if (candidate === undefined) return minimum;
      return minimum === null ? candidate : Math.min(minimum, candidate);
    }, null);
    const onFocus = () => {
      if (
        document.visibilityState === 'visible' &&
        bindings.some((binding) => binding.refresh?.onFocus)
      ) {
        void refreshData().catch((error) => {
          console.error('[interactive-view] focus refresh failed', error);
        });
      }
    };
    window.addEventListener('focus', onFocus);
    const timer =
      pollInterval === null
        ? null
        : window.setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            void refreshData().catch((error) => {
              console.error('[interactive-view] polling refresh failed', error);
            });
          }, pollInterval);
    runtimeCleanupRef.current = () => {
      window.removeEventListener('focus', onFocus);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [canvasId, closePort, enabled, iframeRef, nodeId]);

  return { connect, closePort };
}
