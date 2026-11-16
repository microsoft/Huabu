// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

function panel(page: Page, tab = 'a') {
  return page.locator(`[data-activation-panel="${tab}"]`);
}

async function selectText(surface: Locator, from: string, to = from) {
  await surface.scrollIntoViewIfNeeded();
  await surface.evaluate(
    (element, endpoints) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Node[] = [];
      let text = '';
      let node: Node | null;
      while ((node = walker.nextNode())) {
        nodes.push(node);
        text += node.textContent ?? '';
      }
      const from = text.indexOf(endpoints.from);
      const to = text.indexOf(endpoints.to, from);
      if (from < 0 || to < 0) throw new Error('Selection endpoints not found');
      const range = document.createRange();
      let offset = 0;
      const end = to + endpoints.to.length;
      for (const node of nodes) {
        const length = node.textContent?.length ?? 0;
        if (from >= offset && from < offset + length) {
          range.setStart(node, from - offset);
        }
        if (end > offset && end <= offset + length) {
          range.setEnd(node, end - offset);
          break;
        }
        offset += length;
      }
      element.focus();
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { from, to },
  );
}

async function comment(page: Page, text: string) {
  await page
    .getByRole('button', { name: 'Comment on selection', exact: true })
    .click();
  const editor = page.getByRole('textbox', { name: 'Comment', exact: true });
  await expect(editor).toBeFocused();
  await editor.fill(text);
  await page.getByRole('button', { name: 'Add to input', exact: true }).click();
}

test.beforeEach(async ({ page }, info) => {
  test.skip(
    info.config.metadata.chatActivationProduction !== true,
    'Uses the isolated production chat fixture',
  );
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Fixture has no backend' }),
    }),
  );
  // The sign-in gate mounts nothing until the Server says who is calling, so
  // the backend-less fixture answers that one request as a local deployment.
  await page.route('**/api/identity', (route) =>
    route.fulfill({
      json: {
        provider: 'local',
        principal: {
          principalId: 'local-owner',
          kind: 'user',
          displayName: 'Local owner',
        },
        member: true,
        owner: true,
      },
    }),
  );
  await page.goto('/playground/chat-performance?mode=activation&turns=3');
  await expect(panel(page).locator('.ProseMirror').first()).toBeVisible();
});

// How a comment reaches the input is covered by quoted-comments.spec.ts.
// Since #374 a comment is staged as a quoted-comment chip and the prompt
// template is no longer written into the textarea, which is what the cases
// that used to live here ("collects inline and cross-paragraph comments…",
// "supports code and keyboard selection…") asserted.
test('offers three selection icons and copies only the selected text while retaining whole-response actions', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const composer = panel(page).locator('textarea[name="agent-message"]');
  await composer.fill('Unchanged draft');
  const wholeNoteActions = panel(page).getByRole('button', {
    name: 'Add as note',
    exact: true,
  });
  const originalCount = await wholeNoteActions.count();
  const answer = panel(page)
    .locator('[data-chat-message-id="a-turn-3-tool"] .ProseMirror')
    .last();
  await answer.locator('strong').dblclick();
  const commentButton = page.getByRole('button', {
    name: 'Comment on selection',
    exact: true,
  });
  await expect(commentButton).toBeVisible();
  await commentButton.hover();
  await expect(page.getByRole('tooltip')).toContainText('Comment');
  await expect(
    page.getByRole('button', { name: 'Add as note', exact: true }),
  ).toHaveCount(originalCount + 1);
  const selectionCopy = page.getByLabel('Copy', { exact: true });
  await selectionCopy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('cached');
  await expect(commentButton).toHaveCount(0);
  await expect(wholeNoteActions).toHaveCount(originalCount);
  await expect(composer).toHaveValue('Unchanged draft');
  await expect(answer.locator('strong')).toHaveText('cached');
});

test('rejects selections spanning messages and excludes streaming output', async ({
  page,
}) => {
  const answers = panel(page).locator('.ProseMirror');
  await answers.last().scrollIntoViewIfNeeded();
  await answers.last().evaluate((last) => {
    const first = document.querySelector(
      '[data-activation-panel="a"] .ProseMirror',
    );
    if (!first) throw new Error('Missing first answer');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(
    page.getByRole('button', { name: 'Comment on selection', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  const streaming = panel(page).locator(
    '[data-chat-message-id="a-turn-4-answer"] .ProseMirror',
  );
  await selectText(streaming, 'const cachedTurn = 4;');
  await expect(
    page.getByRole('button', { name: 'Comment on selection', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Complete turn', exact: true })
    .click();
  await selectText(streaming, 'const cachedTurn = 4;');
  await comment(page, 'Explain.');
});

test('keeps comments thread-local through tab switching and drops unsent drafts on reload', async ({
  page,
}) => {
  // A comment is staged as a quoted-comment card above the input, not as
  // text in the textarea, so the cards are what must stay with their thread.
  const staged = (tab: 'a' | 'b' = 'a') =>
    panel(page, tab).locator('[data-chat-input-surface] [data-quoted-comment]');
  await selectText(
    panel(page).locator(
      '[data-chat-message-id="a-turn-3-answer"] .ProseMirror',
    ),
    'const cachedTurn = 3;',
  );
  await comment(page, 'Keep in A.');
  await expect(staged()).toHaveCount(1);
  await expect(staged()).toContainText('Keep in A.');
  await expect(staged()).toContainText('const cachedTurn = 3;');

  await page.getByRole('button', { name: 'Tab B', exact: true }).click();
  await expect(staged('b')).toHaveCount(0);
  await selectText(
    panel(page, 'b').locator(
      '[data-chat-message-id="b-turn-3-answer"] .ProseMirror',
    ),
    'const cachedTurn = 3;',
  );
  await page
    .getByRole('button', { name: 'Comment on selection', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Not appended.');
  await page.getByRole('button', { name: 'Tab A', exact: true }).click();
  // The comment left open in B is dropped, not staged anywhere.
  await expect(
    page.getByRole('textbox', { name: 'Comment', exact: true }),
  ).toHaveCount(0);
  await expect(staged()).toHaveCount(1);
  await expect(staged()).toContainText('Keep in A.');
  await expect(staged()).not.toContainText('Not appended.');
  await page.getByRole('button', { name: 'Tab B', exact: true }).click();
  await expect(staged('b')).toHaveCount(0);

  await page.reload();
  await expect(panel(page).locator('.ProseMirror').first()).toBeVisible();
  await expect(staged()).toHaveCount(0);
});
