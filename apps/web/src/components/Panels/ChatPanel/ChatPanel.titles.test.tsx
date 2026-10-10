// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { DndContext } from '@dnd-kit/core';
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ApiError } from '@/api/_client';
import { agentApi } from '@/api/agent';
import {
  queryConversationTitles,
  setConversationTitle,
} from '@/api/conversationTitles';
import { Button } from '@/components/Common/Button';
import { useConversationTitles } from '@/hooks/useConversationTitles';
import { i18n } from '@/i18n';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { conversationViewForNode } from '@/store/conversationOwner';
import {
  conversationTitleKey,
  getConversationTitle,
  refreshConversationTitles,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
import { useLLMStore } from '@/store/llmStore';
import {
  createEmptyWorkspace,
  openTarget,
} from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import {
  PreviewTab,
  PreviewTabDragOverlay,
} from '../PreviewWorkspace/PreviewTab';

import { ChatPanel } from './index';

import type { AcpConnectionInfo } from './AcpConnectionBadge';
import type { ChatSession } from '@/hooks/useChatSession';
import type * as CanvasStore from '@/store/canvasStore';
import type {
  CanvasPreviewWorkspace,
  PreviewTab as TabModel,
} from '@/store/previewWorkspace/model';
import type { ConversationTitle, AgentStreamEvent } from '@huabu/shared';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const saveCanvasForSubmission = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const sessionMetaState = vi.hoisted(() => ({
  loading: false,
  error: null as Error | null,
  updatedAt: 0,
  refresh: vi.fn(),
}));

// Keep real panel, editor, tab, stores, and stream hook; replace unrelated UI
// and network boundaries with complete, stable fixtures.
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/hooks/useChatHistory', () => ({ useChatHistory: () => {} }));
vi.mock('@/hooks/useAcpProfiles', () => ({
  useAcpProfiles: () => ({ profiles: [], loaded: true, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useAcpSessionMeta', () => ({
  useAcpSessionMeta: () => ({
    meta: {
      selections: {},
      usage: null,
      updatedAt: sessionMetaState.updatedAt,
    },
    source: 'none',
    loading: sessionMetaState.loading,
    error: sessionMetaState.error,
    refresh: sessionMetaState.refresh,
    applyOptimistic: vi.fn(),
  }),
}));
vi.mock('@/hooks/useAcpSlashCommands', () => ({
  useAcpSlashCommands: () => ({
    commands: [],
    loading: false,
    refreshIfStale: vi.fn(),
  }),
}));
vi.mock('@/hooks/useInternalSlashCommands', () => ({
  useInternalSlashCommands: () => ({
    commands: [],
    loading: false,
    refreshIfStale: vi.fn(),
  }),
}));
vi.mock('@/hooks/useBuiltinThreadSettings', () => ({
  useBuiltinThreadSettings: () => ({
    models: [],
    settings: { reasoningEffort: null },
    effectiveModelId: null,
    loading: false,
  }),
}));
vi.mock('@/components/Messages/MessageList', () => ({
  MessageList: () => null,
}));
vi.mock('./ChangeReviewCard', () => ({ ChangeReviewCard: () => null }));
vi.mock('./AgentSelector', () => ({ AgentSelector: () => null }));
vi.mock('./BuiltinSessionSelectors', () => ({
  BuiltinSessionSelectors: () => null,
}));
vi.mock('./ThreadChatInput', () => ({
  ThreadChatInput: ({
    onSubmit,
  }: {
    onSubmit: (
      event: React.FormEvent,
      mode: 'ask',
      draft: string,
    ) => Promise<void>;
  }) => (
    <form
      onSubmit={(event) => {
        void onSubmit(event, 'ask', 'First prompt\nMore detail');
      }}
    >
      <Button type="submit">Send fixture prompt</Button>
    </form>
  ),
}));
vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(),
  setConversationTitle: vi.fn(),
}));
vi.mock('@/api/agent', () => ({
  agentApi: { streamMessage: vi.fn(), stopThread: vi.fn() },
}));
vi.mock('@/store/canvasStore', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasStore>()),
  saveCanvasForSubmission,
}));

const query = vi.mocked(queryConversationTitles);
const save = vi.mocked(setConversationTitle);
const serverTitles = new Map<string, ConversationTitle>();
const finishStreams = new Set<() => void>();

async function loadTitle(
  title: string,
  source: ConversationTitle['source'] = 'acp',
) {
  serverTitles.set(conversationTitleKey('canvas', 'thread'), { title, source });
  await refreshConversationTitles('canvas', ['thread']);
}
const systemLikeTitle =
  'You are a helpful assistant collaborating with a user inside **Huabu**, an infinite visual Space. The user works on an i';
let root: Root;
let container: HTMLDivElement;
const baseSession: ChatSession = {
  canvasId: 'canvas',
  ownerCanvasId: 'canvas',
  threadId: 'thread',
  conversationView: null,
};
const baseTab: TabModel = {
  id: 'tab',
  target: { kind: 'chat', canvasId: 'canvas', threadId: 'thread' },
  transient: false,
  lastActiveSeq: 1,
};

function Tab({
  tab = baseTab,
  onTitleEditorHostChange,
  chatConnection,
}: {
  tab?: TabModel;
  onTitleEditorHostChange?: (element: HTMLSpanElement | null) => void;
  chatConnection?: AcpConnectionInfo;
}) {
  return (
    <PreviewTab
      tab={tab}
      groupId="group"
      isActive
      tabElementId={`tab-${tab.id}`}
      panelElementId={`panel-${tab.id}`}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onPromote={vi.fn()}
      onNavigate={vi.fn()}
      onTitleEditorHostChange={onTitleEditorHostChange}
      chatConnection={chatConnection}
    />
  );
}
function ColdWorkspace({ workspace }: { workspace: CanvasPreviewWorkspace }) {
  useConversationTitles(workspace);
  return (
    <DndContext>
      {Object.values(workspace.tabs).map((tab) => (
        <Tab key={tab.id} tab={tab} />
      ))}
    </DndContext>
  );
}
function PanelFixture({
  session,
  tab,
  onCommit,
  props,
}: {
  session: ChatSession;
  tab: TabModel;
  onCommit: () => void;
  props: Partial<ComponentProps<typeof ChatPanel>>;
}) {
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  const [connection, setConnection] = useState<AcpConnectionInfo | null>(null);
  return (
    <DndContext>
      <Tab
        tab={tab}
        onTitleEditorHostChange={setHost}
        chatConnection={connection ?? undefined}
      />
      <PreviewTabDragOverlay tab={tab} />
      <ChatPanel
        session={session}
        previewTabId="tab"
        onCommit={onCommit}
        titleEditorHost={host}
        onConnectionChange={
          props.hideDuplicateTitle ? setConnection : undefined
        }
        {...props}
      />
    </DndContext>
  );
}
async function renderPanel(
  session = baseSession,
  tab = baseTab,
  onCommit = vi.fn(),
  props: Partial<ComponentProps<typeof ChatPanel>> = {},
) {
  usePreviewWorkspaceStore.setState({
    canvasId: session.canvasId,
    workspace: {
      ...createEmptyWorkspace(),
      tabs: { [tab.id]: tab },
    },
  });
  await act(async () =>
    root.render(
      <PanelFixture
        session={session}
        tab={tab}
        onCommit={onCommit}
        props={props}
      />,
    ),
  );
}
function header() {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="Rename conversation"], button[aria-label="Rename node"]',
  )!;
}
function title() {
  return container.querySelector('[data-testid="preview-tab-title"]')
    ?.textContent;
}
async function edit(value: string) {
  await act(async () => header().click());
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Rename conversation"], input[aria-label="Rename node"]',
  )!;
  expect(input.maxLength).toBe(120);
  await fillTitle(input, value);
  return input;
}
async function fillTitle(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    assert(setValue);
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  sessionMetaState.loading = false;
  sessionMetaState.error = null;
  sessionMetaState.updatedAt = 0;
  serverTitles.clear();
  await i18n.changeLanguage('en');
  useConversationTitleStore.setState({
    entries: {},
    pending: {},
    refreshEpoch: 0,
  });
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    settingsByThread: {},
    lastActionByThread: {},
    selectionAttachment: null,
  });
  useChatStore.getState().setHistoryLoaded('thread', true);
  useChatStore.getState().setHistoryLoaded('other', true);
  useLLMStore.setState({
    config: { provider: 'test', model: 'test', authenticated: true },
    loading: false,
  });
  useAcpThreadChangesStore.setState({ load: async () => {} });
  useCanvasStore.setState({
    canvasId: 'canvas',
    nodes: [],
    edges: [],
    flushCanvasEvents: async () => {},
    getAgentChatContext: () => ({ selectedNodes: [] }),
  });
  query.mockImplementation(async ({ canvasId, threadIds }) => ({
    titles: Object.fromEntries(
      threadIds.map((id) => [
        id,
        serverTitles.get(conversationTitleKey(canvasId, id)) ?? {
          title: null,
          source: null,
        },
      ]),
    ),
  }));
  save.mockImplementation(async (canvasId, threadId, { title }) => {
    const value: ConversationTitle = { title, source: 'user' };
    serverTitles.set(conversationTitleKey(canvasId, threadId), value);
    return value;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    for (const finish of finishStreams) finish();
    finishStreams.clear();
  });
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('rendered conversation titles', () => {
  it.each(['connected', 'connecting', 'failed'] as const)(
    'moves the %s capability status to the tab without losing failure recovery',
    async (status) => {
      useChatStore.getState().setAgentBinding('thread', {
        kind: 'external',
        profileId: 'fixture',
        alias: 'Fixture',
      });
      sessionMetaState.loading = status === 'connecting';
      sessionMetaState.error =
        status === 'failed' ? new Error('Cache unavailable') : null;
      await renderPanel(baseSession, baseTab, vi.fn(), {
        hideDuplicateTitle: true,
      });
      const dot = container.querySelector(
        `[data-acp-connection-status="${status}"]`,
      );
      assert(dot);
      expect(dot.closest('[role="tab"]')).not.toBeNull();
      expect(
        dot.parentElement?.querySelector('[data-testid="preview-tab-icon"]'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-acp-connection-status]'),
      ).toHaveLength(1);
      expect(dot.classList.contains('absolute')).toBe(true);
      const alert = container.querySelector('[role="alert"]');
      if (status === 'failed') {
        expect(alert?.textContent).toContain('Fixture');
        expect(alert?.textContent).toContain('Cache unavailable');
        await act(async () =>
          alert?.querySelector<HTMLButtonElement>('button')?.click(),
        );
        expect(sessionMetaState.refresh).toHaveBeenCalledOnce();
      } else {
        expect(alert).toBeNull();
      }
      await act(async () => {
        useChatStore.getState().setAgentBinding('thread', { kind: 'internal' });
      });
      expect(
        container.querySelector('[data-acp-connection-status]'),
      ).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('removes an otherwise empty Question header after moving its status to the tab', async () => {
    const node = {
      id: 'question',
      type: 'question',
      position: { x: 0, y: 0 },
      data: {
        label: 'External question',
        status: 'done',
        threadId: 'thread',
        agentBinding: {
          kind: 'external',
          profileId: 'fixture',
          alias: 'Fixture',
        },
      },
    };
    useCanvasStore.setState({ nodes: [node] });
    await renderPanel(
      {
        ...baseSession,
        conversationView: conversationViewForNode(node, 'canvas'),
      },
      {
        ...baseTab,
        target: { kind: 'node', canvasId: 'canvas', nodeId: node.id },
      },
      vi.fn(),
      { hideDuplicateTitle: true },
    );
    expect(
      container.querySelector('[role="tab"] [data-acp-connection-status]'),
    ).not.toBeNull();
    expect(container.querySelector('.h-9')).toBeNull();
  });

  it('hides the duplicate title but retains connection and save controls, and waits for hydration before renaming', async () => {
    useChatStore.getState().setHistoryLoaded('thread', false);
    useChatStore.getState().setAgentBinding('thread', {
      kind: 'external',
      profileId: 'fixture',
      alias: 'Fixture',
    });
    await loadTitle('Existing topic');
    const handled = vi.fn();
    const props = {
      hideDuplicateTitle: true,
      renameRequestNonce: 1,
      onRenameRequestHandled: handled,
    };
    await renderPanel(baseSession, baseTab, vi.fn(), props);
    expect(header()).toBeNull();
    expect(
      container.querySelector('input[aria-label="Rename conversation"]'),
    ).toBeNull();
    expect(handled).not.toHaveBeenCalled();
    const saveButton = container.querySelector(
      `button[aria-label="${i18n.t('chat.saveAsQuestion')}"]`,
    );
    expect(saveButton).not.toBeNull();
    expect(saveButton?.classList.contains('[&_svg]:h-3.25')).toBe(true);
    expect(saveButton?.classList.contains('min-h-6')).toBe(true);
    expect(saveButton?.classList.contains('text-fg-muted')).toBe(true);
    expect(
      container.querySelector(
        '[role="tab"] [data-acp-connection-status="connected"]',
      ),
    ).not.toBeNull();
    await act(async () =>
      useChatStore.getState().setHistoryLoaded('thread', true),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Rename conversation"]',
    );
    assert(input);
    expect(input.value).toBe('Existing topic');
    expect(handled).toHaveBeenCalledExactlyOnceWith(1);
    expect(document.activeElement).toBe(input);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(header()).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await renderPanel(baseSession, baseTab, vi.fn(), props);
    expect(
      container.querySelector('input[aria-label="Rename conversation"]'),
    ).toBeNull();
  });

  it('uses the existing durable conversation save and promotion for a tab rename request', async () => {
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Question' });
    await loadTitle('Existing topic');
    const onCommit = vi.fn();
    await renderPanel(baseSession, baseTab, onCommit, {
      hideDuplicateTitle: true,
      renameRequestNonce: 1,
    });
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Rename conversation"]',
    );
    assert(input);
    await fillTitle(input, 'Updated topic');
    await enter(input);
    expect(save).toHaveBeenCalledWith('canvas', 'thread', {
      title: 'Updated topic',
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(title()).toBe('Updated topic');
    expect(header()).toBeNull();
  });

  it('retains failure feedback and retry when the display title is hidden', async () => {
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Question' });
    await loadTitle('Original');
    await renderPanel(baseSession, baseTab, vi.fn(), {
      hideDuplicateTitle: true,
      renameRequestNonce: 1,
    });
    save.mockRejectedValueOnce(new Error('Offline'));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Rename conversation"]',
    );
    assert(input);
    await fillTitle(input, 'Attempted');
    await enter(input);
    expect(title()).toBe('Original');
    expect(header()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Offline',
    );
    const retry = container.querySelector<HTMLButtonElement>(
      '[role="alert"] button',
    );
    assert(retry);
    await act(async () => retry.click());
    expect(title()).toBe('Attempted');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('preserves a missing external Profile on an empty standalone conversation', async () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'deleted-profile',
      alias: 'Deleted Agent',
    };
    useChatStore.getState().setAgentBinding('thread', binding);
    await renderPanel();
    expect(useChatStore.getState().threadsById.thread.binding).toEqual(binding);
    expect(useChatStore.getState().threadsById.thread.messages).toEqual([]);
  });

  it('displays valid system-like ACP fallback in all title surfaces and upgrades it to generation', async () => {
    const key = conversationTitleKey('canvas', 'thread');
    useConversationTitleStore.setState({
      entries: {
        [key]: {
          value: { title: systemLikeTitle, source: 'acp' },
          revision: 9,
          durable: true,
        },
      },
    });
    await renderPanel();
    const overlay = () =>
      container.querySelector('[data-testid="preview-tab-drag-overlay"]');
    expect(header().textContent).toBe(systemLikeTitle);
    expect(title()).toBe(systemLikeTitle);
    expect(overlay()?.textContent).toBe(systemLikeTitle);
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'Actual question', source: 'generated' } },
    });
    await act(async () => refreshConversationTitles('canvas', ['thread']));
    expect(header().textContent).toBe('Actual question');
    expect(title()).toBe('Actual question');
    expect(overlay()?.textContent).toBe('Actual question');
    await enter(await edit(systemLikeTitle));
    expect(header().textContent).toBe(systemLikeTitle);
    expect(title()).toBe(systemLikeTitle);
    expect(overlay()?.textContent).toBe(systemLikeTitle);
  });

  it('projects lower-ranked backend names and null into every title surface', async () => {
    await loadTitle('Generated', 'generated');
    await renderPanel();
    await act(async () => loadTitle('Backend fallback', 'fallback'));
    expect(header().textContent).toBe('Backend fallback');
    expect(title()).toBe('Backend fallback');
    expect(
      container.querySelector('[data-testid="preview-tab-drag-overlay"]')
        ?.textContent,
    ).toBe('Backend fallback');
    query.mockResolvedValueOnce({
      titles: { thread: { title: null, source: null } },
    });
    await act(async () => refreshConversationTitles('canvas', ['thread']));
    expect(header().textContent).toBe('New conversation');
    expect(title()).toBe('New conversation');
    expect(
      container.querySelector('[data-testid="preview-tab-drag-overlay"]')
        ?.textContent,
    ).toBe('New conversation');
  });

  it('constrains the real header tooltip wrapper and inner text while reserving badge and save controls', async () => {
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Question' });
    useChatStore.getState().setAgentBinding('thread', {
      kind: 'external',
      profileId: 'fixture',
      alias: 'Fixture',
    });
    await loadTitle('Long valid topic '.repeat(7).trim());
    await renderPanel();
    const button = header();
    const wrapper = button.parentElement;
    const text = button.querySelector('span');
    assert(wrapper && text);
    const titleGroup = wrapper.parentElement;
    const titleSlot = titleGroup?.parentElement;
    assert(titleGroup && titleSlot);
    for (const element of [text, button, wrapper, titleGroup, titleSlot]) {
      expect(element.classList.contains('min-w-0')).toBe(true);
      expect(element.classList.contains('max-w-full')).toBe(true);
    }
    expect(wrapper.classList.contains('inline-flex')).toBe(true);
    expect(wrapper.classList.contains('shrink')).toBe(true);
    expect(wrapper.classList.contains('basis-auto')).toBe(true);
    expect(text.classList.contains('truncate')).toBe(true);
    const badge = wrapper.nextElementSibling;
    assert(badge);
    expect(badge.classList.contains('shrink-0')).toBe(true);
    expect(badge.querySelector('[aria-label]')).not.toBeNull();
    const tools = titleSlot.nextElementSibling;
    assert(tools);
    expect(tools.classList.contains('shrink-0')).toBe(true);
    expect(tools.querySelector('button')).not.toBeNull();
    const tabText = container.querySelector(
      '[data-testid="preview-tab-title"]',
    );
    assert(tabText?.parentElement);
    expect(tabText.classList.contains('truncate')).toBe(true);
    expect(tabText.parentElement.classList.contains('min-w-0')).toBe(true);
    expect(tabText.parentElement.classList.contains('flex-1')).toBe(true);
    const input = await edit('Shorter topic');
    expect(input.classList.contains('min-w-0')).toBe(true);
    expect(input.classList.contains('shrink')).toBe(true);
  });

  it('updates both rendered names from server generation and isolates the same thread in another namespace', async () => {
    await renderPanel();
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'Generated topic', source: 'generated' } },
    });
    await act(async () => refreshConversationTitles('canvas', ['thread']));
    expect(header().textContent).toBe('Generated topic');
    expect(title()).toBe('Generated topic');
    await renderPanel(
      {
        ...baseSession,
        canvasId: 'other-canvas',
        ownerCanvasId: 'other-canvas',
      },
      {
        ...baseTab,
        target: { kind: 'chat', canvasId: 'other-canvas', threadId: 'thread' },
      },
    );
    expect(title()).toBe('New conversation');
    expect(header().textContent).toBe('New conversation');
    const input = await edit('Other namespace draft');
    await act(async () =>
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
    );
    expect(title()).toBe('Other namespace draft');
    expect(header().textContent).toBe('Other namespace draft');
    expect(getConversationTitle('canvas', 'thread').title).toBe(
      'Generated topic',
    );
  });
  it('uses the same generic, ACP, and manual title in the actual panel header and tab', async () => {
    await renderPanel();
    expect(header().textContent).toBe('New conversation');
    expect(title()).toBe('New conversation');
    await act(async () => loadTitle('ACP topic'));
    expect(header().textContent).toBe('ACP topic');
    expect(title()).toBe('ACP topic');
    const input = await edit('Manual topic');
    await enter(input);
    expect(save).toHaveBeenCalledTimes(1);
    expect(header().textContent).toBe('Manual topic');
    expect(title()).toBe('Manual topic');
    await act(async () => refreshConversationTitles('canvas', ['thread']));
    expect(title()).toBe('Manual topic');
  });

  it('cancels Escape without blur committing and persists pre-send manual edits', async () => {
    await renderPanel();
    let input = await edit('Cancel me');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(title()).toBe('New conversation');
    expect(save).not.toHaveBeenCalled();
    input = await edit('Draft name');
    await enter(input);
    expect(title()).toBe('Draft name');
    expect(header().textContent).toBe('Draft name');
    expect(save).not.toHaveBeenCalled();
    expect(
      useConversationTitleStore.getState().pending[
        conversationTitleKey('canvas', 'thread')
      ],
    ).toBe('Draft name');
  });

  it('does not derive titles from submitted messages or raw ACP events and flushes a pre-send rename', async () => {
    let event!: (event: AgentStreamEvent) => void;
    let complete!: () => void;
    let release!: () => void;
    vi.mocked(agentApi.streamMessage).mockImplementation(
      async (_prompt, _thread, _mode, callbacks) => {
        event = callbacks.onEvent;
        complete = callbacks.onComplete!;
        await new Promise<void>((resolve) => {
          release = resolve;
          finishStreams.add(() => {
            complete();
            resolve();
          });
        });
      },
    );
    await renderPanel();
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(title()).toBe('New conversation');
    expect(header().textContent).toBe('New conversation');
    expect(query).not.toHaveBeenCalled();
    await act(async () =>
      event({ type: 'text_delta', data: { content: 'Answer' } }),
    );
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () =>
      event({ type: 'session_info_update', data: { title: systemLikeTitle } }),
    );
    expect(title()).toBe('New conversation');
    expect(header().textContent).toBe('New conversation');
    expect(query).toHaveBeenCalledTimes(2);
    serverTitles.set(conversationTitleKey('canvas', 'thread'), {
      title: 'Generated topic',
      source: 'generated',
    });
    await act(async () =>
      event({ type: 'session_info_update', data: { title: 'Late ACP title' } }),
    );
    expect(header().textContent).toBe('Generated topic');
    expect(title()).toBe('Generated topic');
    await act(async () => {
      complete();
      release();
    });
    expect(query).toHaveBeenCalledTimes(4);

    // A separate brand-new thread queues its title without a durable endpoint.
    useChatStore.getState().setHistoryLoaded('draft-thread', true);
    await renderPanel(
      { ...baseSession, threadId: 'draft-thread' },
      {
        ...baseTab,
        target: { kind: 'chat', canvasId: 'canvas', threadId: 'draft-thread' },
      },
    );
    await enter(await edit('Pre-send user name'));
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(title()).toBe('Pre-send user name');
    await act(async () =>
      event({ type: 'session_info_update', data: { title: 'ACP title' } }),
    );
    expect(save).toHaveBeenCalledWith('canvas', 'draft-thread', {
      title: 'Pre-send user name',
    });
    await act(async () => {
      complete();
      release();
    });
    expect(title()).toBe('Pre-send user name');
  });

  it('keeps a rename during the first send pending until the first stream event', async () => {
    let event!: (event: AgentStreamEvent) => void;
    let complete!: () => void;
    let release!: () => void;
    vi.mocked(agentApi.streamMessage).mockImplementation(
      async (_prompt, _thread, _mode, callbacks) => {
        event = callbacks.onEvent;
        assert(callbacks.onComplete);
        complete = callbacks.onComplete;
        await new Promise<void>((resolve) => {
          release = resolve;
          finishStreams.add(() => {
            complete();
            resolve();
          });
        });
      },
    );
    await renderPanel();
    const form = container.querySelector('form');
    assert(form);
    await act(async () =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    save.mockRejectedValueOnce(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable yet'),
    );
    await enter(await edit('First-send name'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(header().textContent).toBe('First-send name');
    expect(title()).toBe('First-send name');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      useConversationTitleStore.getState().pending[
        conversationTitleKey('canvas', 'thread')
      ],
    ).toBe('First-send name');
    await act(async () =>
      event({ type: 'text_delta', data: { content: 'Answer' } }),
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(useConversationTitleStore.getState().pending).toEqual({});
    await act(async () => {
      complete();
      release();
    });
    expect(title()).toBe('First-send name');
    expect(header().textContent).toBe('First-send name');
  });

  it('rolls back failed saves in both views and exposes Retry', async () => {
    await act(async () => loadTitle('Original'));
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Prompt' });
    await renderPanel();
    save.mockRejectedValueOnce(new Error('Offline'));
    await enter(await edit('Attempted'));
    expect(title()).toBe('Original');
    expect(header().textContent).toBe('Original');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Offline',
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[role="alert"] button')!
        .click(),
    );
    expect(title()).toBe('Attempted');
    expect(header().textContent).toBe('Attempted');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not let a delayed rename response alter another thread or call its commit callback', async () => {
    let resolve!: (value: ConversationTitle) => void;
    save.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await loadTitle('Original');
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Prompt' });
    const onCommit = vi.fn();
    await renderPanel(baseSession, baseTab, onCommit);
    await enter(await edit('Saved on old thread'));
    await renderPanel(
      { ...baseSession, threadId: 'other' },
      {
        ...baseTab,
        target: { kind: 'chat', canvasId: 'canvas', threadId: 'other' },
      },
    );
    await act(async () =>
      resolve({ title: 'Saved on old thread', source: 'user' }),
    );
    expect(header().textContent).toBe('New conversation');
    expect(title()).toBe('New conversation');
    expect(onCommit).not.toHaveBeenCalled();
    expect(getConversationTitle('canvas', 'thread').title).toBe(
      'Saved on old thread',
    );
  });

  it.each([false, true])(
    'keeps Questions on canonical node labels without a title PUT (tab editor: %s)',
    async (hideDuplicateTitle) => {
      const node = {
        id: 'question',
        type: 'question',
        position: { x: 0, y: 0 },
        data: {
          label: 'Canonical',
          labelSource: 'user',
          status: 'done',
          threadId: 'thread',
        },
      };
      const tryRename = vi.fn(async (_kind, _id, label) => {
        useCanvasStore.setState({
          nodes: [{ ...node, data: { ...node.data, label } }],
        });
        return true;
      });
      useCanvasStore.setState({ nodes: [node], tryRename });
      await loadTitle('Irrelevant cached title');
      await renderPanel(
        {
          ...baseSession,
          conversationView: conversationViewForNode(node, 'canvas'),
        },
        {
          ...baseTab,
          target: { kind: 'node', canvasId: 'canvas', nodeId: 'question' },
        },
        vi.fn(),
        {
          hideDuplicateTitle,
          renameRequestNonce: hideDuplicateTitle ? 1 : undefined,
        },
      );
      expect(title()).toBe('Canonical');
      if (hideDuplicateTitle) {
        expect(header()).toBeNull();
        const input =
          container.querySelector<HTMLInputElement>('[role="tab"] input');
        assert(input);
        expect(input.value).toBe('Canonical');
        await fillTitle(input, 'Renamed node');
        await enter(input);
      } else {
        expect(header().textContent).toBe('Canonical');
        await enter(await edit('Renamed node'));
      }
      expect(tryRename).toHaveBeenCalledWith(
        'node',
        'question',
        'Renamed node',
      );
      expect(save).not.toHaveBeenCalled();
      if (hideDuplicateTitle) expect(header()).toBeNull();
      else expect(header().textContent).toBe('Renamed node');
      expect(title()).toBe('Renamed node');
    },
  );

  it('transfers the effective manual name when the actual panel saves a Question', async () => {
    const addNode = vi.fn((input) =>
      useCanvasStore.setState({
        nodes: [
          {
            id: input.id,
            type: input.nodeType,
            data: input.data,
            position: { x: 0, y: 0 },
          },
        ],
      }),
    );
    const replaceTabTarget = vi.fn();
    useCanvasStore.setState({ addNode });
    usePreviewWorkspaceStore.setState({ replaceTabTarget });
    useChatStore
      .getState()
      .addMessage('thread', { id: 'u', role: 'user', content: 'Prompt' });
    await renderPanel();
    await enter(await edit('Keep this name'));
    const saveButton = container.querySelector<HTMLButtonElement>(
      'button:has(svg.lucide-bookmark)',
    )!;
    await act(async () => saveButton.click());
    expect(addNode.mock.calls[0][0].data).toMatchObject({
      label: 'Keep this name',
      labelSource: 'user',
      threadId: 'thread',
    });
    expect(replaceTabTarget).toHaveBeenCalledOnce();
  });

  it('batch hydrates ALL cold tabs, retries errors, and finds post-stream generation within a bounded window', async () => {
    vi.useFakeTimers();
    let workspace = createEmptyWorkspace();
    for (let index = 0; index < 205; index++)
      workspace = openTarget(
        workspace,
        { kind: 'chat', canvasId: 'canvas', threadId: `cold-${index}` },
        {},
        { tabId: `cold-${index}` },
      ).workspace;
    query.mockRejectedValueOnce(new Error('Offline'));
    query.mockImplementation(async ({ threadIds }) => ({
      titles: Object.fromEntries(
        threadIds.map((id) => [
          id,
          { title: `Fallback ${id}`, source: 'fallback' },
        ]),
      ),
    }));
    await act(async () => root.render(<ColdWorkspace workspace={workspace} />));
    expect(query.mock.calls.map(([body]) => body.threadIds.length)).toEqual([
      100, 100, 5,
    ]);
    query.mockImplementation(async ({ threadIds }) => ({
      titles: Object.fromEntries(
        threadIds.map((id) => [
          id,
          { title: `Generated ${id}`, source: 'generated' },
        ]),
      ),
    }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      container.querySelector(
        '[data-preview-tab-id="cold-0"] [data-testid="preview-tab-title"]',
      )?.textContent,
    ).toBe('Generated cold-0');
    expect(
      container.querySelector(
        '[data-preview-tab-id="cold-204"] [data-testid="preview-tab-title"]',
      )?.textContent,
    ).toBe('Generated cold-204');
    const calls = query.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(query).toHaveBeenCalledTimes(calls);
  });

  it('stops retrying a permanent fallback rather than polling forever', async () => {
    vi.useFakeTimers();
    const workspace = openTarget(
      createEmptyWorkspace(),
      baseTab.target,
      {},
      { tabId: baseTab.id },
    ).workspace;
    query.mockResolvedValue({
      titles: { thread: { title: 'Fallback forever', source: 'fallback' } },
    });
    await act(async () => root.render(<ColdWorkspace workspace={workspace} />));
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(query).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(query).toHaveBeenCalledTimes(6);
    expect(title()).toBe('Fallback forever');
  });
});
