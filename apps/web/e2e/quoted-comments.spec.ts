// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as UserMessageModule from '../src/components/Messages/UserMessage';
import type * as ChatStoreModule from '../src/store/chatStore';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

test.use({ hasTouch: false });

async function stageDraft(page: Page, quote: string, comment: string) {
  await page.goto('/playground/chat-performance?messages=0');
  await page.evaluate(
    async ({ quote, comment }) => {
      const storePath = '/src/store/chatStore.ts';
      const { useChatStore } = (await import(
        storePath
      )) as typeof ChatStoreModule;
      useChatStore.getState().addQuotedComment('chat-performance-thread', {
        quote,
        comment,
        contextBefore: '',
        contextAfter: '',
      });
    },
    { quote, comment },
  );
}

test('stages, edits and removes a quoted comment without exposing a prompt template', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/playground/chat-performance?messages=2');
  const textarea = page.locator('textarea[name="agent-message"]');
  await expect(textarea).toBeVisible();
  await textarea.fill('General instructions');
  const passage = page.locator('.ProseMirror p').first();
  await expect(passage).toBeVisible();
  const original = (await passage.textContent())?.trim();
  if (!original) throw new Error('Missing assistant passage');
  await passage.click({ clickCount: 3 });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const fullComment = 'Please explain this in detail. '.repeat(12).trim();
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill(fullComment);
  await page.getByRole('button', { name: 'Add to input', exact: true }).click();

  const card = page.locator('[data-chat-input-surface] [data-quoted-comment]');
  await expect(card).toHaveCount(1);
  await expect(card.locator('blockquote')).toHaveText(original);
  await expect(textarea).toHaveValue('General instructions');
  const comment = card.getByRole('textbox', { name: 'Comment', exact: true });
  const editComment = card.getByRole('button', {
    name: 'Edit comment',
    exact: true,
  });
  await expect(comment).toHaveCount(0);
  await expect(editComment).toHaveText(fullComment);
  const quote = card.locator('blockquote button');
  await expect(quote).toHaveCSS('white-space', 'nowrap');
  await expect(quote).toHaveCSS('text-overflow', 'ellipsis');
  await expect(quote).toHaveCSS('overflow', 'hidden');
  expect(
    await quote.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await expect(quote).not.toHaveAttribute('title');
  await quote.hover();
  await expect(page.getByRole('tooltip')).toHaveText(original);
  await page.mouse.move(1, 1);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  expect(
    await quote.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        parseFloat(getComputedStyle(element).lineHeight) + 1,
    ),
  ).toBe(true);
  const commentText = editComment.locator('span');
  expect(
    await commentText.evaluate(
      (element) =>
        element.getBoundingClientRect().height >
          parseFloat(getComputedStyle(element).lineHeight) &&
        element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  const remove = card.getByRole('button', {
    name: 'Remove quoted comment',
    exact: true,
  });
  const overlay = card.locator('.absolute');
  await expect(overlay).toHaveCSS('position', 'absolute');
  expect(
    await remove.evaluate(
      (element) =>
        parseFloat(getComputedStyle(element).borderTopLeftRadius) >=
        element.getBoundingClientRect().width / 2,
    ),
  ).toBe(true);
  await page.mouse.move(1, 1);
  await textarea.focus();
  await expect(overlay).toHaveCSS('opacity', '0');
  await card.hover();
  await expect(overlay).toHaveCSS('opacity', '1');
  await page.mouse.move(1, 1);
  await textarea.focus();
  await expect(overlay).toHaveCSS('opacity', '0');
  await remove.focus();
  await expect(overlay).toHaveCSS('opacity', '1');
  await expect(card.locator('details')).toHaveCount(0);
  await expect(card).not.toContainText('Nearby context');
  await editComment.click();
  await expect(comment).toHaveValue(fullComment);
  await comment.fill('Updated comment');
  await comment.press('Enter');
  await expect(comment).toHaveCount(0);
  await expect(editComment).toHaveText('Updated comment');
  await page.mouse.move(1, 1);
  await textarea.focus();
  await expect(overlay).toHaveCSS('opacity', '0');
  await page.screenshot({
    path: testInfo.outputPath('quoted-comment-composer.png'),
  });
  await textarea.fill('');
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeEnabled();
  await editComment.click();
  await comment.fill(' ');
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeDisabled();
  await expect(card.getByRole('alert')).toBeVisible();
  await comment.press('Escape');
  await expect(comment).toHaveCount(0);
  await expect(editComment).toHaveText('Updated comment');
  await editComment.click();
  await comment.fill('Saved on blur');
  await textarea.click();
  await expect(comment).toHaveCount(0);
  await expect(editComment).toHaveText('Saved on blur');
  await card.hover();
  await remove.click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeDisabled();
});

test('truncates long sent quotations within the message and uses Common Tooltip on hover and focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/playground/chat-performance?messages=0');
  const quote = `First line\n${'unbroken-passage'.repeat(40)}\nLast line`;
  const comment = 'Keep the complete comment visible. '.repeat(10).trim();
  await page.evaluate(
    async ({ quote, comment }) => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const messagePath = '/src/components/Messages/UserMessage.tsx';
      const { createElement } = (await import(reactPath))
        .default as typeof ReactModule;
      const { createRoot } = (await import(domPath))
        .default as typeof DomModule;
      const { UserMessage } = (await import(
        messagePath
      )) as typeof UserMessageModule;
      const host = document.createElement('div');
      host.setAttribute('data-quoted-message-test', '');
      host.style.cssText =
        'position:fixed;top:20px;left:20px;width:320px;z-index:1000';
      document.body.append(host);
      createRoot(host).render(
        createElement(UserMessage, {
          content: '',
          quotedComments: [
            {
              quote,
              comment,
              contextBefore: 'Hidden before',
              contextAfter: 'Hidden after',
            },
          ],
        }),
      );
    },
    { quote, comment },
  );
  const message = page.locator('[data-quoted-message-test]');
  const preview = message.locator('blockquote button');
  await expect(preview).toHaveText(quote);
  await expect(preview).toHaveCSS('text-overflow', 'ellipsis');
  await expect(preview).toHaveCSS('white-space', 'nowrap');
  await expect(preview).not.toHaveAttribute('title');
  expect(
    await preview.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const host = element.closest('[data-quoted-message-test]');
      if (!host) throw new Error('Missing sent message fixture');
      return (
        element.scrollWidth > element.clientWidth &&
        bounds.right <= host.getBoundingClientRect().right &&
        bounds.height <= parseFloat(getComputedStyle(element).lineHeight) + 1
      );
    }),
  ).toBe(true);
  const fullComment = message.locator('[data-quoted-comment] p');
  await expect(fullComment).toHaveText(comment);
  expect(
    await fullComment.evaluate(
      (element) => element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await preview.hover();
  await expect(page.getByRole('tooltip')).toHaveText(quote);
  await page.mouse.move(1, 1);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await preview.focus();
  await expect(page.getByRole('tooltip')).toHaveText(quote);
  await preview.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('keeps multiline comments intact when editing and adding a line', async ({
  page,
}) => {
  await stageDraft(page, 'Passage', 'First line\nSecond line');
  const edit = page.getByRole('button', { name: 'Edit comment', exact: true });
  await edit.click();
  const editor = page.getByRole('textbox', { name: 'Comment', exact: true });
  await expect(editor).toHaveValue('First line\nSecond line');
  await editor.press('ArrowRight');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('Third line');
  await expect(editor).toHaveValue('First line\nSecond line\nThird line');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(edit).toHaveText('First line\nSecond line\nThird line');
  await edit.click();
  await expect(editor).toHaveValue('First line\nSecond line\nThird line');
  await editor.press('Escape');
});

test('consumes an unchanged submitted draft after history navigation restores it', async ({
  page,
}) => {
  await stageDraft(page, 'Passage', 'Explain.');
  await page.evaluate(async () => {
    const storePath = '/src/store/chatStore.ts';
    const { useChatStore, selectThreadQuotedComments } = (await import(
      storePath
    )) as typeof ChatStoreModule;
    const threadId = 'chat-performance-thread';
    const store = useChatStore.getState();
    const submitted = selectThreadQuotedComments(store, threadId);
    store.setMessages(threadId, [
      {
        id: 'submitted-message',
        role: 'user',
        content: '',
        quotedComments: submitted.map(
          ({ quote, contextBefore, contextAfter, comment }) => ({
            quote,
            contextBefore,
            contextAfter,
            comment,
          }),
        ),
      },
    ]);
    document.addEventListener(
      'accept-submitted-comment',
      () => useChatStore.getState().consumeDraft(threadId, '', submitted),
      { once: true },
    );
  });
  const textarea = page.locator('textarea[name="agent-message"]');
  await textarea.focus();
  await textarea.press('ArrowUp');
  await textarea.press('ArrowDown');
  await expect(page.locator('[data-quoted-comment]')).toHaveCount(1);
  await page.evaluate(() =>
    document.dispatchEvent(new Event('accept-submitted-comment')),
  );
  await expect(page.locator('[data-quoted-comment]')).toHaveCount(0);
});

test('bounds long quote tooltips and supports pointer and keyboard scrolling', async ({
  page,
}) => {
  const quote = Array.from(
    { length: 150 },
    (_, index) => `Quoted source line ${index}`,
  ).join('\n');
  await stageDraft(page, quote, 'Explain.');
  const trigger = page.locator('[data-quoted-comment] blockquote button');
  await trigger.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText(quote);
  expect(
    await tooltip.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.height <= window.innerHeight * 0.6 &&
        bounds.top >= 0 &&
        bounds.bottom <= window.innerHeight &&
        element.scrollHeight > element.clientHeight
      );
    }),
  ).toBe(true);
  await expect(tooltip).toHaveCSS('pointer-events', 'auto');
  const bounds = await tooltip.boundingBox();
  if (!bounds) throw new Error('Missing quote tooltip bounds');
  const triggerBounds = await trigger.boundingBox();
  if (!triggerBounds) throw new Error('Missing quote trigger bounds');
  await page.mouse.move(
    triggerBounds.x + triggerBounds.width / 2,
    bounds.y + bounds.height / 2,
    { steps: 10 },
  );
  await page.mouse.wheel(0, 300);
  await expect(tooltip).toBeVisible();
  await expect
    .poll(() => tooltip.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  await trigger.press('End');
  const bottom = await tooltip.evaluate(
    (element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  );
  expect(bottom).toBe(true);
  await trigger.press('Home');
  await expect
    .poll(() => tooltip.evaluate((element) => element.scrollTop))
    .toBe(0);
  await trigger.press('Escape');
  await expect(tooltip).toHaveCount(0);
});
