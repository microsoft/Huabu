// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas, readViewportTransform } from './helpers';

test('shorter zoom control aligns with the unchanged main toolbar bottom', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const toolbar = page.locator('[data-canvas-main-toolbar] > div').first();
  const zoom = page.locator('.react-flow__controls');
  const layout = page.locator('[data-overlay-layout]');
  const assertGeometry = async () => {
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS('height', '46px');
    await expect(toolbar).toHaveCSS('padding', '6px 8px');
    await expect(toolbar).toHaveCSS('gap', '6px');
    await expect(zoom).toHaveCSS('height', '34px');
    await expect(zoom).toHaveCSS('width', '72px');
    const toolbarBox = await toolbar.boundingBox();
    const zoomBox = await zoom.boundingBox();
    const layoutBox = await layout.boundingBox();
    if (!toolbarBox || !zoomBox || !layoutBox) {
      throw new Error('Expected visible bottom controls and work area');
    }
    const bottom = layoutBox.y + layoutBox.height - 24;
    expect(toolbarBox.y + toolbarBox.height).toBeCloseTo(bottom, 1);
    expect(zoomBox.y + zoomBox.height).toBeCloseTo(bottom, 1);
    expect(zoomBox.y).toBeGreaterThan(toolbarBox.y);
    const note = toolbar.getByRole('button', { name: /^Note/ });
    await expect(note).toHaveCSS('width', '32px');
    await expect(note).toHaveCSS('height', '32px');
    await expect(note.locator('svg')).toHaveCSS('width', '16px');
    await expect(note.locator('svg')).toHaveCSS('height', '16px');
  };

  await assertGeometry();
  await page.screenshot({
    path: test.info().outputPath('compact-bottom-controls.png'),
  });
  await page.setViewportSize({ width: 960, height: 720 });
  await assertGeometry();
  await zoom.getByRole('button').tap();
  await expect(page.getByRole('dialog', { name: 'Canvas zoom' })).toBeVisible();
  await page.keyboard.press('Escape');
  await assertGeometry();
});

test('main toolbar stays centered in the uncovered canvas without changing its size or viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 850 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'huabu-panel',
      JSON.stringify({
        state: { isLeftCollapsed: true, isRightCollapsed: true },
        version: 0,
      }),
    );
  });
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const toolbar = page.locator('[data-canvas-main-toolbar] > div').first();
  const layout = page.locator('[data-overlay-layout]');
  const initial = await toolbar.boundingBox();
  if (!initial) throw new Error('Expected the main toolbar to be visible');
  const viewport = await readViewportTransform(page);
  const assertCentered = async () => {
    await expect(toolbar).toBeVisible();
    await expect
      .poll(() =>
        layout.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const left = element.querySelector('[data-canvas-panel="left"]');
          const right = element.querySelector('[data-canvas-panel="right"]');
          const toolbar = element.querySelector('[data-canvas-main-toolbar]');
          if (!left || !right || !toolbar) {
            throw new Error('Expected both panel shells and the main toolbar');
          }
          const visibleLeft = left.hasAttribute('data-collapsed')
            ? bounds.left
            : left.getBoundingClientRect().right;
          const visibleRight = right.hasAttribute('data-collapsed')
            ? bounds.right
            : right.getBoundingClientRect().left;
          const toolbarBounds = toolbar.getBoundingClientRect();
          return Math.abs(
            toolbarBounds.x +
              toolbarBounds.width / 2 -
              (visibleLeft + visibleRight) / 2,
          );
        }),
      )
      .toBeLessThan(0.5);
    const bounds = await toolbar.boundingBox();
    if (!bounds) throw new Error('Expected the main toolbar to remain visible');
    expect(bounds.width).toBeCloseTo(initial.width, 1);
    expect(bounds.height).toBeCloseTo(initial.height, 1);
    expect(bounds.y).toBeCloseTo(initial.y, 1);
    expect(await readViewportTransform(page)).toBe(viewport);
  };

  await assertCentered();
  await page.getByRole('button', { name: /show layers panel/i }).click();
  await assertCentered();
  await page.getByRole('button', { name: /open chat panel/i }).click();
  await assertCentered();

  for (const side of ['left', 'right']) {
    const panel = page.locator(`[data-canvas-panel="${side}"]`);
    const before = await panel.boundingBox();
    const handle = await panel.getByRole('separator').boundingBox();
    if (!before || !handle) throw new Error('Expected a visible panel handle');
    const x = handle.x + handle.width / 2;
    const y = handle.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (side === 'left' ? 50 : -100), y, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0)
      .toBeGreaterThan(before.width + 40);
    await assertCentered();
  }

  await page.getByRole('button', { name: /collapse layers panel/i }).click();
  await assertCentered();
  await page.getByTestId('collapse-preview').click();
  await assertCentered();
});
