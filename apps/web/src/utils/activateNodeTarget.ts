// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { toast } from '@/components/Common/Toast';
import { hasNodePreview } from '@/components/Nodes/previewableNodeTypes';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { appNavigate } from '@/utils/appNavigation';
import { revealNodesOnCanvas } from '@/utils/canvasViewport';
import { buildNodeDeepLink } from '@/utils/nodeDeepLink';

import type { NodeReference } from '@/utils/nodeDeepLink';

const DOUBLED_PREFIX = 'node-node-';
const LOCATE_ONLY_STATE_KEY = 'locateNodeOnly';

/** Whether a navigation came from a document link, which must not open a preview. */
export function isLocateOnlyNavigation(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[LOCATE_ONLY_STATE_KEY] === true
  );
}

/**
 * Select a node of the loaded Space and reveal it on the canvas. With
 * `openPreview` (URL deep links) it also opens the node's permanent preview —
 * a Question opens its conversation at the latest message. In-document node
 * links only locate, so following one never replaces what the user is reading.
 * Returns false, after telling the user, when the node is not in the loaded
 * Space.
 */
export function activateNodeTarget(
  nodeId: string,
  { openPreview }: { openPreview: boolean },
): boolean {
  const canvas = useCanvasStore.getState();
  // The `#node-<id>` notation invites doubling the prefix every node ID
  // already carries; accept that slip instead of reporting a live node missing.
  const node =
    canvas.nodes.find((candidate) => candidate.id === nodeId) ??
    (nodeId.startsWith(DOUBLED_PREFIX)
      ? canvas.nodes.find(
          (candidate) => candidate.id === nodeId.slice('node-'.length),
        )
      : undefined);
  if (!node) {
    toast(i18n.t('canvasPage.nodeTargetUnavailable'), { tone: 'warning' });
    return false;
  }

  canvas.selectNodes([node.id], false);
  if (openPreview) openNodePreview(node);
  if (canvas.rfInstance && canvas.canvasWrapper) {
    revealNodesOnCanvas(
      canvas.rfInstance,
      canvas.canvasWrapper,
      [node.id],
      400,
    );
  } else {
    // Fullscreen preview unmounts the Canvas. Stay in fullscreen — the user is
    // reading — and hand the target to the reveal request the Canvas consumes
    // when it is mounted again; say so, since nothing visibly moves now.
    useCanvasStore.setState({ pendingRevealNodeIds: [node.id] });
    toast(i18n.t('canvasPage.nodeLocatedAfterFullscreen'), { tone: 'info' });
  }
  return true;
}

function openNodePreview(node: {
  id: string;
  type?: string;
  data: Record<string, unknown>;
}): void {
  const isQuestion = node.type === 'question';
  const hasThread =
    typeof node.data.threadId === 'string' && node.data.threadId.length > 0;
  if (isQuestion ? hasThread : hasNodePreview(node.type ?? '')) {
    const tabId = openPreviewNode(node.id, {
      transient: false,
      markReadIntent: false,
    });
    if (isQuestion && tabId) {
      usePreviewWorkspaceStore.getState().requestChatOpen(tabId, 'bottom');
    }
  } else {
    toast(i18n.t('canvasPage.nodeFocusedNoPreview'), { tone: 'info' });
  }
}

/**
 * Follow an in-document node link. A Space-relative reference belongs to the
 * Space that owns the document (`sourceCanvasId`), which is not the loaded
 * Space when a conversation is presented from another one. A reference to
 * another Space navigates there and lets the deep-link coordinator locate the
 * node, carrying the locate-only intent in router state. Returns false only when that navigation is impossible, so the caller
 * can fall back to ordinary URL handling.
 */
export function openNodeReference(
  reference: NodeReference,
  sourceCanvasId?: string,
): boolean {
  const loadedCanvasId = useCanvasStore.getState().canvasId;
  const targetCanvasId = reference.canvasId ?? sourceCanvasId ?? loadedCanvasId;
  if (targetCanvasId === loadedCanvasId) {
    activateNodeTarget(reference.nodeId, { openPreview: false });
    return true;
  }
  const url = new URL(
    buildNodeDeepLink(window.location.origin, targetCanvasId, reference.nodeId),
  );
  return appNavigate(`${url.pathname}${url.search}`, {
    state: {
      [LOCATE_ONLY_STATE_KEY]: true,
      returnToSpace: loadedCanvasId,
      workspaceId: useWorkspaceStore.getState().workspaceId,
    },
  });
}
