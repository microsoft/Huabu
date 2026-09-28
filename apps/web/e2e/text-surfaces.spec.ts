// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

test('Text shares the Note tint without a painted border and keeps unaccented text transparent', async ({
  page,
}) => {
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
              id: 'node-tint-note',
              nodeType: 'note',
              data: { content: 'Reference', style: { accent: 'teal' } },
              position: { x: 100, y: 100 },
              size: { width: 300, height: 200 },
            },
            {
              id: 'node-tint-text',
              nodeType: 'text',
              data: { content: 'Tinted label', style: { accent: 'teal' } },
              position: { x: 500, y: 100 },
              size: { width: 300, height: 100 },
            },
            {
              id: 'node-clear-text',
              nodeType: 'text',
              data: { content: 'Clear label', style: { accent: null } },
              position: { x: 500, y: 300 },
              size: { width: 300, height: 100 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-text-surfaces' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const text = page.locator('[data-id="node-tint-text"] .semantic-lod-node');
  const clear = page.locator('[data-id="node-clear-text"] .semantic-lod-node');
  const note = page.locator('[data-id="node-tint-note"] .semantic-lod-node');
  await expect(text).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value),
      dark,
    );
    await expect
      .poll(async () => {
        const reference = await note.evaluate(
          (e) => getComputedStyle(e).backgroundColor,
        );
        const actual = await text.evaluate(
          (e) => getComputedStyle(e).backgroundColor,
        );
        return actual === reference && actual !== 'rgba(0, 0, 0, 0)';
      })
      .toBe(true);
    await expect(clear).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    for (const shell of [text, clear]) {
      await expect(shell).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      await expect(shell).toHaveCSS('border-top-width', '3px');
      await expect(shell).toHaveClass(/hover:ring/);
    }
    await expect(note).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  }
  await text.dblclick();
  const editor = text.locator('textarea');
  await expect(editor).toBeFocused();
  await editor.fill('Edited label');
  await page.keyboard.press('Tab');
  await expect(text).toContainText('Edited label');
  await expect(text).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
});
