// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { useRemoteConversationOwnerStore } from '@/store/remoteConversationOwner';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { SpaceConversationPreview } from './SpaceConversationPreview';

import type { ChatSession } from '@/hooks/useChatSession';

const mocks = vi.hoisted(() => ({
  getOwner: vi.fn(),
  navigate: vi.fn(),
  chat: vi.fn(),
  invalidateTitle: vi.fn(),
}));
vi.mock('@/store/conversationTitleStore', () => ({
  invalidateConversationTitle: mocks.invalidateTitle,
}));
vi.mock('@/api/agent', () => ({ getAgentConversationOwner: mocks.getOwner }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}: ${options.name}` : key,
  }),
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (state: { canvasId: string }) => unknown) =>
    select({ canvasId: 'parent' }),
}));
vi.mock('../ChatPanel', () => ({
  ChatPanel: ({
    session,
    ownerUnavailable,
  }: {
    session: ChatSession;
    ownerUnavailable?: boolean;
  }) => {
    mocks.chat(session);
    return (
      <div
        data-chat-thread={session.threadId}
        data-unavailable={ownerUnavailable}
      >
        Original conversation
        <input aria-label="Draft" />
      </div>
    );
  },
}));

const target = {
  kind: 'conversation',
  canvasId: 'child',
  nodeId: 'agent',
  threadId: 'thread',
} as const;
const owner = {
  ...target,
  spaceTitle: 'Child Space',
  source: { agentBinding: { kind: 'internal' }, status: 'done' },
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  useRemoteConversationOwnerStore.setState({ entries: {} });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    spaceTitles: {},
    isReady: true,
    isSyncing: false,
  });
  mocks.getOwner.mockResolvedValue(owner);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render() {
  await act(async () => {
    root.render(
      <SpaceConversationPreview target={target} previewTabId="tab" />,
    );
  });
}

it('centers loading feedback with an inline information icon and no Retry', async () => {
  let resolveOwner!: (value: typeof owner) => void;
  mocks.getOwner.mockReturnValueOnce(
    new Promise<typeof owner>((resolve) => {
      resolveOwner = resolve;
    }),
  );
  await render();
  const status = host.querySelector('[role="status"]');
  expect(status?.classList.contains('grid-rows-[1fr_auto_2fr]')).toBe(true);
  expect(status?.querySelector('p')?.textContent).toBe(
    'remoteConversation.loading',
  );
  expect(
    status
      ?.querySelector('p')
      ?.previousElementSibling?.querySelector('svg.lucide-info'),
  ).not.toBeNull();
  expect(status?.querySelector('button')).toBeNull();
  await act(async () => resolveOwner(owner));
  expect(host.querySelector('[data-chat-thread="thread"]')).not.toBeNull();
});

it('opens only after validating the owner and preserves the original session address', async () => {
  await render();
  expect(mocks.getOwner).toHaveBeenCalledWith('child', 'thread');
  expect(mocks.chat).toHaveBeenLastCalledWith({
    canvasId: 'parent',
    ownerCanvasId: 'child',
    threadId: 'thread',
    conversationView: {
      presentationAnchor: { canvasId: 'child', nodeId: 'agent' },
      conversationOwner: {
        canvasId: 'child',
        nodeId: 'agent',
        threadId: 'thread',
      },
    },
  });
  expect(host.textContent).toContain('Child Space');
  expect(mocks.navigate).not.toHaveBeenCalled();
  const open = host.querySelector<HTMLButtonElement>('button');
  expect(open?.textContent).toBe('Child Space');
  expect(open?.getAttribute('aria-label')).toBe(
    'Child Space: remoteConversation.openSpace',
  );
  act(() => open?.click());
  expect(mocks.navigate).toHaveBeenCalledWith('/canvas/child?node=agent', {
    state: { returnToSpace: 'parent', workspaceId: 'workspace' },
  });
});

it('shows unavailable ownership explicitly and retries without creating a replacement conversation', async () => {
  mocks.getOwner.mockRejectedValueOnce(new Error('Source Space was deleted'));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Source Space was deleted',
  );
  expect(mocks.chat).not.toHaveBeenCalled();
  const retry = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'remoteConversation.retry',
  );
  await act(async () => retry?.click());
  expect(host.querySelector('[data-chat-thread="thread"]')).not.toBeNull();
});

it('cancels outgoing native drags before cards build payloads without blocking incoming drops', async () => {
  await render();
  const chat = host.querySelector('[data-chat-thread]');
  assert(chat);
  const payloadHandler = vi.fn();
  chat.addEventListener('dragstart', payloadHandler);
  for (const tag of ['img', 'a', 'span']) {
    const source = document.createElement(tag);
    chat.append(source);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    source.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  }
  expect(payloadHandler).not.toHaveBeenCalled();

  const input = host.querySelector('input');
  assert(input);
  const dropHandler = vi.fn();
  input.addEventListener('drop', dropHandler);
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  input.dispatchEvent(drop);
  expect(dropHandler).toHaveBeenCalledOnce();
  expect(drop.defaultPrevented).toBe(false);
});

it('refuses a replacement owner rather than silently retargeting the tab', async () => {
  mocks.getOwner.mockResolvedValue({ ...owner, nodeId: 'different-agent' });
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'owner changed',
  );
  expect(mocks.chat).not.toHaveBeenCalled();
});

it('shows a neutral missing-owner status with the remembered Space name and no Retry', async () => {
  await render();
  expect(host.querySelector('[data-chat-thread="thread"]')).not.toBeNull();
  mocks.getOwner.mockRejectedValueOnce(
    new ApiError(404, { code: 'conversation_owner_missing' }, 'Owner missing'),
  );
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(host.querySelector('[data-chat-thread]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    'remoteConversation.sourceNodeMissing',
  );
  expect(
    host.querySelector('[role="status"] [aria-hidden] svg'),
  ).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain('remoteConversation.retry');
  expect(host.querySelector('button')?.textContent).toBe('Child Space');
});

it.each([
  ['Saved Space', 'Saved Space'],
  [null, 'spacePreview.untitledSpace'],
  [undefined, 'child'],
])(
  'uses the cached Space title %s before an owner has been loaded',
  async (title, expected) => {
    if (title !== undefined)
      useWorkspaceStore.getState().setSpaceTitle('child', title);
    mocks.getOwner.mockRejectedValueOnce(
      new ApiError(
        404,
        { code: 'conversation_owner_missing' },
        'Owner missing',
      ),
    );
    await render();
    expect(host.querySelector('[role="status"] p')?.textContent).toBe(
      'remoteConversation.sourceNodeMissing',
    );
    expect(host.querySelector('button')?.textContent).toBe(expected);
    expect(host.textContent).not.toContain('remoteConversation.retry');
    expect(mocks.chat).not.toHaveBeenCalled();
  },
);

it('can recover a missing owner on the next poll without a Retry button', async () => {
  vi.useFakeTimers();
  await render();
  mocks.getOwner.mockRejectedValueOnce(
    new ApiError(404, { code: 'conversation_owner_missing' }, 'Owner missing'),
  );
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelector('[data-chat-thread]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[data-chat-thread="thread"]')).not.toBeNull();
});

it.each([
  ['missing_node_content', 'sourceNodeContentUnavailable'],
  ['canvas_not_found', 'sourceSpaceUnavailable'],
])(
  'explains %s on the next poll and recovers on Retry',
  async (code, message) => {
    vi.useFakeTimers();
    await render();
    mocks.getOwner.mockRejectedValueOnce(
      new ApiError(404, { code }, 'Internal lookup details'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(mocks.getOwner).toHaveBeenCalledTimes(1);
    expect(
      host
        .querySelector('[data-chat-thread]')
        ?.getAttribute('data-unavailable'),
    ).toBe('false');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getOwner).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-chat-thread]')).toBeNull();
    expect(host.querySelector('[role="alert"] p')?.textContent).toBe(
      `remoteConversation.${message}`,
    );
    const retry = host.querySelector<HTMLButtonElement>(
      '[role="alert"] button',
    );
    assert(retry);
    await act(async () => retry.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-chat-thread="thread"]')).not.toBeNull();
    expect(
      Object.values(useRemoteConversationOwnerStore.getState().entries)[0],
    ).not.toHaveProperty('errorCode');
  },
);

it('does not label an unrelated lookup failure as a deleted source', async () => {
  mocks.getOwner.mockRejectedValueOnce(
    new ApiError(404, {}, 'Lookup route unavailable'),
  );
  await render();
  expect(host.querySelector('[role="alert"] p')?.textContent).toBe(
    'Lookup route unavailable',
  );
});

it('centers a blocking workspace error using the same empty state and keeps Retry', async () => {
  const message =
    'Workspace has not been configured yet. Please set a workspace path first.';
  mocks.getOwner.mockRejectedValueOnce(new ApiError(503, {}, message));
  await render();
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.classList.contains('grid-rows-[1fr_auto_2fr]')).toBe(true);
  expect(alert?.querySelector('svg.lucide-info')).not.toBeNull();
  expect(alert?.querySelector('p')?.textContent).toBe(message);
  expect(alert?.querySelector('button')?.textContent).toBe(
    'remoteConversation.retry',
  );
  expect(mocks.chat).not.toHaveBeenCalled();
});

it.each([
  new TypeError('Failed to fetch'),
  new ApiError(503, {}, 'Temporarily unavailable'),
])(
  'retains the mounted conversation and focused draft on transient failure: %s',
  async (error) => {
    await render();
    const input = host.querySelector('input');
    assert(input);
    input.value = 'Unsent draft';
    input.focus();
    mocks.getOwner.mockRejectedValueOnce(error);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Unsent draft');
    expect(
      host
        .querySelector('[data-chat-thread]')
        ?.getAttribute('data-unavailable'),
    ).toBe('true');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      host.querySelector('[role="alert"]')?.classList.contains('shrink-0'),
    ).toBe(true);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('input')).toBe(input);
    expect(
      host
        .querySelector('[data-chat-thread]')
        ?.getAttribute('data-unavailable'),
    ).toBe('false');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

it('invalidates the shared title when source metadata changes', async () => {
  await render();
  mocks.getOwner.mockResolvedValue({
    ...owner,
    source: { ...owner.source, label: 'Renamed' },
  });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mocks.invalidateTitle).toHaveBeenCalledWith('child', 'thread');
});
