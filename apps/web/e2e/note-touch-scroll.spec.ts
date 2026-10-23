// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import {
  oneFingerDrag,
  openNewCanvas,
  paneCenter,
  pinch,
  readViewportTransform,
  readScreenshotPixels,
  scaleOf,
  touchTap,
} from './helpers';

async function openScrollableNote(page: Page) {
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
              nodeType: 'note',
              data: {
                label: 'Touch reading',
                content: 'A paragraph for touch reading.\n\n'.repeat(35),
              },
              position: { x: 100, y: 100 },
              size: { width: 400, height: 240 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-touch-reading' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note .ProseMirror')).toHaveCount(
    1,
  );
}

test('leaving the Canvas during a held Note scroll releases gesture ownership', async ({
  page,
}) => {
  await openScrollableNote(page);
  const viewport = page.locator('[data-note-content-viewport]');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Note viewport is not visible');
  const point = { x: box.x + 100, y: box.y + 150 };
  const client = await page.context().newCDPSession(page);
  await touchTap(client, point);
  await touchTap(client, point);
  await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: point.x, y: point.y - 50 }],
  });
  const readGesture = () =>
    page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      return (
        await load('/src/handler/canvasGestureSession.ts')
      ).getCanvasGesture();
    });
  expect(await readGesture()).toMatchObject({
    kind: 'note-scroll',
    phase: 'locked',
  });
  // Preserve the app's module state while unmounting Canvas through its router.
  await page.evaluate(() => {
    history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('.react-flow__pane')).toHaveCount(0);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  expect(await readGesture()).toBeNull();

  await page.goBack();
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await page.keyboard.press('Escape');
  const before = await readViewportTransform(page);
  await pinch(client, await paneCenter(page), 300, 100);
  await expect
    .poll(async () => scaleOf(await readViewportTransform(page)))
    .toBeLessThan(scaleOf(before));
});

for (const initialTool of ['Pen', 'Lasso'] as const) {
  test(`finger Note reading survives Ink tool switches starting with ${initialTool}`, async ({
    page,
  }) => {
    await openScrollableNote(page);
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { useToolStore } = await load('/src/store/toolStore.ts');
      useToolStore.getState().setInputModePreference('pen');
    });
    const client = await page.context().newCDPSession(page);
    const note = page.locator('.react-flow__node-note');
    const viewport = note.locator('[data-note-content-viewport]');
    const box = await viewport.boundingBox();
    if (!box) throw new Error('Note viewport is not visible');
    const point = { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
    await page
      .locator('.react-flow__pane')
      .tap({ position: { x: 1100, y: 150 } });
    await page.getByRole('button', { name: initialTool, exact: true }).tap();
    if (initialTool === 'Pen') {
      await expect(page.locator('[data-sketch-overlay]')).toBeVisible();
    }
    await touchTap(client, point);
    await expect(note).toHaveClass(/selected/);
    await touchTap(client, point);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    const nodeBefore = await note.boundingBox();
    const canvasBefore = await readViewportTransform(page);
    for (const tool of ['Pen', 'Lasso', 'Pen', 'Eraser', 'Lasso']) {
      const before = await viewport.evaluate((el) => el.scrollTop);
      await page.getByRole('button', { name: tool, exact: true }).tap();
      await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
      expect(await viewport.evaluate((el) => el.scrollTop)).toBe(before);
      await oneFingerDrag(client, point, 0, -35);
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(before);
      expect(await note.boundingBox()).toEqual(nodeBefore);
      expect(await readViewportTransform(page)).toBe(canvasBefore);
    }
    await expect(page.locator('.react-flow__node-sketch')).toHaveCount(0);
    await expect(page.locator('[data-canvas-panel="right"]')).toBeHidden();
    await page.getByRole('button', { name: 'Pen', exact: true }).tap();
    await touchTap(client, point);
    await expect(note).not.toHaveClass(/selected/);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'false');
    await touchTap(client, point);
    await expect(note).toHaveClass(/selected/);
    await touchTap(client, point);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    const scrollBeforeInk = await viewport.evaluate((el) => el.scrollTop);
    const ink = { x: point.x, y: point.y - 60 };
    for (const [x1, y1, x2, y2] of [
      [10, 0, 10, 40],
      [30, 0, 30, 40],
      [0, 10, 40, 10],
      [0, 30, 40, 30],
    ]) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: ink.x + x1,
        y: ink.y + y1,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
        clickCount: 1,
        force: 0.5,
      });
      for (let step = 1; step <= 10; step++) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: ink.x + x1 + ((x2 - x1) * step) / 10,
          y: ink.y + y1 + ((y2 - y1) * step) / 10,
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
          force: 0.5,
        });
      }
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: ink.x + x2,
        y: ink.y + y2,
        button: 'left',
        buttons: 0,
        pointerType: 'pen',
        clickCount: 1,
      });
    }
    await expect(page.locator('.react-flow__node-sketch')).toHaveCount(1);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(scrollBeforeInk);
    await expect(page.getByRole('dialog')).toBeVisible();
    const [strokePixel] = await readScreenshotPixels(page, [
      { x: ink.x + 10, y: ink.y + 20 },
    ]);
    expect(Math.max(...strokePixel.slice(0, 3))).toBeLessThan(60);
    await touchTap(client, { x: box.x + 25, y: box.y + 25 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-ink-sigil-label]')).toHaveText(
      /touch reading/i,
    );
    await expect(note).toHaveClass(/selected/);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(scrollBeforeInk);
    await pinch(client, point, 30, 100);
    await expect.poll(() => readViewportTransform(page)).not.toBe(canvasBefore);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
  });
}

for (const { pointerType, preference } of [
  { pointerType: 'touch', preference: 'finger' },
  { pointerType: 'touch', preference: 'pen' },
  { pointerType: 'pen', preference: 'pen' },
  { pointerType: 'pen', preference: 'auto' },
] as const) {
  test(`${pointerType} in ${preference} mode: select, move, enter reading, scroll, and tap to deselect`, async ({
    page,
  }) => {
    await openScrollableNote(page);
    await page.evaluate(async (preference) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { useToolStore } = await load('/src/store/toolStore.ts');
      if (preference === 'auto') {
        useToolStore.setState({ penObserved: false });
      }
      useToolStore.getState().setInputModePreference(preference);
    }, preference);
    if (preference === 'auto') {
      expect(
        await page.evaluate(async () => {
          const load = (path: string) => import(/* @vite-ignore */ path);
          return (
            await load('/src/hooks/useInputMode.ts')
          ).readEffectiveInputMode();
        }),
      ).toBe('finger');
    }
    const note = page.locator('.react-flow__node-note');
    const viewport = note.locator('[data-note-content-viewport]');
    const scrollbar = note.locator('[data-note-touch-scrollbar]');
    await expect(note.locator('.ProseMirror')).toHaveCount(1);
    const client = await page.context().newCDPSession(page);
    const point = async () => {
      const box = await viewport.boundingBox();
      if (!box) throw new Error('Note viewport is not visible');
      return { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
    };
    const gesture = async (dx = 0, dy = 0) => {
      const start = await point();
      if (pointerType === 'touch') {
        if (dx || dy) await oneFingerDrag(client, start, dx, dy);
        else await touchTap(client, start);
        return;
      }

      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...start,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
        clickCount: 1,
      });
      for (let step = 1; step <= 8; step++) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: start.x + (dx * step) / 8,
          y: start.y + (dy * step) / 8,
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
        });
      }
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: start.x + dx,
        y: start.y + dy,
        button: 'left',
        buttons: 0,
        pointerType: 'pen',
        clickCount: 1,
      });
    };

    await gesture();
    await expect(note).toHaveClass(/selected/);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'false');
    await expect(viewport).toHaveCSS('scrollbar-width', 'none');
    await expect(scrollbar).toHaveCount(0);
    const documentWidth = await note
      .locator('.ProseMirror')
      .evaluate((el) => el.getBoundingClientRect().width);
    const original = await note.boundingBox();
    await gesture(50, 0);
    await expect
      .poll(async () => (await note.boundingBox())?.x)
      .not.toBe(original?.x);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'false');
    await gesture();
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    await expect(scrollbar).toBeVisible();
    await expect(viewport).toHaveCSS('scrollbar-width', 'none');
    expect(
      await note
        .locator('.ProseMirror')
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(documentWidth);
    await expect(
      note.getByRole('status').filter({ hasText: 'Swipe to scroll' }),
    ).toHaveText('Swipe to scroll · Tap to deselect');
    await expect(
      note.getByRole('status').filter({ hasText: 'Swipe to scroll' }),
    ).toHaveClass('sr-only');
    const thumbStart = await scrollbar.locator('div').boundingBox();
    const before = await readViewportTransform(page);
    const nodeBefore = await note.boundingBox();
    await gesture(0, -80);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    expect(await readViewportTransform(page)).toBe(before);
    expect(await note.boundingBox()).toEqual(nodeBefore);
    await expect
      .poll(async () => (await scrollbar.locator('div').boundingBox())?.y ?? 0)
      .toBeGreaterThan(thumbStart?.y ?? 0);
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const bottom = await viewport.evaluate((el) => el.scrollTop);
    await gesture(0, -40);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(bottom);
    expect(await readViewportTransform(page)).toBe(before);
    expect(await note.boundingBox()).toEqual(nodeBefore);
    await expect
      .poll(() =>
        scrollbar.evaluate((track) => {
          const thumb = track.firstElementChild;
          if (!thumb) throw new Error('Missing reading scrollbar thumb');
          return Math.abs(
            thumb.getBoundingClientRect().bottom -
              track.getBoundingClientRect().bottom,
          );
        }),
      )
      .toBeLessThan(1);
    const offset = await viewport.evaluate((el) => el.scrollTop);
    await gesture();
    await expect(note).not.toHaveClass(/selected/);
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'false');
    await expect(scrollbar).toHaveCount(0);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(offset);
    await gesture();
    await expect(note).toHaveClass(/selected/);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(offset);
    await gesture();
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    await page.screenshot({
      path: test.info().outputPath(`note-reading-${pointerType}.png`),
    });
    await expect(page.locator('[data-canvas-panel="right"]')).toBeHidden();
    if (pointerType === 'touch') {
      await pinch(client, await point(), 30, 100);
      await expect.poll(() => readViewportTransform(page)).not.toBe(before);
      await expect(note).toHaveClass(/selected/);
      await expect(viewport).toHaveAttribute('data-note-touch-reading', 'true');
    }
    await page
      .locator('.react-flow__pane')
      .tap({ position: { x: 1180, y: 600 } });
    await expect(viewport).toHaveAttribute('data-note-touch-reading', 'false');
  });
}
