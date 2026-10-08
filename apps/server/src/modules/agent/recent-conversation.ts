// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { agentSubmissionSchema } from '@agenetes/protocol';
import { z } from 'zod';

import { recentCanvasConversationResponseSchema } from '@huabu/shared';

import {
  readSubstrateDocument,
  writeSubstrateDocument,
} from './substrate-store.js';
import { resolveDirectChildPath, safeJoin } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { space } from '../storage/index.js';
import {
  canvasAcpNamespace,
  resolveCanvasAcpNamespace,
} from '../workspace/paths.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { Space } from '../storage/index.js';
import type { EventLogStore, TurnStartLogEntry } from '@agenetes/agenetes';
import type { AgentSubmission, Namespace } from '@agenetes/protocol';
import type { RecentCanvasConversationResponse } from '@huabu/shared';

const EXTENSION = 'huabu.recentconversation';
const DOCUMENT = 'target';
const MARKER = 'huabuRecentConversationAcceptance';
const targetSchema =
  recentCanvasConversationResponseSchema.shape.conversation.unwrap();
const indexSchema = z.object({
  conversation: targetSchema.nullable(),
  pending: z
    .object({
      conversation: targetSchema,
      acceptanceId: z.string().uuid(),
    })
    .optional(),
});
type Index = z.infer<typeof indexSchema>;

const anchoredSubmissionSchema = z.object({
  focus: z.object({ anchor: z.object({ nodeId: z.string().min(1) }) }),
});
const eventRecordSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.number(),
  kind: z.string().optional(),
  request: z.unknown().optional(),
});
const acceptanceMarkerSchema = z.object({
  content: z.object({ [MARKER]: z.string() }),
});

async function readIndex(handle: Space): Promise<Index> {
  const substrate = await handle.extension(EXTENSION);
  if (!substrate) throw new Error('Recent conversation Space is unavailable');
  const value = await readSubstrateDocument<unknown>(substrate, DOCUMENT, {
    strict: true,
  });
  return value === null ? { conversation: null } : indexSchema.parse(value);
}

async function writeIndex(handle: Space, index: Index): Promise<void> {
  const substrate = await handle.extension(EXTENSION);
  if (!substrate) throw new Error('Recent conversation Space is unavailable');
  await writeSubstrateDocument(substrate, DOCUMENT, index);
}

async function findAcceptedStart(
  namespace: Namespace,
  pending: NonNullable<Index['pending']>,
  events: EventLogStore,
): Promise<TurnStartLogEntry | null> {
  let records: unknown[];
  if (namespace.storage?.root) {
    // Agenetes's tolerant FileEventLogStore reader cannot distinguish damaged
    // history from absence. Recovery of a pending pointer must fail closed.
    const file = resolveDirectChildPath(
      safeJoin(namespace.storage.root, 'chat_v2'),
      `${pending.conversation.threadId}.events.jsonl`,
    );
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    records = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  } else {
    records = await events.readRecords(
      namespace,
      pending.conversation.threadId,
    );
  }
  for (const record of records) {
    const entry = eventRecordSchema.parse(record);
    const marker = acceptanceMarkerSchema.safeParse(entry.request);
    if (
      entry.kind === 'turn_start' &&
      marker.success &&
      marker.data.content[MARKER] === pending.acceptanceId
    ) {
      return {
        kind: 'turn_start',
        seq: entry.seq,
        ts: entry.ts,
        request: agentSubmissionSchema.parse(entry.request),
      };
    }
  }
  return null;
}

async function resolveIndex(
  namespace: Namespace,
  events: EventLogStore,
  handle: Space,
): Promise<Index> {
  const index = await readIndex(handle);
  if (!index.pending) return index;
  return {
    conversation: (await findAcceptedStart(namespace, index.pending, events))
      ? index.pending.conversation
      : index.conversation,
  };
}

/**
 * Reserve the pointer before the authoritative turn_start, and finalize only
 * after it exists. A failed finalization leaves a verifiable pending identity,
 * never a rejected response for an already accepted turn.
 */
export async function appendRecentConversationTurn(
  namespace: Namespace,
  threadId: string,
  request: AgentSubmission | null,
  events: EventLogStore,
) {
  const parsed =
    request?.type === 'huabu.chat'
      ? anchoredSubmissionSchema.safeParse(request.content)
      : null;
  if (!namespace.name || !parsed?.success || !request) {
    return events.appendTurnStart(namespace, threadId, request);
  }
  const lease = acquireWorkspaceOperationLease();
  try {
    resolveCanvasAcpNamespace(namespace);
    const handle = space(namespace.name);
    return await withCanvasMutex(namespace.name, async () => {
      namespace = resolveCanvasAcpNamespace(namespace);
      const canvas = await handle.read();
      const nodeId = parsed.data.focus.anchor.nodeId;
      const matches = canvas?.state.nodes.filter((value) => {
        const node = value as {
          id?: string;
          type?: string;
          data?: { threadId?: string };
        };
        return (
          node.id === nodeId &&
          node.type === 'question' &&
          node.data?.threadId === threadId
        );
      });
      if (matches?.length !== 1) {
        return events.appendTurnStart(namespace, threadId, request);
      }
      const previous = await resolveIndex(namespace, events, handle);
      const pending = {
        conversation: { nodeId, threadId },
        acceptanceId: randomUUID(),
      };
      await writeIndex(handle, { ...previous, pending });
      let accepted: TurnStartLogEntry;
      try {
        accepted = await events.appendTurnStart(namespace, threadId, {
          ...request,
          content: {
            ...(request.content as Record<string, unknown>),
            [MARKER]: pending.acceptanceId,
          },
        });
      } catch (error) {
        // A backing may lose its acknowledgement after committing. Only the
        // exact durable identity can turn that uncertain outcome into acceptance.
        const recovered = await findAcceptedStart(namespace, pending, events);
        if (!recovered) throw error;
        accepted = recovered;
      }
      try {
        await writeIndex(handle, { conversation: pending.conversation });
      } catch (error) {
        logger.error(
          { err: error, canvasId: namespace.name, threadId },
          'Accepted conversation pointer awaits durable turn-start recovery',
        );
      }
      return accepted;
    });
  } finally {
    lease.release();
  }
}

export async function readRecentCanvasConversation(
  canvasId: string,
  events: EventLogStore,
): Promise<RecentCanvasConversationResponse> {
  const lease = acquireWorkspaceOperationLease();
  try {
    const handle = space(canvasId);
    return await withCanvasMutex(canvasId, async () => {
      const index = await resolveIndex(
        canvasAcpNamespace(canvasId),
        events,
        handle,
      );
      return { conversation: index.conversation };
    });
  } finally {
    lease.release();
  }
}

/** Called inside the existing rehome admission before deleting canonical history. */
export async function preserveRecentConversationBeforeHistoryDelete(
  namespace: Namespace,
  threadId: string,
  events: EventLogStore,
): Promise<void> {
  if (!namespace.name) return;
  const lease = acquireWorkspaceOperationLease();
  try {
    namespace = resolveCanvasAcpNamespace(namespace);
    const handle = space(namespace.name);
    if (!(await handle.read())) return;
    const index = await readIndex(handle);
    if (index.pending?.conversation.threadId !== threadId) return;
    await writeIndex(handle, await resolveIndex(namespace, events, handle));
  } finally {
    lease.release();
  }
}
