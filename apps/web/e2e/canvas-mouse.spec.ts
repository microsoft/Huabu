import { test, expect, type Page } from '@playwright/test';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  scaleOf,
  translateOf,
} from './helpers';

/**
 * Mouse-mode canvas behavior — the half of the touch/pen interaction work
 * that *can* be driven by automation (real-device tests cover finger/pen).
 *
 * The suite forces the effective input mode to Mouse via the persisted
 * `inputModePreference`, then exercises the mouse paths that the recent
 * touch-first changes must not regress: the Select/Pan/Lasso toolbar,
 * click-to-place returning to Select, click/drag selection + node move,
 * box-select, wheel zoom, pan-tool drag, and — critically — that node
 * text stays selectable for the mouse (the `user-select:none` suppression
 * is scoped to `[data-not-mouse]`).
 */

/** Force effective Mouse mode regardless of the emulated touch capability. */
async function useMouseMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'sediment-sketch-tools';
    const persisted = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      state?: Record<string, unknown>;
      version?: number;
    };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...persisted,
        state: { ...persisted.state, inputModePreference: 'mouse' },
      }),
    );
  });
  await page.reload();
  await page.waitForSelector('.react-flow__pane');
  await page.waitForSelector('.react-flow__viewport');
}

/** Place a Text node at `at`, give it content so it survives blur, then blur. */
async function placeTextNode(
  page: Page,
  at: { x: number; y: number },
  content = 'hello',
): Promise<void> {
  await page.getByRole('button', { name: /^Text/ }).click();
  await expect(page.locator('.canvas-pending-text').first()).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await page.keyboard.type(content);
  await page.keyboard.press('Escape');
}

test.describe('canvas mouse mode', () => {
  test.beforeEach(async ({ page }) => {
    await openNewCanvas(page);
    await useMouseMode(page);
  });

  test('Lasso tool is available (l shows the lasso cursor)', async ({
    page,
  }) => {
    await page.keyboard.press('l');
    await expect(page.locator('.cursor-crosshair')).toBeVisible();
    // Back to Select clears it.
    await page.keyboard.press('s');
    await expect(page.locator('.cursor-crosshair')).toHaveCount(0);
  });

  test('Pan tool left-drag pans the viewport', async ({ page }) => {
    await page.keyboard.press('p');
    await page.waitForTimeout(150);
    const before = translateOf(await readViewportTransform(page));
    const c = await paneCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 220, c.y + 150, { steps: 12 });
    await page.mouse.up();
    const after = translateOf(await readViewportTransform(page));
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(30);
  });

  test('click-to-place a Text node then returns to Select', async ({
    page,
  }) => {
    const c = await paneCenter(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await placeTextNode(page, c);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    // Back to Select: a plain click on empty canvas must NOT place a 2nd node.
    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });

  test('click selects a node and clicking empty clears it', async ({
    page,
  }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    const node = page.locator('.react-flow__node').first();
    const box = await node.boundingBox();
    if (!box) throw new Error('node has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  });

  test('dragging a node moves it', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    // Blur the just-created editor + clear selection so the next press
    // starts a node drag rather than re-entering the text editor.
    await page.mouse.click(c.x + 260, c.y + 160);
    const node = page.locator('.react-flow__node').first();
    const before = await node.boundingBox();
    if (!before) throw new Error('node has no bounding box');

    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      before.x + before.width / 2 + 140,
      before.y + before.height / 2 + 90,
      { steps: 10 },
    );
    await page.mouse.up();

    const after = await node.boundingBox();
    if (!after) throw new Error('moved node has no bounding box');
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(60);
  });

  test('empty drag box-selects a node in Select tool', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    await page.keyboard.press('s'); // ensure Select tool
    // Reliably clear the post-creation selection before marquee-selecting.
    await page.mouse.click(c.x + 320, c.y + 220);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    const box = await page.locator('.react-flow__node').first().boundingBox();
    if (!box) throw new Error('node has no bounding box');
    const pad = 60;
    await page.mouse.move(box.x - pad, box.y - pad);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + pad, box.y + box.height + pad, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  });

  test('ctrl + wheel over the pane zooms the viewport', async ({ page }) => {
    const c = await paneCenter(page);
    const before = scaleOf(await readViewportTransform(page));
    await page.mouse.move(c.x, c.y);
    // Plain wheel pans in mouse mode (panOnScroll); Ctrl+wheel zooms.
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const after = scaleOf(await readViewportTransform(page));
    expect(after).toBeGreaterThan(before);
  });

  test('node text stays selectable for the mouse', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c, 'selectable text');
    // Mouse mode must NOT set the touch-only user-select suppression.
    await expect(page.locator('[data-canvas-root]')).not.toHaveAttribute(
      'data-not-mouse',
      /.*/,
    );
  });
});
