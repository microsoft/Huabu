// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Resolves a preview target to a rendered surface.
 *
 * The target is resolved here, at render time, rather than copying mutable
 * node data onto the tab — so an edit or a type change is reflected without
 * the workspace holding a stale copy (§7 of the proposal).
 *
 * Every Chat this renders is handed its own session, which is what lets two
 * of them be mounted at once: nothing here asks the store which thread is
 * current.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import useCanvasStore from '@/store/canvasStore';

import { ChatPanel } from '../ChatPanel';
import { ExpandedNodePanel } from '../ExpandedNodePanel/ExpandedNodePanel';

import type { ChatSession } from '@/hooks/useChatSession';
import type { PreviewTarget } from '@/store/previewWorkspace/model';
import type { Node } from '@xyflow/react';

/**
 * The conversation a Question node owns, or `null` when it has no thread
 * yet — a node mints its thread on first open, so there is nothing to show
 * before that.
 */
function questionSession(node: Node, canvasId: string): ChatSession | null {
  const threadId = node.data.threadId;
  if (typeof threadId !== 'string' || !threadId) return null;
  return {
    threadId,
    canvasId,
    ownerCanvasId: canvasId,
    conversationView: {
      presentationAnchor: { canvasId, nodeId: node.id },
      conversationOwner: { canvasId, nodeId: node.id, threadId },
    },
  };
}

export function PreviewRenderer({
  target,
  onClose,
  hasFocusPriority,
}: {
  target: PreviewTarget;
  /** Closes the tab rendering this target. */
  onClose: () => void;
  /** Whether this tab's group is the focused one (§14). */
  hasFocusPriority: boolean;
}) {
  const { t } = useTranslation();
  const node = useCanvasStore((s) =>
    target.kind === 'node'
      ? s.nodes.find((n) => n.id === target.nodeId)
      : undefined,
  );

  const session = useMemo<ChatSession | null>(() => {
    if (target.kind === 'chat') {
      return {
        threadId: target.threadId,
        canvasId: target.canvasId,
        ownerCanvasId: target.canvasId,
        conversationView: null,
      };
    }
    return node?.type === 'question'
      ? questionSession(node, target.canvasId)
      : null;
  }, [target, node]);

  if (session) return <ChatPanel session={session} />;

  // An unbound Chat target always resolves; only a Question node can be
  // waiting for its thread.
  if (target.kind === 'chat') return null;

  if (!node) {
    // A tab can outlive its node when deletion arrives from elsewhere;
    // validation removes it, and this covers the frame in between.
    return (
      <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
        {t('preview.nodeUnavailable')}
      </div>
    );
  }

  return (
    <ExpandedNodePanel
      nodeId={node.id}
      onClose={onClose}
      hasFocusPriority={hasFocusPriority}
    />
  );
}
