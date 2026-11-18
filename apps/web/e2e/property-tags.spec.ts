// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas, editsPerCommand } from './helpers';

import type * as PreviewActions from '../src/store/previewWorkspace/actions';

test.use({ hasTouch: false, viewport: { width: 1600, height: 1000 } });

test('tags are picked with the pointer and corrected in place', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-tags-edited',
              nodeType: 'note',
              data: {
                label: 'Edited',
                content: 'Body',
                properties: { keywords: ['canvas', 'widget'] },
              },
              position: { x: 100, y: 100 },
            },
            {
              id: 'node-tags-other',
              nodeType: 'note',
              data: {
                label: 'Other',
                content: 'Body',
                properties: { keywords: ['agents', 'ink'] },
              },
              position: { x: 100, y: 500 },
            },
          ],
        },
      ]),
      originator: { source: 'agent', threadId: 'e2e-property-tags' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
  await page.evaluate(async () => {
    const previewPath = '/src/store/previewWorkspace/actions.ts';
    const { openPreviewNode } = (await import(
      previewPath
    )) as typeof PreviewActions;
    openPreviewNode('node-tags-edited');
  });

  await page.getByRole('button', { name: 'Edit keywords' }).click();
  const field = page.getByRole('combobox', { name: 'Value' });
  await expect(field).toBeFocused();
  await page.getByRole('option', { name: 'agents' }).click();
  await expect(field).toBeFocused();
  await expect(page.locator('form [data-property-tag]')).toHaveText([
    'canvas',
    'widget',
    'agents',
  ]);

  // A chosen tag turns back into text where it stands, and is corrected there.
  await page.getByRole('button', { name: 'Edit canvas' }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('canvas');
  await field.fill('canvases');
  await page.getByRole('option', { name: 'canvases' }).click();
  await expect(field).toBeFocused();
  // Enter saves once the pointer no longer rests on an option.
  await page.mouse.move(0, 0);
  await field.press('Enter');
  await expect(
    page
      .getByRole('button', { name: 'Edit keywords' })
      .locator('[data-property-tag]'),
  ).toHaveText(['canvases', 'widget', 'agents']);
});

test('a tag removed from a PDF an agent wrote saves without a conflict', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  // The agent write makes the web re-derive its save baseline from the node
  // it holds, and a PDF's extracted body is never sent to it.
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-tags-pdf',
              nodeType: 'pdf',
              data: {
                label: 'Paper',
                src: 'https://example.test/paper.pdf',
                properties: { keywords: ['canvas', 'widget'] },
              },
              position: { x: 100, y: 100 },
              size: { width: 300, height: 300 },
            },
          ],
        },
      ]),
      originator: { source: 'agent', threadId: 'e2e-property-tags' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node-pdf')).toHaveCount(1);
  await page.evaluate(async () => {
    const previewPath = '/src/store/previewWorkspace/actions.ts';
    const { openPreviewNode } = (await import(
      previewPath
    )) as typeof PreviewActions;
    openPreviewNode('node-tags-pdf');
  });

  const row = page.getByRole('button', { name: 'Edit keywords' });
  for (const [removed, left] of [
    ['canvas', ['widget']],
    ['widget', []],
  ] as const) {
    await row.click();
    await page.getByRole('button', { name: `Remove ${removed}` }).click();
    const saved = page.waitForResponse(
      (candidate) => candidate.request().method() === 'PUT',
    );
    await page.getByRole('combobox', { name: 'Value' }).press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(row.locator('[data-property-tag]')).toHaveText([...left]);
  }
  await expect(page.getByText('was changed elsewhere')).toHaveCount(0);
});
