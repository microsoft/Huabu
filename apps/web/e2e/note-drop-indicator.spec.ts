// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas, editsPerCommand } from './helpers';

import type * as PreviewActions from '../src/store/previewWorkspace/actions';

test.use({ hasTouch: false, viewport: { width: 1500, height: 900 } });

test('dragging a Note block in the Preview panel shows the drop line above the panel', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  if (!canvasId) throw new Error('Missing canvas ID');
  const content = Array.from(
    { length: 8 },
    (_, index) => `Paragraph number ${index + 1} with some words.`,
  ).join('\n\n');
  const created = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-drop-indicator',
              nodeType: 'note',
              data: { label: 'Drop indicator', content },
              position: { x: 100, y: 100 },
              size: { width: 300, height: 240 },
            },
          ],
        },
      ]),
      originator: { source: 'agent', threadId: 'note-drop-indicator' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await page.evaluate(async () => {
    const path = '/src/store/previewWorkspace/actions.ts';
    const { openPreviewNode } = (await import(path)) as typeof PreviewActions;
    openPreviewNode('node-drop-indicator');
  });
  const editor = page.locator('.milkdown-note-preview .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.locator('p').nth(1).hover();
  const grip = page
    .locator('.milkdown-block-handle[data-show="true"] .operation-item')
    .last();
  await expect(grip).toBeVisible();
  const from = await grip.boundingBox();
  const to = await editor.locator('p').nth(5).boundingBox();
  if (!from || !to) throw new Error('Missing drag geometry');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // The indicator hides 30ms after a dragleave that no dragover follows, and
  // an emulated drag only sends dragover while the pointer moves. So it is
  // read on the step that shows it, not after the pointer has come to rest.
  let shown: {
    width: number;
    height: number;
    top: number;
    indicatorZ: number;
    panelZ: number;
  } | null = null;
  for (let step = 1; step <= 12 && !shown; step += 1) {
    await page.mouse.move(
      from.x + 30 + step * 3,
      from.y + (to.y - from.y) * (step / 12) + 2,
    );
    shown = await page.evaluate(() => {
      const indicator = Array.from(
        document.querySelectorAll<HTMLElement>('.milkdown-drop-indicator'),
      ).find((element) => element.style.display === 'block');
      if (!indicator) return null;
      // The highest layer among the Preview panel's own ancestors: the
      // indicator lives on `document.body` and has to be painted above it.
      let panelZ = 0;
      for (
        let element: Element | null = document.querySelector(
          '.milkdown-note-preview',
        );
        element && element !== document.body;
        element = element.parentElement
      ) {
        const z = Number(getComputedStyle(element).zIndex);
        if (Number.isFinite(z)) panelZ = Math.max(panelZ, z);
      }
      const bounds = indicator.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        top: bounds.top,
        indicatorZ: Number(getComputedStyle(indicator).zIndex),
        panelZ,
      };
    });
  }
  await page.mouse.up();

  if (!shown) throw new Error('The drop line never appeared during the drag');
  const editorBounds = await editor.boundingBox();
  if (!editorBounds) throw new Error('Missing editor bounds');
  expect(shown.height).toBeGreaterThan(0);
  expect(shown.width).toBeGreaterThan(editorBounds.width / 2);
  expect(shown.top).toBeGreaterThan(editorBounds.y);
  expect(shown.top).toBeLessThan(editorBounds.y + editorBounds.height);
  // Drawn in the right place is not enough: at `z-index: auto` it sat under
  // the overlay panel and was never seen.
  expect(shown.panelZ).toBeGreaterThan(0);
  expect(shown.indicatorZ).toBeGreaterThan(shown.panelZ);
});
