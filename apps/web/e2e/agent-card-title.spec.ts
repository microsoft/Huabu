// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

for (const nodeType of ['question', 'spacePreview'] as const) {
  for (const gesture of [
    'unselected title',
    'selected title whitespace',
    'selected icon',
  ] as const) {
    test(`${nodeType} opens from a double-click on ${gesture}`, async ({
      page,
    }) => {
      const label = 'A long title that wraps to a short last line';
      let target: string | undefined;
      if (nodeType === 'spacePreview') {
        const response = await page.request.post('/api/canvas', {
          data: { title: label },
        });
        expect(response.ok(), await response.text()).toBe(true);
        target = (await response.json()).canvasId;
      }
      await openNewCanvas(page);
      await page.keyboard.press('Escape');
      const source = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
      const response = await page.request.post(
        `/api/canvas/${source}/execute`,
        {
          data: {
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: 'node-title-gesture',
                    nodeType,
                    selectOnCreate: false,
                    data:
                      nodeType === 'question'
                        ? {
                            label,
                            labelSource: 'user',
                            content: 'Keep the prompt.',
                          }
                        : { targetCanvasId: target },
                    position: { x: 150, y: 150 },
                    size: { width: 360 },
                  },
                ],
              },
            ],
            originator: { source: 'ui', tabId: 'title-gesture-test' },
          },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      await page.reload();
      const node = page.locator('[data-id="node-title-gesture"]');
      const title = node.getByRole('button', {
        name: nodeType === 'question' ? 'Rename node' : 'Rename Space',
        exact: true,
      });
      await expect(title).toBeVisible();
      await expect(node).not.toHaveClass(/selected/);
      if (gesture !== 'unselected title') {
        await title.click();
        await expect(node).toHaveClass(/selected/);
      }
      if (gesture === 'selected icon') {
        await node
          .locator(
            nodeType === 'question'
              ? '.question-conversation-agent'
              : '[data-space-type-icon]',
          )
          .dblclick();
      } else {
        const point = await title
          .locator('span[title]')
          .evaluate((element, whitespace) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const bounds = element.getBoundingClientRect();
            const lines = [...range.getClientRects()].filter(
              (rect) => rect.top < bounds.bottom && rect.bottom > bounds.top,
            );
            const line = whitespace ? lines.at(-1) : lines[0];
            if (!line) throw new Error('Title text is not rendered');
            if (whitespace && line.right + 8 >= bounds.right)
              throw new Error('Title needs trailing whitespace for this check');
            return {
              x: whitespace ? line.right + 8 : line.left + 8,
              y: (line.top + line.bottom) / 2,
            };
          }, gesture === 'selected title whitespace');
        await page.mouse.dblclick(point.x, point.y);
      }
      if (nodeType === 'question') {
        await expect(
          page.locator('textarea[name="agent-message"]'),
        ).toBeVisible();
        await expect(node.getByRole('textbox')).toHaveCount(0);
      } else {
        await expect(page).toHaveURL(`/canvas/${target}`);
      }
    });
  }
}

test('Agent cards rename inline without changing the prompt or opening Chat', async ({
  page,
}, testInfo) => {
  const originalTitle =
    'Original title that already wraps onto multiple lines before entering the inline title editor';
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-title-agent',
              nodeType: 'question',
              data: {
                label: originalTitle,
                labelSource: 'user',
                content: 'Keep this first prompt unchanged.',
              },
              position: { x: 150, y: 150 },
              size: { width: 400 },
            },
            {
              id: 'node-title-taken',
              nodeType: 'text',
              data: {
                label: 'Taken title',
                labelSource: 'user',
                content: 'Another node',
              },
              position: { x: 650, y: 150 },
              size: { width: 200 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-card-title' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.reload();
  const node = page.locator('[data-id="node-title-agent"]');
  const title = node.locator('.question-conversation-question');
  const input = title.getByRole('textbox', { name: 'Rename node' });
  await title.click();
  await expect(node).toHaveClass(/selected/);
  await expect(input).toHaveCount(0);
  await title.getByRole('button', { name: 'Rename node' }).click();
  await expect(input).toHaveCount(0);
  const card = node.locator('.question-conversation-card');
  const originalHeight = await card.evaluate((element) => element.clientHeight);
  const originalFooterTop = await node
    .locator('.question-conversation-header')
    .evaluate((element) => (element as HTMLElement).offsetTop);
  const expectStableCard = async () => {
    expect(await card.evaluate((element) => element.clientHeight)).toBe(
      originalHeight,
    );
    expect(
      await node
        .locator('.question-conversation-header')
        .evaluate((element) => (element as HTMLElement).offsetTop),
    ).toBe(originalFooterTop);
  };
  await title.getByRole('button', { name: 'Rename node' }).dblclick({
    position: { x: 8, y: 16 },
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS('border-top-width', '1px');
  await expect(input).toHaveCSS('--tw-ring-shadow', /0 0 0 calc\(0px/);
  await expect(input).toHaveValue(originalTitle);
  await expectStableCard();
  await expect(async () => {
    expect(
      await input.evaluate(
        (element) =>
          element.clientHeight /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    ).toBeGreaterThan(2);
  }).toPass();
  await expect(page.locator('textarea[name="agent-message"]')).toHaveCount(0);
  await input.dblclick();
  await expect(page.locator('textarea[name="agent-message"]')).toHaveCount(0);

  await input.fill(
    'A long Agent title that should wrap across several lines while editing without hiding any of the draft or overlapping the status footer',
  );
  await expect(input).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(async () => {
    const geometry = await input.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      const card = field.closest('.question-conversation-card');
      const footer = card?.querySelector('.question-conversation-header');
      if (!card || !footer) throw new Error('Question card is unavailable');
      return {
        height: field.clientHeight,
        line: parseFloat(getComputedStyle(field).lineHeight),
        scrollHeight: field.scrollHeight,
        width: field.clientWidth,
        scrollWidth: field.scrollWidth,
        fieldBottom: field.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
        footerBottom: footer.getBoundingClientRect().bottom,
        cardBottom: card.getBoundingClientRect().bottom,
      };
    });
    expect(geometry.height).toBeGreaterThan(geometry.line * 2);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.fieldBottom);
    expect(geometry.cardBottom).toBeGreaterThanOrEqual(geometry.footerBottom);
  }).toPass();
  await expectStableCard();
  await input.press('ControlOrMeta+End');
  expect(await input.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath('long-agent-title-edit.png'),
  });
  await input.fill('Cancelled title');
  await expectStableCard();
  await input.press('Escape');
  await expect(title).toHaveText(originalTitle);
  await expectStableCard();
  await title.getByRole('button', { name: 'Rename node' }).dblclick({
    position: { x: 8, y: 16 },
  });
  await input.fill('   ');
  await input.press('Enter');
  await expect(node.getByRole('alert')).toHaveText('Enter a node name.');
  const errorColor = await node
    .getByRole('alert')
    .evaluate((element) => getComputedStyle(element).color);
  await expect(input).toHaveCSS('border-top-color', errorColor);
  await input.fill('Taken title');
  await input.press('Enter');
  await expect(node.getByRole('alert')).toHaveText(
    'Could not sync conversation title',
  );
  await expect(input).toHaveValue('Taken title');
  await input.fill('Renamed Agent card');
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
  });
  await expect(input).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('title-edit-light.png') });
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(title).toHaveText('Renamed Agent card');
  expect(await card.evaluate((element) => element.clientHeight)).toBeLessThan(
    originalHeight,
  );
  await expect(page.locator('textarea[name="agent-message"]')).toHaveCount(0);

  await title.getByRole('button', { name: 'Rename node' }).dblclick({
    position: { x: 8, y: 16 },
  });
  await input.fill('Saved on blur');
  await input.press('Tab');
  await expect(input).toHaveCount(0);
  await expect(title).toHaveText('Saved on blur');
  await page.reload();
  await expect(title).toHaveText('Saved on blur');
  const contentResponse = await page.request.get(
    `/api/canvas/${canvasId}/nodes/node-title-agent/content`,
  );
  expect(contentResponse.ok(), await contentResponse.text()).toBe(true);
  expect(await contentResponse.json()).toMatchObject({
    content: 'Keep this first prompt unchanged.',
    label: 'Saved on blur',
  });

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await title.click();
  await title.getByRole('button', { name: 'Rename node' }).focus();
  await title.getByRole('button', { name: 'Rename node' }).press('Enter');
  await expect(input).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('title-edit-dark.png') });
  await input.press('Escape');
  await node.locator('.question-conversation-header').dblclick();
  await expect(page.locator('textarea[name="agent-message"]')).toBeVisible();
});

test('Space cards retain selected-title editing, F2 and navigation isolation', async ({
  page,
}, testInfo) => {
  const targetResponse = await page.request.post('/api/canvas', {
    data: { title: 'Title editing target' },
  });
  expect(targetResponse.ok(), await targetResponse.text()).toBe(true);
  const { canvasId: target } = await targetResponse.json();
  await openNewCanvas(page);
  const source = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const created = await page.request.post(`/api/canvas/${source}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-title-space',
              nodeType: 'spacePreview',
              selectOnCreate: false,
              data: { targetCanvasId: target },
              position: { x: 150, y: 150 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-space-title' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  const card = page.locator('[data-space-shortcut]');
  const input = card.getByRole('textbox', { name: 'Rename Space' });
  await card.getByText('Title editing target', { exact: true }).click();
  await expect(input).toHaveCount(0);
  await card.getByRole('button', { name: 'Rename Space' }).click();
  await expect(input).toHaveCount(0);
  const originalHeight = await card.evaluate((element) => element.clientHeight);
  const originalTitleHeight = await card
    .getByRole('button', { name: 'Rename Space' })
    .evaluate((element) => element.clientHeight);
  const originalTitleWidth = await card
    .getByRole('button', { name: 'Rename Space' })
    .evaluate((element) => element.clientWidth);
  await card.getByRole('button', { name: 'Rename Space' }).dblclick({
    position: { x: 8, y: 16 },
  });
  await expect(input).toBeFocused();
  const editorWidth = await input.evaluate((element) => {
    const wrapper = element.parentElement;
    const row = wrapper?.parentElement;
    const marker = wrapper?.nextElementSibling;
    if (!wrapper || !row || !marker)
      throw new Error('Space title row is unavailable');
    return {
      actual: wrapper.clientWidth,
      available:
        row.clientWidth -
        (marker as HTMLElement).offsetWidth -
        parseFloat(getComputedStyle(row).columnGap),
    };
  });
  expect(editorWidth.actual).toBeGreaterThan(originalTitleWidth);
  expect(editorWidth.actual).toBeCloseTo(editorWidth.available, 0);
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    originalHeight,
  );
  await input.fill(
    'A long Space title that stays fully visible while editing even when it needs more than two lines and contains an_unbroken_segment_that_must_wrap_without_horizontal_scrolling',
  );
  await expect(input).toHaveCSS('border-top-width', '1px');
  await expect(input).toHaveCSS('--tw-ring-shadow', /0 0 0 calc\(0px/);
  await expect(async () => {
    const geometry = await input.evaluate((element) => ({
      height: element.clientHeight,
      line: parseFloat(getComputedStyle(element).lineHeight),
      scrollHeight: element.scrollHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.height).toBe(originalTitleHeight - 2);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  }).toPass();
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    originalHeight,
  );
  await input.press('ControlOrMeta+End');
  expect(await input.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath('long-space-title-edit.png'),
  });
  await input.fill('Renamed Space');
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    originalHeight,
  );
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(card).toContainText('Renamed Space');
  await expect(page).toHaveURL(`/canvas/${source}`);
  const saved = await page.request.get(`/api/canvas/${target}`);
  expect((await saved.json()).title).toBe('Renamed Space');
  await page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await input.fill('Cancelled');
  await input.press('Escape');
  await expect(card).toContainText('Renamed Space');
  await page.keyboard.press('F2');
  await input.fill('Saved on blur');
  await input.press('Tab');
  await expect(input).toHaveCount(0);
  await expect(card).toContainText('Saved on blur');
  await expect(page).toHaveURL(`/canvas/${source}`);
  await page.screenshot({ path: testInfo.outputPath('space-title.png') });
});
