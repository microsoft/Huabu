// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

test('Agent cards rename inline without changing the prompt or opening Chat', async ({
  page,
}, testInfo) => {
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
                label: 'Original title',
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
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Original title');
  await expect(page.locator('textarea[name="agent-message"]')).toHaveCount(0);

  await input.fill('Cancelled title');
  await input.press('Escape');
  await expect(title).toHaveText('Original title');
  await title.getByRole('button', { name: 'Rename node' }).click();
  await input.fill('   ');
  await input.press('Enter');
  await expect(node.getByRole('alert')).toHaveText('Enter a node name.');
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
  await expect(page.locator('textarea[name="agent-message"]')).toHaveCount(0);

  await title.getByRole('button', { name: 'Rename node' }).click();
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
  await title.getByRole('button', { name: 'Rename node' }).click();
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
  await expect(input).toBeFocused();
  await input.fill('Renamed Space');
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
