// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Stage 2 acceptance test: two Chat renderers mounted at the same time
 * must not be able to see or disturb each other's conversation.
 *
 * `chatStore.sessionScope.test.ts` already pins the store's per-thread
 * keying. This file is about the layer above it — that a *rendered* tree
 * addresses its own thread through `ChatSession` and never resolves
 * "whichever thread is current". Those are different failures: the store
 * could be perfectly normalized and every renderer could still read the
 * same global pointer, which is exactly what the code did before.
 *
 * The one thing deliberately not asserted here is two mounted `ChatPanel`s.
 * `ChatPanel` is still the layer that *decides* which session to build, and
 * it decides by reading the global `threadId` (leak L1). See the skipped
 * test at the bottom, which is the acceptance criterion for Stage 3.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  selectThreadBinding,
  selectThreadDraft,
  selectThreadHistoryLoaded,
  selectThreadIsLoading,
  selectThreadMessages,
  selectThreadPendingAttachments,
  useChatStore,
} from '@/store/chatStore';
import { findPendingPermissionRequest } from '@/store/chatTypes';

import { ChatSessionProvider, useChatSession } from './useChatSession';

import type { ChatSession } from './useChatSession';
import type { ChatMessage } from '@/store/chatTypes';

const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';
const CANVAS = 'canvas-1';

const session = (threadId: string): ChatSession => ({
  threadId,
  canvasId: CANVAS,
  ownerCanvasId: CANVAS,
  conversationView: null,
});

const SESSION_A = session(THREAD_A);
const SESSION_B = session(THREAD_B);

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content };
}

function permissionMessage(id: string, requestId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    segments: [
      {
        kind: 'permission',
        requestId,
        toolCall: { toolCallId: 'tool-1', title: 'Run npm install' },
        options: [],
      },
    ],
  };
}

/**
 * Stands in for a Chat renderer: it takes no props and learns everything it
 * renders from the enclosing session, the way the real message list, composer
 * and usage ring do.
 */
function ChatSurface() {
  const { threadId } = useChatSession();
  const messages = useChatStore((s) => selectThreadMessages(s, threadId));
  const draft = useChatStore((s) => selectThreadDraft(s, threadId));
  const binding = useChatStore((s) => selectThreadBinding(s, threadId));
  const attachments = useChatStore((s) =>
    selectThreadPendingAttachments(s, threadId),
  );
  const historyLoaded = useChatStore((s) =>
    selectThreadHistoryLoaded(s, threadId),
  );
  const streaming = useChatStore((s) => selectThreadIsLoading(s, threadId));
  const selection = useChatStore((s) => s.selectionAttachment);
  const permission = findPendingPermissionRequest(messages);

  return (
    <dl data-testid={threadId}>
      <dd data-field="messages">
        {messages.map((m) => (m.role === 'user' ? m.content : '')).join(',')}
      </dd>
      <dd data-field="draft">{draft}</dd>
      <dd data-field="binding">{binding.kind}</dd>
      <dd data-field="attachments">{String(attachments.length)}</dd>
      <dd data-field="historyLoaded">{String(historyLoaded)}</dd>
      <dd data-field="streaming">{String(streaming)}</dd>
      <dd data-field="permission">{permission?.part.requestId ?? ''}</dd>
      <dd data-field="selection">{selection?.content ?? ''}</dd>
    </dl>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function read(threadId: string, field: string): string {
  const el = container?.querySelector(
    `[data-testid="${threadId}"] [data-field="${field}"]`,
  );
  if (!el) throw new Error(`no ${field} rendered for ${threadId}`);
  return el.textContent ?? '';
}

/** Apply a store mutation and let both mounted trees re-render. */
async function commit(mutate: () => void): Promise<void> {
  await act(async () => {
    mutate();
  });
}

beforeEach(async () => {
  useChatStore.setState({
    threadsById: {},
    // Deliberately points at neither renderer: nothing on screen may resolve
    // its conversation through this field.
    threadId: 'thread-unrelated',
    threadMap: {},
    bindingMap: {},
    selectionAttachment: null,
    viewingQuestionThread: null,
    questionReplayByCanvas: {},
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <>
        <ChatSessionProvider value={SESSION_A}>
          <ChatSurface />
        </ChatSessionProvider>
        <ChatSessionProvider value={SESSION_B}>
          <ChatSurface />
        </ChatSessionProvider>
      </>,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('two mounted Chat renderers', () => {
  it('keeps messages and pending permissions apart', async () => {
    await commit(() => {
      const s = useChatStore.getState();
      s.addMessage(THREAD_A, userMessage('m1', 'hello a'));
      s.addMessage(THREAD_B, userMessage('m2', 'hello b'));
      s.addMessage(THREAD_A, permissionMessage('p1', 'permission-a'));
    });

    expect(read(THREAD_A, 'messages')).toBe('hello a,');
    expect(read(THREAD_B, 'messages')).toBe('hello b');
    // A blocked agent must not put the other Chat behind a prompt it cannot
    // answer, so the permission travels with its own thread's transcript.
    expect(read(THREAD_A, 'permission')).toBe('permission-a');
    expect(read(THREAD_B, 'permission')).toBe('');
  });

  it('keeps composer drafts apart', async () => {
    await commit(() => useChatStore.getState().setDraft(THREAD_A, 'draft a'));

    expect(read(THREAD_A, 'draft')).toBe('draft a');
    expect(read(THREAD_B, 'draft')).toBe('');
  });

  it('keeps agent bindings apart', async () => {
    await commit(() =>
      useChatStore.getState().setAgentBinding(THREAD_A, {
        kind: 'external',
        profileId: 'p1',
        alias: 'Codex',
      }),
    );

    expect(read(THREAD_A, 'binding')).toBe('external');
    expect(read(THREAD_B, 'binding')).toBe('internal');
  });

  it('keeps staged attachments apart', async () => {
    await commit(() =>
      useChatStore.getState().addPendingAttachment(THREAD_A, {
        type: 'text',
        source: 'excerpt',
        content: 'staged',
        label: 'staged',
      }),
    );

    expect(read(THREAD_A, 'attachments')).toBe('1');
    expect(read(THREAD_B, 'attachments')).toBe('0');
  });

  it('keeps history loading apart', async () => {
    await commit(() =>
      useChatStore.getState().setHistoryLoaded(THREAD_A, true),
    );

    expect(read(THREAD_A, 'historyLoaded')).toBe('true');
    expect(read(THREAD_B, 'historyLoaded')).toBe('false');
  });

  it('keeps streaming state apart', async () => {
    await commit(() =>
      useChatStore.getState().setThreadLoading(THREAD_B, true),
    );

    expect(read(THREAD_A, 'streaming')).toBe('false');
    expect(read(THREAD_B, 'streaming')).toBe('true');
  });

  it('shows one shared selection excerpt to both', async () => {
    await commit(() =>
      useChatStore.getState().setSelectionAttachment({
        type: 'text',
        source: 'excerpt',
        content: 'excerpt',
        label: 'excerpt',
      }),
    );

    // Shared on purpose, and the one case here that is *not* isolation:
    // there is a single browser selection, so both Chats offer it and
    // whichever one sends spends it for both.
    expect(read(THREAD_A, 'selection')).toBe('excerpt');
    expect(read(THREAD_B, 'selection')).toBe('excerpt');
  });

  it('ignores the store-wide current thread', async () => {
    await commit(() => {
      const s = useChatStore.getState();
      s.addMessage(THREAD_A, userMessage('m1', 'hello a'));
      s.addMessage('thread-unrelated', userMessage('m3', 'not on screen'));
    });

    // Moving the global pointer onto a thread neither renderer owns, and then
    // onto one it does, must change nothing: both address their own session.
    await commit(() => useChatStore.setState({ threadId: THREAD_B }));
    expect(read(THREAD_A, 'messages')).toBe('hello a');
    expect(read(THREAD_B, 'messages')).toBe('');

    await commit(() => useChatStore.setState({ threadId: 'thread-unrelated' }));
    expect(read(THREAD_A, 'messages')).toBe('hello a');
    expect(read(THREAD_B, 'messages')).toBe('');
  });
});

describe.skip('two mounted ChatPanels (Stage 3)', () => {
  it('renders a different conversation in each panel', () => {
    // Blocked on L1/L4. `ChatPanel` resolves its session from the global
    // `threadId` and the `_savedCanvas*` restore stack, so two panels would
    // build the same session and render the same conversation. Unskip once a
    // tab supplies the session instead.
  });
});
