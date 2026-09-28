// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Activity, useMemo, useState } from 'react';

import { Button } from '@/components/Common/Button';
import { MessageList } from '@/components/Messages/MessageList';
import { ThreadChatInput } from '@/components/Panels/ChatPanel/ThreadChatInput';
import { selectRetainedPreviewTabs } from '@/components/Panels/PreviewWorkspace/retainedPreviewTabs';
import { ChatSessionProvider } from '@/hooks/useChatSession';
import { activateTab } from '@/store/previewWorkspace/model';

import type { ChatMessage } from '@/store/chatTypes';
import type { CanvasPreviewWorkspace } from '@/store/previewWorkspace/model';

const SESSION = {
  threadId: 'chat-performance-thread',
  canvasId: 'chat-performance-canvas',
  ownerCanvasId: 'chat-performance-canvas',
  conversationView: null,
} as const;

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index): ChatMessage => {
    if (index % 2 === 0) {
      return {
        id: `user-${index}`,
        role: 'user',
        content: `Representative question ${index / 2 + 1}`,
      };
    }
    return {
      id: `assistant-${index}`,
      role: 'assistant',
      segments: [
        {
          kind: 'text',
          text: `## Representative answer ${(index + 1) / 2}\n\nThis fixture includes **Markdown**, a [link](https://example.com), and enough text to exercise the real historical message renderer.`,
        },
      ],
    };
  });
}

export default function ChatPerformancePlaygroundPage() {
  return new URLSearchParams(window.location.search).get('mode') ===
    'activation' ? (
    <ActivationFixture />
  ) : (
    <ComposerFixture />
  );
}

function ComposerFixture() {
  const params = new URLSearchParams(window.location.search);
  const messageCount = Math.max(
    0,
    Number.parseInt(params.get('messages') ?? '0', 10) || 0,
  );
  const visibleMessageCount = Math.max(
    0,
    Number.parseInt(
      params.get('visibleMessages') ?? String(messageCount),
      10,
    ) || 0,
  );
  const messages = useMemo(
    () =>
      visibleMessageCount === 0
        ? []
        : buildMessages(messageCount).slice(-visibleMessageCount),
    [messageCount, visibleMessageCount],
  );

  return (
    <ChatSessionProvider value={SESSION}>
      <main
        data-chat-performance-fixture={messageCount}
        data-chat-visible-messages={messages.length}
        className="bg-bg-default mx-auto flex h-full w-full max-w-3xl flex-col p-4"
      >
        <MessageList messages={messages} isLoading={false} />
        <div className="pt-3">
          <ThreadChatInput
            onSubmit={() => undefined}
            onStop={() => undefined}
            mode="ask"
          />
        </div>
      </main>
    </ChatSessionProvider>
  );
}

const TAB_IDS = ['a', 'b', 'c'];
const RETAINABLE_TABS = new Set(TAB_IDS);
const NOOP = () => undefined;

function buildTurn(tabId: string, turn: number): ChatMessage[] {
  const historyTurnId = `${tabId}-turn-${turn}`;
  return [
    {
      id: `${historyTurnId}-user`,
      historyTurnId,
      role: 'user',
      content: `Question ${turn}: inspect the cached history for tab ${tabId}.`,
    },
    {
      id: `${historyTurnId}-tool`,
      historyTurnId,
      role: 'assistant',
      segments: [
        { kind: 'thinking', text: 'Inspecting the representative source.' },
        {
          kind: 'tool',
          toolCallId: `${historyTurnId}-read`,
          title: `Read source for turn ${turn}`,
          variant: 'generic',
          toolKind: 'read',
          status: 'completed',
          locations: [{ path: 'src/history.ts', line: turn }],
          content: [
            {
              type: 'content',
              content: { type: 'text', text: `const turn = ${turn};` },
            },
          ],
        },
        {
          kind: 'text',
          text: `## Inspection ${turn}\n\nThe **cached** result contains a [reference](https://example.com) and \`inline code\`.\n\n- Preserve full history\n- Render recent turns\n\n> Older turns stay available.`,
        },
      ],
    },
    {
      id: `${historyTurnId}-answer`,
      historyTurnId,
      role: 'assistant',
      segments: [
        {
          kind: 'text',
          text: `### Result ${turn}\n\n| Property | Value |\n| --- | --- |\n| Tab | ${tabId} |\n| Turn | ${turn} |\n\n\`\`\`ts\nconst cachedTurn = ${turn};\n\`\`\`\n\nThis second assistant message belongs to the same complete user turn.`,
        },
      ],
    },
  ];
}

interface FixtureThread {
  messages: ChatMessage[];
  turnCount: number;
  isLoading: boolean;
  completedTurnId?: string;
}

function requireThread(threads: Record<string, FixtureThread>, id: string) {
  const thread = threads[id];
  if (!thread) throw new Error(`Missing fixture thread: ${id}`);
  return thread;
}

function ActivationPanel({
  tabId,
  active,
  activationId,
  thread,
  recentTurnCount,
}: {
  tabId: string;
  active: boolean;
  activationId: number;
  thread: FixtureThread;
  recentTurnCount: number | undefined;
}) {
  const [mountId] = useState(() => crypto.randomUUID());
  const session = useMemo(
    () => ({ ...SESSION, threadId: `activation-fixture-${tabId}` }),
    [tabId],
  );
  return (
    <ChatSessionProvider value={session}>
      <section
        data-activation-panel={tabId}
        data-preview-active={active}
        data-mount-id={mountId}
        data-activation-id={activationId}
        data-cached-messages={thread.messages.length}
        className="flex min-h-0 flex-1 flex-col"
      >
        <MessageList
          messages={thread.messages}
          isLoading={thread.isLoading}
          isActive={active}
          viewKey={session.threadId}
          recentTurnCount={recentTurnCount}
          olderTurnBatchSize={3}
          activationId={activationId}
          completedTurnId={thread.completedTurnId}
        />
        <div className="pt-3">
          <ThreadChatInput onSubmit={NOOP} onStop={NOOP} mode="ask" />
        </div>
      </section>
    </ChatSessionProvider>
  );
}

function ActivationFixture() {
  const presentation =
    new URLSearchParams(window.location.search).get('presentation') ===
    'full-list'
      ? 'full-list'
      : 'windowed';
  const [threads, setThreads] = useState<Record<string, FixtureThread>>(() => {
    const requested = Number.parseInt(
      new URLSearchParams(window.location.search).get('turns') ?? '100',
      10,
    );
    const turnCount = Math.min(200, Math.max(3, requested || 100));
    return Object.fromEntries(
      TAB_IDS.map((id) => [
        id,
        {
          turnCount,
          isLoading: false,
          messages: Array.from({ length: turnCount }, (_, index) =>
            buildTurn(id, index + 1),
          ).flat(),
        },
      ]),
    );
  });
  const [workspace, setWorkspace] = useState<CanvasPreviewWorkspace>(() => ({
    tabs: Object.fromEntries(
      TAB_IDS.map((id, index) => [
        id,
        {
          id,
          target: {
            kind: 'chat',
            canvasId: SESSION.canvasId,
            threadId: `activation-fixture-${id}`,
          },
          transient: false,
          lastActiveSeq: index === 0 ? 1 : 0,
        },
      ]),
    ),
    groups: [{ id: 'fixture', tabIds: TAB_IDS, activeTabId: 'a' }],
    activeGroupId: 'fixture',
    splitRatio: 0.5,
    activationSeq: 1,
  }));
  const group = workspace.groups[0];
  if (!group?.activeTabId) throw new Error('Missing active fixture group');
  const activeTabId = group.activeTabId;
  const thread = requireThread(threads, activeTabId);
  const retainedTabs = selectRetainedPreviewTabs(
    group,
    workspace,
    RETAINABLE_TABS,
  );

  function updateTurn(complete: boolean) {
    setThreads((current) => {
      const previous = requireThread(current, activeTabId);
      if (previous.isLoading !== complete) return current;
      const turnCount = previous.turnCount + (complete ? 0 : 1);
      const turnId = `${activeTabId}-turn-${turnCount}`;
      return {
        ...current,
        [activeTabId]: {
          turnCount,
          isLoading: !complete,
          completedTurnId: complete ? turnId : previous.completedTurnId,
          messages: complete
            ? previous.messages.map((message) =>
                message.historyTurnId === turnId
                  ? { ...message, historyTurnActive: false }
                  : message,
              )
            : [
                ...previous.messages,
                ...buildTurn(activeTabId, turnCount).map((message) => ({
                  ...message,
                  historyTurnActive: true,
                })),
              ],
        },
      };
    });
  }

  return (
    <main
      data-chat-activation-fixture
      data-build-mode={import.meta.env.PROD ? 'production' : 'development'}
      data-active-tab={activeTabId}
      data-presentation={presentation}
      className="bg-bg-default mx-auto flex h-full w-full max-w-3xl flex-col p-4"
    >
      <nav aria-label="Fixture tabs" className="flex gap-2 pb-2">
        {TAB_IDS.map((id) => (
          <Button
            key={id}
            variant="outline"
            aria-pressed={activeTabId === id}
            onClick={() =>
              setWorkspace((current) =>
                current.groups[0]?.activeTabId === id
                  ? current
                  : activateTab(current, id),
              )
            }
          >
            Tab {id.toUpperCase()}
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={thread.isLoading}
          onClick={() => updateTurn(false)}
        >
          Start turn
        </Button>
        <Button
          variant="outline"
          disabled={!thread.isLoading}
          onClick={() => updateTurn(true)}
        >
          Complete turn
        </Button>
      </nav>
      {retainedTabs.map((tab) => (
        <Activity
          key={tab.id}
          mode={tab.id === activeTabId ? 'visible' : 'hidden'}
        >
          <ActivationPanel
            tabId={tab.id}
            active={tab.id === activeTabId}
            activationId={tab.lastActiveSeq}
            thread={requireThread(threads, tab.id)}
            recentTurnCount={presentation === 'full-list' ? undefined : 3}
          />
        </Activity>
      ))}
    </main>
  );
}
