// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { expectSelectionToolbarOutsideSelection } from './helpers';

import type * as MilkdownCardModule from '../src/components/Messages/AIMessage/MilkdownMessageCard';
import type * as SelectionToolbarModule from '../src/components/Messages/TextSelectionToolbar';
import type * as UserMessageModule from '../src/components/Messages/UserMessage';
import type * as ChatStoreModule from '../src/store/chatStore';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

test.use({ hasTouch: false });

test('can comment on the same Chat message again after confirming with Enter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/playground/chat-performance?messages=2');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const drafts = page.locator(
    '[data-chat-input-surface] [data-quoted-comment]',
  );
  for (const [index, comment] of [
    'First comment',
    'Second comment',
    'Third comment',
  ].entries()) {
    const passage = page
      .locator(index === 1 ? '.ProseMirror h2' : '.ProseMirror p')
      .first();
    await passage.scrollIntoViewIfNeeded();
    await passage.click({ clickCount: 3 });
    await expect(
      page.getByRole('button', { name: 'Comment on selection', exact: true }),
    ).toBeVisible();
    if (index > 0) await expect(send).toBeEnabled();
    await page
      .getByRole('button', { name: 'Comment on selection', exact: true })
      .click();
    const input = page.getByRole('textbox', { name: 'Comment', exact: true });
    await input.fill(comment);
    await input.press('Enter');
    await expect(drafts).toHaveCount(index + 1);
    await expect(send).toBeEnabled();
  }
});

test('can comment on a CodeMirror passage and then select code again', async ({
  page,
}) => {
  await page.goto('/playground/chat-performance?messages=0');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const cardPath =
      '/src/components/Messages/AIMessage/MilkdownMessageCard.tsx';
    const { createElement } = (await import(reactPath))
      .default as typeof ReactModule;
    const { createRoot } = (await import(domPath)).default as typeof DomModule;
    const { MilkdownMessageCard } = (await import(
      cardPath
    )) as typeof MilkdownCardModule;
    const host = document.createElement('div');
    host.id = 'code-comment-fixture';
    host.style.cssText =
      'position:fixed;left:40px;top:40px;width:600px;z-index:100';
    document.body.append(host);
    createRoot(host).render(
      createElement(MilkdownMessageCard, {
        content: '```ts\nconst selected = 1;\nconst other = 2;\n```',
        threadId: 'chat-performance-thread',
        messageId: 'code-message',
        enableComments: true,
      }),
    );
  });
  for (const index of [0, 1]) {
    const line = page.locator('#code-comment-fixture .cm-line').nth(index);
    await line.click({ clickCount: 3 });
    await page
      .getByRole('button', { name: 'Comment on selection', exact: true })
      .click();
    const input = page.getByRole('textbox', { name: 'Comment', exact: true });
    await input.fill(`Code comment ${index + 1}`);
    await input.press('Enter');
    const drafts = page.locator(
      '[data-chat-input-surface] [data-quoted-comment]',
    );
    await expect(drafts).toHaveCount(index + 1);
    await expect(drafts.nth(index).locator('blockquote')).toHaveText(
      index === 0 ? 'const selected = 1;' : 'const other = 2;',
    );
    await expect(
      page.getByRole('button', { name: 'Send', exact: true }),
    ).toBeEnabled();
  }
});

test('keeps Comment reachable for a native Chat selection spanning the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/playground/chat-performance?messages=0');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const cardPath =
      '/src/components/Messages/AIMessage/MilkdownMessageCard.tsx';
    const { createElement } = (await import(reactPath))
      .default as typeof ReactModule;
    const { createRoot } = (await import(domPath)).default as typeof DomModule;
    const { MilkdownMessageCard } = (await import(
      cardPath
    )) as typeof MilkdownCardModule;
    const host = document.createElement('div');
    host.id = 'long-chat-selection';
    host.style.cssText =
      'position:fixed;left:40px;top:80px;width:360px;height:400px;overflow:auto;z-index:100';
    document.body.append(host);
    createRoot(host).render(
      createElement(MilkdownMessageCard, {
        content: Array.from(
          { length: 60 },
          (_, index) => `Paragraph ${index + 1}: a passage to discuss.`,
        ).join('\n\n'),
        threadId: 'chat-performance-thread',
        messageId: 'long-message',
        enableComments: true,
      }),
    );
  });
  const editor = page.locator('#long-chat-selection .ProseMirror');
  await expect(editor.locator('p')).toHaveCount(60);
  const selected = await editor.evaluate((element) => {
    const host = document.getElementById('long-chat-selection');
    if (!host) throw new Error('Missing scroll container');
    host.scrollTop = host.scrollHeight / 2;
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    if (!selection) throw new Error('Missing native selection');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const bounds = range.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom };
  });
  expect(selected.top).toBeLessThan(0);
  expect(selected.bottom).toBeGreaterThan(800);
  const toolbar = page.locator('.selection-context-toolbar');
  await expect(toolbar).toBeVisible();
  const bounds = await toolbar.boundingBox();
  if (!bounds) throw new Error('Missing toolbar');
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(788);
  await toolbar
    .getByRole('button', { name: 'Comment on selection', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Comment', exact: true }),
  ).toBeVisible();
});

for (const placement of [
  'below',
  'above',
  'right-edge',
  'panel-edge',
  'viewport-spanning',
  'panel-spanning',
] as const) {
  test(`selection toolbar avoids multiline text at ${placement}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/playground/chat-performance?messages=0');
    const selected = await page.evaluate(async (placement) => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const toolbarPath = '/src/components/Messages/TextSelectionToolbar.tsx';
      const { createElement } = (await import(reactPath))
        .default as typeof ReactModule;
      const { createRoot } = (await import(domPath))
        .default as typeof DomModule;
      const { TextSelectionToolbar } = (await import(
        toolbarPath
      )) as typeof SelectionToolbarModule;
      const boundary = document.createElement('div');
      boundary.style.cssText =
        'position:fixed;left:20px;top:20px;width:440px;height:400px';
      document.body.append(boundary);
      const top = placement.endsWith('spanning')
        ? -200
        : placement === 'above'
          ? 690
          : placement === 'panel-edge'
            ? 330
            : 100;
      const left = placement === 'right-edge' ? 300 : 40;
      const rect = new DOMRect(
        left,
        top,
        120,
        placement.endsWith('spanning') ? 1400 : 60,
      );
      const host = document.createElement('div');
      document.body.append(host);
      createRoot(host).render(
        createElement(TextSelectionToolbar, {
          canvasId: 'space',
          threadId: 'thread',
          quote: {
            quote: 'First line\nSecond line\nThird line',
            contextBefore: '',
            contextAfter: '',
          },
          position: { x: left + 10, y: top + 10 },
          selectionRect: rect,
          boundary: placement.startsWith('panel-') ? boundary : undefined,
          onDismiss: () => {},
          onSaveAsNote: () => {},
        }),
      );
      return { top: rect.top, bottom: rect.bottom };
    }, placement);
    const toolbar = page.locator('.selection-context-toolbar');
    await expect(toolbar).toBeVisible();
    const bounds = await toolbar.boundingBox();
    if (!bounds) throw new Error('Missing selection toolbar bounds');
    if (placement.endsWith('spanning')) {
      expect(bounds.y).toBeGreaterThanOrEqual(
        placement === 'panel-spanning' ? 32 : 12,
      );
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        placement === 'panel-spanning' ? 408 : 788,
      );
    } else if (placement === 'above' || placement === 'panel-edge') {
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(selected.top - 7);
    } else {
      expect(bounds.y).toBeGreaterThanOrEqual(selected.bottom + 7);
    }
    expect(bounds.x).toBeGreaterThanOrEqual(12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(468);
    await page.screenshot({
      path: testInfo.outputPath(`selection-${placement}.png`),
    });
    if (placement.endsWith('spanning')) {
      await toolbar
        .getByRole('button', { name: 'Comment on selection', exact: true })
        .click();
      await expect(
        page.getByRole('textbox', { name: 'Comment', exact: true }),
      ).toBeVisible();
    }
  });
}

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
  const passageBox = await passage.boundingBox();
  if (!passageBox) throw new Error('Missing passage bounds');
  await page.mouse.move(passageBox.x + 10, passageBox.y + 10);
  await page.mouse.down({ clickCount: 3 });
  await expect(page.locator('.selection-context-toolbar')).toHaveCount(0);
  await page.mouse.up({ clickCount: 3 });
  await expect(
    page.getByRole('button', { name: 'Comment on selection', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.canvas-context-toolbar')).toHaveCount(2);
  await expectSelectionToolbarOutsideSelection(page);
  for (const capsule of await page.locator('.canvas-context-toolbar').all()) {
    await expect(capsule).toHaveCSS('height', '36px');
    await expect(capsule).toHaveCSS('border-radius', '8px');
  }
  await expect(page.locator('.ink-agent-destination-trigger')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('chat-selection-toolbar.png'),
  });
  await page
    .getByRole('button', { name: 'Comment on selection', exact: true })
    .click();
  const fullComment = 'Please explain this in detail. '.repeat(12).trim();
  await expect(
    page.getByRole('button', { name: 'Add to input', exact: true }),
  ).toBeDisabled();
  for (const capsule of await page.locator('.canvas-context-toolbar').all()) {
    await expect(capsule).toBeHidden();
  }
  await expect(
    page.locator('[data-chat-input-surface] [data-quoted-comment]'),
  ).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('  \n ');
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('button', { name: 'Add to input', exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator('[data-chat-input-surface] [data-quoted-comment]'),
  ).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill(fullComment);
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .press('Enter');

  const card = page.locator('[data-chat-input-surface] [data-quoted-comment]');
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole('button', { name: 'Open source', exact: true }),
  ).toHaveCount(0);
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
  await textarea.fill('Main instructions do not replace a required comment');
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeDisabled();
  await textarea.fill('');
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
