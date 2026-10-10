// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type * as InputModule from '../src/components/Panels/ChatPanel/ThreadChatInput';
import type * as SessionModule from '../src/hooks/useChatSession';
import type CanvasStore from '../src/store/canvasStore';
import type * as ChatStore from '../src/store/chatStore';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

test.use({ hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  await page.goto('/playground/chat-performance?messages=0');
  await expect(page.getByRole('textbox')).toBeVisible();
  await page.evaluate(async () => {
    const loaded = (suffix: string) => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname.endsWith(suffix));
      if (!resource) throw new Error(`Missing module: ${suffix}`);
      return resource.name;
    };
    const [
      { default: React },
      { default: ReactDOM },
      { ThreadChatInput },
      { ChatSessionProvider },
      { default: canvas },
      { useChatStore: chat, selectThreadPendingAttachments },
    ] = await Promise.all([
      import(loaded('/deps/react.js')) as Promise<{
        default: typeof ReactModule;
      }>,
      import(loaded('/deps/react-dom_client.js')) as Promise<{
        default: typeof ReactDOMModule;
      }>,
      import(loaded('/ThreadChatInput.tsx')) as Promise<typeof InputModule>,
      import(loaded('/useChatSession.ts')) as Promise<typeof SessionModule>,
      import(loaded('/src/store/canvasStore.ts')) as Promise<{
        default: typeof CanvasStore;
      }>,
      import(loaded('/src/store/chatStore.ts')) as Promise<typeof ChatStore>,
    ]);
    canvas.getState()._setStateNoAutosave({
      canvasId: 'mentions-canvas',
      nodes: [
        { id: 'frame', type: 'frame', data: { label: 'Herdr' } },
        {
          id: 'note',
          type: 'note',
          data: { label: 'Herdr research' },
          parentId: 'frame',
        },
        { id: 'chinese', type: 'note', data: { label: '研究笔记' } },
        {
          id: 'selected',
          type: 'note',
          data: { label: 'Selected note' },
          selected: true,
        },
      ].map((node) => ({ ...node, position: { x: 0, y: 0 } })),
      edges: [],
    });
    const original = document.querySelector<HTMLElement>(
      '[data-chat-performance-fixture]',
    );
    if (!original) throw new Error('Missing original fixture');
    original.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'mentions-fixture';
    Object.assign(host.style, {
      position: 'fixed',
      top: '280px',
      left: '24px',
      width: '320px',
    });
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        ChatSessionProvider,
        {
          value: {
            canvasId: 'mentions-canvas',
            ownerCanvasId: 'mentions-canvas',
            threadId: 'mentions-thread',
            conversationView: null,
          },
        },
        React.createElement(ThreadChatInput, {
          mode: 'ask',
          onStop: () => undefined,
          onSubmit: (_event, _mode, draft) => {
            host.dataset.submitted = JSON.stringify({
              draft,
              attachments: selectThreadPendingAttachments(
                chat.getState(),
                'mentions-thread',
              ),
            });
          },
        }),
      ),
    );
  });
});

test('keyboard and mouse mentions preserve text and attach exact nodes to the submitted draft', async ({
  page,
}) => {
  const host = page.locator('#mentions-fixture');
  const textbox = host.getByRole('textbox');
  await textbox.fill('Compare @Her');
  const listbox = host.getByRole('listbox', { name: 'Nodes in this Space' });
  await expect(listbox.getByRole('option')).toHaveCount(2);
  const activeId = await textbox.getAttribute('aria-activedescendant');
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const menuBounds = await host
    .locator('[data-node-mention-menu]')
    .boundingBox();
  const surfaceBounds = await host
    .locator('[data-chat-input-surface]')
    .boundingBox();
  expect((menuBounds?.y ?? 0) + (menuBounds?.height ?? 0)).toBeLessThan(
    surfaceBounds?.y ?? 0,
  );
  expect(menuBounds?.width).toBeLessThanOrEqual(320);
  await textbox.press('ArrowDown');
  await textbox.press('Enter');
  await expect(textbox).toHaveValue('Compare @Herdr research ');
  await expect(listbox).toHaveCount(0);
  await expect(host).not.toHaveAttribute('data-submitted');
  const sources = host.locator('[data-chat-context-sources]');
  await expect(sources).toHaveText('Herdr research1 selected node');
  await expect(textbox).toBeFocused();

  await textbox.press('End');
  await textbox.pressSequentially('and @Her');
  await host.getByRole('option', { name: 'Herdr Frame', exact: true }).click();
  await expect(textbox).toHaveValue('Compare @Herdr research and @Herdr ');
  await expect(sources).toHaveText('Herdr researchHerdr1 selected node');
  await expect(textbox).toBeFocused();
  await textbox.press('Enter');
  await expect(host).toHaveAttribute(
    'data-submitted',
    JSON.stringify({
      draft: 'Compare @Herdr research and @Herdr ',
      attachments: [
        {
          type: 'text',
          source: 'selection',
          originNodeId: 'note',
          label: 'Herdr research',
        },
        {
          type: 'text',
          source: 'selection',
          originNodeId: 'frame',
          label: 'Herdr',
        },
      ],
    }),
  );
});

test('dismissal, no matches, IME and chip removal do not corrupt the draft', async ({
  page,
}) => {
  const host = page.locator('#mentions-fixture');
  const textbox = host.getByRole('textbox');
  await textbox.fill('email@example.com');
  await expect(host.getByRole('listbox')).toHaveCount(0);
  await textbox.fill('@missing');
  await expect(host.getByRole('status')).toHaveText('No matching nodes');
  await textbox.press('Enter');
  await expect(host).not.toHaveAttribute('data-submitted');
  await textbox.press('Escape');
  await expect(host.getByRole('listbox')).toHaveCount(0);
  await textbox.fill('@研');
  await textbox.dispatchEvent('compositionstart');
  await expect(host.getByRole('listbox')).toHaveCount(0);
  await textbox.dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    keyCode: 229,
  });
  await expect(host).not.toHaveAttribute('data-submitted');
  await textbox.dispatchEvent('compositionend', { data: '研' });
  await expect(host.getByRole('option')).toHaveCount(1);
  await textbox.press('Tab');
  await expect(textbox).toHaveValue('@研究笔记 ');
  await host.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(textbox).toHaveValue('@研究笔记 ');
  await expect(host.locator('[data-context-attachment]')).toHaveCount(0);
});

test('large mention lists keep DOM bounded and preserve scrolling, wrapping and search', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: canvas } = (await import(path)) as {
      default: typeof CanvasStore;
    };
    canvas.getState()._setStateNoAutosave({
      nodes: Array.from({ length: 2000 }, (_, index) => ({
        id: `large-${index}`,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: `Entry ${index}` },
      })),
    });
  });
  const host = page.locator('#mentions-fixture');
  const textbox = host.getByRole('textbox');
  const listbox = host.getByRole('listbox');
  const options = listbox.getByRole('option');
  await textbox.fill('@');
  await expect(listbox).toBeVisible();
  expect(await options.count()).toBeLessThanOrEqual(16);
  await expect(options.first()).toHaveAttribute('aria-setsize', '2000');
  expect((await options.first().boundingBox())?.height).toBe(28);
  await textbox.press('ArrowUp');
  await expect(listbox.locator('[aria-selected="true"]')).toHaveText(
    'Entry 1999Note',
  );
  await expect(listbox.locator('[aria-selected="true"]')).toBeInViewport();
  expect(await options.count()).toBeLessThanOrEqual(16);
  await textbox.press('ArrowDown');
  await expect(listbox.locator('[aria-selected="true"]')).toHaveText(
    'Entry 0Note',
  );
  await listbox.evaluate((element) => {
    element.scrollTop = 1000 * 28;
  });
  await expect(
    listbox.getByRole('option', { name: 'Entry 1000 Note', exact: true }),
  ).toBeInViewport();
  expect(await options.count()).toBeLessThanOrEqual(16);
  const activeId = await textbox.getAttribute('aria-activedescendant');
  expect(await page.locator(`[id="${activeId}"]`).count()).toBe(1);
  await listbox
    .getByRole('option', { name: 'Entry 1000 Note', exact: true })
    .click();
  await expect(textbox).toHaveValue('@Entry 1000 ');
  await textbox.fill('@1999');
  await expect(options).toHaveCount(1);
  await textbox.press('Enter');
  await expect(textbox).toHaveValue('@Entry 1999 ');
});
