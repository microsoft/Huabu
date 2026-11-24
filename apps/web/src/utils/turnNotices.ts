// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Finds the moments in a Space that a person who is elsewhere should hear
 * about: an Agent's turn ended, failed, or stopped to wait for an approval.
 *
 * {@link readConversations} reduces the Space to one state per conversation;
 * a {@link TurnWatcher} follows those readings; {@link composeNotice} words
 * what it found. Nothing here decides whether the person is looking —
 * that belongs to whoever delivers the notice.
 */

import { getQuestionNodeStatus } from '@huabu/shared';

import {
  assistantMessageText,
  findPendingPermissionRequestId,
  type ChatMessage,
} from '@/store/chatTypes';

import {
  conversationAttention,
  mostPressing,
  type AttentionKind,
} from './attention';

import type { DesktopTabNotice } from '@huabu/shared/desktop-tabs';

export interface ConversationReading {
  /** The conversation's node on the Space, when it has one. */
  nodeId: string | null;
  label: string;
  state: 'idle' | 'running' | AttentionKind;
  /** The approval request the conversation waits on, if any. */
  approval: string | null;
  /** What to say about the state: the reply's opening, or the error. */
  text: string;
  /** What the conversation holds that the person has not seen, if anything. */
  attention: AttentionKind | null;
}

export interface TurnEvent {
  /** The conversation: its thread, or its node while it has no thread. */
  key: string;
  /** `approval` and `error` need the person; `done` only reports. */
  kind: AttentionKind;
  nodeId: string | null;
  label: string;
  text: string;
  /** What the turn left unseen on the Space, when the caller knows. */
  outputIds?: readonly string[];
}

interface NodeLike {
  id: string;
  data: { type?: unknown } & Record<string, unknown>;
}

interface ThreadLike {
  messages: ChatMessage[];
  isStreaming: boolean;
  completedTurnId?: string;
}

const SENTENCE_LIMIT = 140;
/**
 * How much a notice may carry. The desktop shell refuses a notice past its
 * own bounds, which are wider than these; a notification shows less anyway.
 */
const NOTICE_NODE_LIMIT = 64;
const NOTICE_KEY_LIMIT = 64;
const NOTICE_TITLE_LIMIT = 200;
const NOTICE_BODY_LIMIT = 300;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * The opening sentence of a reply, as plain text. Markdown markers that
 * would read as noise in a notification are dropped.
 */
export function firstSentence(text: string): string {
  const line =
    text
      .split('\n')
      .map((entry) =>
        entry
          .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, '')
          .replace(/[*_`]/g, '')
          .trim(),
      )
      .find((entry) => entry !== '') ?? '';
  const end = /[。！？]|[.!?](?=\s|$)/.exec(line);
  const sentence = end ? line.slice(0, end.index + 1) : line;
  return sentence.length > SENTENCE_LIMIT
    ? `${sentence.slice(0, SENTENCE_LIMIT - 1)}…`
    : sentence;
}

function lastReply(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant')
      return firstSentence(assistantMessageText(message.segments));
    if (message?.role === 'user') break;
  }
  return '';
}

/** One state per conversation of the Space, by {@link TurnEvent.key}. */
export function readConversations(
  nodes: readonly NodeLike[],
  threadsById: Readonly<Record<string, ThreadLike>>,
  /**
   * The threads this Space owns besides those its Question nodes name. The
   * chat store keeps threads of other Spaces too; those are not read.
   */
  standalone: ReadonlySet<string>,
): Map<string, ConversationReading> {
  const readings = new Map<string, ConversationReading>();
  const seen = new Set<string>();
  const read = (
    key: string,
    node: NodeLike | undefined,
    thread: ThreadLike | undefined,
  ) => {
    const status = node ? getQuestionNodeStatus(node.data) : 'idle';
    const last = thread?.messages.at(-1);
    const failure = last?.role === 'status' && last.status === 'error';
    const approval = thread
      ? findPendingPermissionRequestId(thread.messages)
      : null;
    // A conversation running elsewhere is known only through its node, so
    // the node's status counts wherever the thread says nothing newer.
    const state =
      approval !== null
        ? 'approval'
        : thread?.isStreaming || status === 'running'
          ? 'running'
          : failure || status === 'error'
            ? 'error'
            : thread?.completedTurnId || status === 'done'
              ? 'done'
              : 'idle';
    readings.set(key, {
      nodeId: node?.id ?? null,
      label: typeof node?.data.label === 'string' ? node.data.label : '',
      state,
      approval,
      text:
        state === 'done'
          ? lastReply(thread?.messages ?? [])
          : state !== 'error'
            ? ''
            : failure
              ? (last.detail ?? '')
              : typeof node?.data.errorMessage === 'string'
                ? node.data.errorMessage
                : '',
      // Only a node records viewing, so a bare thread can only await approval.
      attention: conversationAttention(
        status,
        node?.data.viewed === true,
        approval !== null,
      ),
    });
  };
  for (const node of nodes) {
    if (node.data.type !== 'question') continue;
    const threadId =
      typeof node.data.threadId === 'string' ? node.data.threadId : null;
    if (threadId) seen.add(threadId);
    read(
      threadId ?? node.id,
      node,
      threadId ? threadsById[threadId] : undefined,
    );
  }
  for (const threadId of standalone) {
    const thread = threadsById[threadId];
    if (thread && !seen.has(threadId)) read(threadId, undefined, thread);
  }
  return readings;
}

/** What a Space holds that the person has not seen, across conversations. */
export function unseenIn(readings: ReadonlyMap<string, ConversationReading>): {
  attention: AttentionKind | null;
  unseen: number;
} {
  const kinds = [...readings.values()].flatMap((reading) =>
    reading.attention ? [reading.attention] : [],
  );
  return { attention: mostPressing(kinds), unseen: kinds.length };
}

export interface TurnWatcher {
  /** Take the next reading of the Space and return what happened since. */
  take(readings: ReadonlyMap<string, ConversationReading>): TurnEvent[];
}

/**
 * Watches one Space's conversations across readings. A conversation reports
 * only what follows a turn seen running here: what a page finds when it
 * opens, or when a conversation's history arrives, was already so.
 */
export function createTurnWatcher(): TurnWatcher {
  /** Conversations with a turn in flight, each with the approval last told. */
  const running = new Map<string, string | null>();
  return {
    take(readings) {
      const events: TurnEvent[] = [];
      for (const key of running.keys())
        if (!readings.has(key)) running.delete(key);
      for (const [key, reading] of readings) {
        if (reading.state === 'running') {
          if (!running.has(key)) running.set(key, null);
          continue;
        }
        if (!running.has(key)) continue;
        if (reading.state === 'idle') {
          // Stopped by the person: nothing to report.
          running.delete(key);
          continue;
        }
        if (reading.state === 'approval') {
          // The turn goes on after the answer, so it stays in flight.
          if (running.get(key) === reading.approval) continue;
          running.set(key, reading.approval);
        } else running.delete(key);
        events.push({
          key,
          kind: reading.state,
          nodeId: reading.nodeId,
          label: reading.label,
          text: reading.text,
        });
      }
      return events;
    },
  };
}

export interface NoticeWording {
  done: string;
  error: string;
  approval: string;
  /** Several conversations at once; receives how many. */
  several: (count: number) => string;
}

export interface NoticePreferences {
  /** Notify when a turn ended. */
  done: boolean;
  /** Notify when an Agent failed or waits for an approval. */
  needsYou: boolean;
}

/**
 * One notice for the events that arrived together, the latest per
 * conversation, or null when the preferences silence them all.
 */
export function composeNotice(
  events: readonly TurnEvent[],
  spaceTitle: string,
  wording: NoticeWording,
  preferences: NoticePreferences,
): DesktopTabNotice | null {
  const told = [
    ...new Map(events.map((event) => [event.key, event])).values(),
  ].filter((event) =>
    event.kind === 'done' ? preferences.done : preferences.needsYou,
  );
  const [only] = told;
  if (!only) return null;
  // A finished turn opens on what it made; anything else, and a turn that
  // made nothing, opens on the conversation.
  const nodeIds = told
    .flatMap((event) =>
      event.kind === 'done' && event.outputIds?.length
        ? event.outputIds
        : event.nodeId
          ? [event.nodeId]
          : [],
    )
    .slice(0, NOTICE_NODE_LIMIT);
  if (told.length === 1)
    return {
      keys: [only.key],
      title: clip(
        only.label ? `${only.label} · ${spaceTitle}` : spaceTitle,
        NOTICE_TITLE_LIMIT,
      ),
      body: clip(
        only.kind === 'approval'
          ? wording.approval
          : only.kind === 'error'
            ? only.text
              ? `${wording.error}: ${only.text}`
              : wording.error
            : only.text || wording.done,
        NOTICE_BODY_LIMIT,
      ),
      nodeIds,
    };
  return {
    // The count says how many there were; the keys name as many as fit.
    keys: told.slice(0, NOTICE_KEY_LIMIT).map((event) => event.key),
    title: clip(spaceTitle, NOTICE_TITLE_LIMIT),
    body: wording.several(told.length),
    nodeIds,
  };
}
