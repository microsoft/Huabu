// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { normalizeConversationTitle } from '@huabu/shared/conversation-title';

import { dedupeName, toSafeFilename } from '../../utils/naming.js';
import {
  applyDeltasOnServerAlreadyLocked,
  hydrateCanvasNodes,
} from '../canvas/canvas-executor.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { space } from '../storage/index.js';

import type { ConversationTitle } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export interface QuestionTitleSnapshot {
  nodeId: string;
  threadId?: string;
  content: string;
  title: ConversationTitle;
  protected: boolean;
}

/** The node label is the title, not a mirror of thread host metadata. */
export function questionTitleSnapshot(node: CanvasNode): QuestionTitleSnapshot {
  const title = normalizeConversationTitle(node.data.label);
  const owner = node.data.labelSource;
  const source = node.data.conversationTitleSource;
  return {
    nodeId: node.id,
    threadId:
      typeof node.data.threadId === 'string' ? node.data.threadId : undefined,
    content: typeof node.data.content === 'string' ? node.data.content : '',
    protected: !!title && (owner === 'user' || owner === 'agent'),
    title: {
      title,
      source: !title
        ? null
        : owner === 'user'
          ? 'user'
          : owner === 'agent'
            ? 'generated'
            : source === 'generated' ||
                source === 'acp' ||
                source === 'fallback'
              ? source
              : 'fallback',
    },
  };
}

async function readNode(
  canvasId: string,
  threadId?: string,
  nodeId?: string,
): Promise<CanvasNode | null> {
  const handle = space(canvasId);
  const canvas = await handle.read();
  const matches = (canvas?.state.nodes as CanvasNode[] | undefined)?.filter(
    (node) =>
      node.type === 'question' &&
      (nodeId ? node.id === nodeId : node.data.threadId === threadId),
  );
  if (matches?.length !== 1) return null;
  const node = matches[0];
  if (!node) return null;
  if (threadId && node.data.threadId !== threadId) return null;
  const record = await handle.nodes.read(node.id);
  if (!record) return null;
  return hydrateCanvasNodes(new Map([[node.id, record]]), [node])[0] ?? null;
}

export const conversationTitleNodeStore = {
  async read(
    canvasId: string,
    threadId?: string,
    nodeId?: string,
  ): Promise<QuestionTitleSnapshot | null> {
    const node = await readNode(canvasId, threadId, nodeId);
    return node ? questionTitleSnapshot(node) : null;
  },

  async write(
    canvasId: string,
    threadId: string | undefined,
    expected: QuestionTitleSnapshot,
    decide: (current: QuestionTitleSnapshot) => ConversationTitle | null,
    alreadyLocked = false,
  ): Promise<boolean> {
    const write = async () => {
      const node = await readNode(canvasId, threadId, expected.nodeId);
      if (!node || node.data.threadId !== expected.threadId) return false;
      const current = questionTitleSnapshot(node);
      const next = decide(current);
      if (!next?.title || !next.source) return false;
      if (next.source !== 'user') {
        const records = await space(canvasId).nodes.list();
        const taken = [...records]
          .filter(([id]) => id !== node.id)
          .map(([, snapshot]) => toSafeFilename(snapshot.record.label));
        const safeTitle = toSafeFilename(next.title);
        const allocated = dedupeName(safeTitle, taken);
        // Allocate by filename, but preserve the original display title.
        next.title = `${next.title}${allocated.slice(safeTitle.length)}`;
      }
      const labelSource = next.source === 'user' ? 'user' : 'auto';
      if (
        node.data.label === next.title &&
        node.data.labelSource === labelSource &&
        node.data.conversationTitleSource === next.source
      )
        return true;
      const output = await applyDeltasOnServerAlreadyLocked({
        canvasId,
        deltas: [
          {
            type: 'REPLACE_NODE',
            prev: node,
            next: {
              ...node,
              data: {
                ...node.data,
                label: next.title,
                labelSource,
                conversationTitleSource: next.source,
              },
            },
          },
        ],
        originator: { source: 'system' },
        agentNodeProjection: true,
      });
      if (output.toVersion > output.fromVersion)
        publishCanvasUpdate(canvasId, {
          type: 'update',
          data: {
            fromVersion: output.fromVersion,
            toVersion: output.toVersion,
            deltas: output.deltas,
            pendingEffects: output.pendingEffects,
            agentNodeProjection: true,
          },
        });
      return true;
    };
    return alreadyLocked ? write() : withCanvasMutex(canvasId, write);
  },
};
