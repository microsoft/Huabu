// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type * as AgentApiModule from '../src/api/agent';
import type * as ReviewModule from '../src/components/Panels/ChatPanel/ChangeReviewCard';
import type * as ComposerModule from '../src/components/Panels/ChatPanel/ThreadChatInput';
import type * as StreamModule from '../src/hooks/useAgentStream';
import type * as SessionModule from '../src/hooks/useChatSession';
import type * as ChangesModule from '../src/store/acpThreadChangesStore';
import type * as CanvasModule from '../src/store/canvasStore';
import type * as ChatModule from '../src/store/chatStore';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

interface QueueHarness {
  sent: string[];
  finish: () => void;
}

test.use({ hasTouch: false });

test('queues, removes, pauses and resumes through the real composer', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/playground/chat-performance?messages=0');
  await expect(page.locator('textarea[name="agent-message"]')).toBeVisible();
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const composerPath = '/src/components/Panels/ChatPanel/ThreadChatInput.tsx';
    const reviewPath = '/src/components/Panels/ChatPanel/ChangeReviewCard.tsx';
    const changesPath = '/src/store/acpThreadChangesStore.ts';
    const streamPath = '/src/hooks/useAgentStream.ts';
    const sessionPath = '/src/hooks/useChatSession.ts';
    const chatPath = '/src/store/chatStore.ts';
    const canvasPath = '/src/store/canvasStore.ts';
    const apiPath = '/src/api/agent.ts';
    const [
      { default: React },
      { default: ReactDOM },
      { ThreadChatInput },
      { ChangeReviewCard },
      { useAcpThreadChangesStore },
      { useAgentStream },
      { ChatSessionProvider },
      { useChatStore },
      { default: canvas },
      { agentApi },
    ] = await Promise.all([
      import(reactPath) as Promise<{ default: typeof ReactModule }>,
      import(domPath) as Promise<{ default: typeof DomModule }>,
      import(composerPath) as Promise<typeof ComposerModule>,
      import(reviewPath) as Promise<typeof ReviewModule>,
      import(changesPath) as Promise<typeof ChangesModule>,
      import(streamPath) as Promise<typeof StreamModule>,
      import(sessionPath) as Promise<typeof SessionModule>,
      import(chatPath) as Promise<typeof ChatModule>,
      import(canvasPath) as Promise<typeof CanvasModule>,
      import(apiPath) as Promise<typeof AgentApiModule>,
    ]);
    const session = {
      threadId: 'queue-e2e',
      canvasId: '',
      ownerCanvasId: '',
      conversationView: null,
    };
    canvas
      .getState()
      ._setStateNoAutosave({ canvasId: '', nodes: [], edges: [] });
    useChatStore
      .getState()
      .setAgentBinding(session.threadId, { kind: 'internal' });
    useAcpThreadChangesStore.setState({
      byThread: {
        [session.threadId]: [
          {
            id: 'queue-layout-change',
            kind: 'create',
            label: 'Created: Review note',
            nodeId: 'review-note',
            revertDeltas: [
              {
                type: 'DELETE_NODE',
                node: {
                  id: 'review-note',
                  type: 'note',
                  position: { x: 0, y: 0 },
                  data: { label: 'Review note', content: 'Review changes' },
                },
              },
            ],
          },
        ],
      },
    });
    const harness: QueueHarness = { sent: [], finish: () => undefined };
    (window as Window & { queueHarness?: QueueHarness }).queueHarness = harness;
    agentApi.streamMessage = async (content, threadId, _mode, callbacks) => {
      harness.sent.push(content);
      callbacks.onAccepted?.({
        threadId,
        turnStartSeq: harness.sent.length * 10,
      });
      if (harness.sent.length === 1)
        await new Promise<void>((resolve) => {
          harness.finish = resolve;
        });
      callbacks.onEvent({ type: 'done', data: { message: 'Done' } });
      callbacks.onComplete();
    };
    agentApi.stopThread = async () => ({ stopped: false, acceptance: null });
    function Composer() {
      const stream = useAgentStream(session);
      return React.createElement(
        ChatSessionProvider,
        { value: session },
        React.createElement(
          ThreadChatInput,
          {
            mode: 'operate',
            connectedTop: true,
            isStreaming: stream.isLoading,
            onStop: stream.stopStream,
            onSubmit: (event, mode, draft) => {
              event.preventDefault();
              void stream.startStream(draft, mode);
            },
          },
          React.createElement(ChangeReviewCard, {
            canvasId: session.canvasId,
            threadId: session.threadId,
          }),
        ),
      );
    }
    const fixture = document.querySelector('[data-chat-performance-fixture]');
    if (!(fixture instanceof HTMLElement)) throw new Error('Missing fixture');
    fixture.style.display = 'none';
    const host = document.createElement('div');
    host.className =
      'bg-bg-default fixed inset-0 mx-auto flex h-full w-full max-w-xl flex-col justify-end p-4';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(Composer));
  });
  const input = page.locator('textarea[name="agent-message"]:visible');
  await input.fill('First task');
  await input.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
  await input.fill(
    'Review the implementation and its failure paths before making further changes.',
  );
  await input.press('Enter');
  await expect(input).toHaveValue('');
  const queue = page.getByRole('region', { name: 'Queued messages' });
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await input.fill('A second queued task');
  await page.getByRole('button', { name: 'Add to queue', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Add to queue (Enter)');
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  await expect(queue.locator('[data-chat-user-message]')).toHaveCount(2);
  await expect(queue.locator('[data-chat-prompt-content]').first()).toHaveText(
    'Review the implementation and its failure paths before making further changes.',
  );
  await expect(queue).not.toContainText('Queued messages are lost on reload.');
  const firstRow = queue.getByRole('listitem').first();
  const removeOverlay = firstRow.locator('.absolute');
  const firstRemove = firstRow.getByRole('button', {
    name: 'Remove from queue',
  });
  await input.focus();
  await page.mouse.move(1, 1);
  await expect(removeOverlay).toHaveCSS('position', 'absolute');
  await expect(removeOverlay).toHaveCSS('opacity', '0');
  const messageBounds = await firstRow
    .locator('[data-chat-user-message]')
    .boundingBox();
  await firstRow.hover();
  await expect(removeOverlay).toHaveCSS('opacity', '1');
  expect(
    await firstRow.locator('[data-chat-user-message]').boundingBox(),
  ).toEqual(messageBounds);
  await page.mouse.move(1, 1);
  await expect(removeOverlay).toHaveCSS('opacity', '0');
  await firstRemove.focus();
  await expect(removeOverlay).toHaveCSS('opacity', '1');
  await input.focus();
  for (const width of [380, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(input).toBeInViewport();
    await expect(queue).toBeInViewport();
    const layout = await queue.evaluate((element) => {
      const review = element.nextElementSibling;
      const composer =
        review?.nextElementSibling?.querySelector('.group\\/composer');
      if (!review || !composer) throw new Error('Missing connected composer');
      return {
        queueBottom: element.getBoundingClientRect().bottom,
        reviewTop: review.getBoundingClientRect().top,
        reviewBottom: review.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      };
    });
    expect(layout.queueBottom).toBeLessThanOrEqual(layout.reviewTop);
    expect(
      Math.abs(layout.reviewBottom - layout.composerTop),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await firstRow.hover();
    await expect(removeOverlay).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath(`queue-${width}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: testInfo.outputPath('queue-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await queue.getByRole('listitem').last().hover();
  await queue.getByRole('button', { name: 'Remove from queue' }).last().click();
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.evaluate(() =>
    (window as Window & { queueHarness?: QueueHarness }).queueHarness?.finish(),
  );
  await expect(queue).toContainText('Queue paused (1)');
  const resume = queue.getByRole('button', { name: 'Resume queue' });
  await expect(resume).toBeEnabled();
  await resume.focus();
  await page.screenshot({ path: testInfo.outputPath('queue-paused.png') });
  await resume.press('Enter');
  await expect(queue).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { queueHarness?: QueueHarness }).queueHarness?.sent,
    ),
  ).toEqual([
    'First task',
    'Review the implementation and its failure paths before making further changes.',
  ]);
});
