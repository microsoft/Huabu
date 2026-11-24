// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';
import {
  observeConversationExecution,
  useConversationPreparationStore,
} from '@/store/conversationPreparation';

import { FilePathLink } from './FilePathLink';

const mocks = vi.hoisted(() => ({ openPreviewFile: vi.fn() }));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewFile: mocks.openPreviewFile,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  threadId: 'thread-1',
  canvasId: 'canvas-1',
  ownerCanvasId: 'canvas-1',
  conversationView: null,
};
const execution = (agentletId: string) => ({
  binding: { kind: 'external' as const, alias: 'agent', profileId: 'profile' },
  agentletId,
});
let root: Root;
let container: HTMLDivElement;

function render(path: string, line?: number, compact?: boolean) {
  act(() =>
    root.render(
      <ChatSessionProvider value={session}>
        <FilePathLink path={path} line={line} compact={compact} />
      </ChatSessionProvider>,
    ),
  );
}

beforeEach(() => {
  mocks.openPreviewFile.mockClear();
  useConversationPreparationStore.setState({ executions: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('opens an absolute path on the device that runs the conversation', () => {
  observeConversationExecution('canvas-1', 'thread-1', execution('device-1'));

  render('/repo/src/app.ts', 12, true);

  const button = container.querySelector('button');
  expect(button?.textContent).toBe('app.ts:12');
  // Every box from the list item down may shrink, so a long path truncates.
  for (
    let box: Element | null | undefined = button;
    box && box !== container;
    box = box.parentElement
  ) {
    expect(box.className).toContain('min-w-0');
  }
  act(() => button?.click());
  expect(mocks.openPreviewFile).toHaveBeenCalledExactlyOnceWith(
    { agentletId: 'device-1', path: '/repo/src/app.ts' },
    { threadId: 'thread-1', nodeId: undefined },
  );
});

it.each([
  ['a relative path on a known device', 'device-1', 'src/app.ts'],
  ['an absolute path without a device', undefined, '/repo/src/app.ts'],
])('keeps %s as plain text', (_case, agentletId, path) => {
  if (agentletId) {
    observeConversationExecution('canvas-1', 'thread-1', execution(agentletId));
  }

  render(path);

  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).toBe(path);
});
