// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

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
