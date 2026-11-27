// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';

import { openNewCanvas, paneCenter, type Point } from './helpers';

// Real UI and a real server. The only thing injected is time: an upload is
// held, or failed once, so the card that stands in for the node can be seen.
const UPLOAD = '**/api/canvas/*/artifact/*';

/** Drop a 800×400 PNG, and optionally an mp3, onto the canvas at `at`. */
async function dropFiles(page: Page, at: Point, withAudio = false) {
  await page.evaluate(
    async ({ at, withAudio }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext('2d');
      const pane = document.querySelector('.react-flow__pane');
      if (!context || !pane) throw new Error('canvas is not ready');
      context.fillStyle = '#3b82f6';
      context.fillRect(0, 0, 800, 400);
      const png = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!png) throw new Error('could not encode the test image');
      const data = new DataTransfer();
      data.items.add(new File([png], 'photo.png', { type: 'image/png' }));
      if (withAudio)
        data.items.add(
          new File(['not really audio'], 'song.mp3', { type: 'audio/mpeg' }),
        );
      pane.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          clientX: at.x,
          clientY: at.y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { at, withAudio },
  );
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return box;
}

test('a dropped file shows a card at once and the node takes its place', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  const held: Route[] = [];
  await page.route(UPLOAD, (route) =>
    route.request().method() === 'POST' ? held.push(route) : route.continue(),
  );
  const center = await paneCenter(page);
  const at = { x: center.x - 200, y: center.y - 150 };
  await dropFiles(page, at, true);

  const cards = page.locator('[data-import-placeholder="uploading"]');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  // The image card already has the picture's 2:1 shape and starts where the
  // file was dropped; the audio card names its file.
  const imageCard = await boxOf(cards.first());
  expect(imageCard.width / imageCard.height).toBeCloseTo(2, 1);
  expect(imageCard.x).toBeCloseTo(at.x, 0);
  expect(imageCard.y).toBeCloseTo(at.y, 0);
  await expect(cards.nth(1)).toContainText('song.mp3');
  await page.screenshot({ path: testInfo.outputPath('uploading.png') });

  await expect.poll(() => held.length).toBe(2);
  for (const route of held) await route.continue();
  const image = page.locator('.react-flow__node-image');
  await expect(image).toHaveCount(1);
  await expect(page.locator('.react-flow__node-audio')).toHaveCount(1);
  await expect(page.locator('[data-import-placeholder]')).toHaveCount(0);
  // The node lands exactly where its card stood.
  const node = await boxOf(image);
  expect(node.x).toBeCloseTo(imageCard.x, 0);
  expect(node.y).toBeCloseTo(imageCard.y, 0);
  expect(node.width).toBeCloseTo(imageCard.width, 0);
  expect(node.height).toBeCloseTo(imageCard.height, 0);
  await page.screenshot({ path: testInfo.outputPath('imported.png') });
});

test('a failed upload stays as a card that can be retried', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  let fail = true;
  await page.route(UPLOAD, (route) => {
    if (route.request().method() !== 'POST' || !fail) return route.continue();
    fail = false;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Failed to save file' }),
    });
  });
  await dropFiles(page, await paneCenter(page));

  const failed = page.locator('[data-import-placeholder="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('photo.png');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('failed.png') });

  // The emulated touch device starts with the pen, which owns every pointer.
  await page.keyboard.press('s');
  await expect(page.locator('[data-sketch-overlay]')).toHaveCount(0);
  await failed.getByRole('button', { name: 'Retry' }).tap();
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1);
  await expect(page.locator('[data-import-placeholder]')).toHaveCount(0);
});
