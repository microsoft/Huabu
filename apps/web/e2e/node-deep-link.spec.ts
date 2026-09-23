// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas, paneCenter, readViewportTransform } from './helpers';

test('copies and restores a Note deep link without repeated viewport takeover', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openNewCanvas(page);

  const canvasId = new URL(page.url()).pathname.split('/').pop();
  if (!canvasId) throw new Error('Canvas id was not present in the route');
  const center = await paneCenter(page);
  const toolbar = page.locator(
    '[data-canvas-main-toolbar], .react-flow__panel.bottom.center',
  );
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x, center.y);

  const canvasNode = page.locator('.react-flow__node').first();
  await expect(canvasNode).toBeVisible();
  const nodeId = await canvasNode.getAttribute('data-id');
  if (!nodeId) throw new Error('Created Note did not expose its stable id');

  await canvasNode.click();
  await page
    .locator('.node-floating-toolbar')
    .getByRole('button', { name: 'More', exact: true })
    .click();
  const copyLink = page.getByRole('menuitem', {
    name: 'Copy link to node',
    exact: true,
  });
  await copyLink.click();
  await expect(copyLink).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${new URL(page.url()).origin}/canvas/${canvasId}?node=${nodeId}`);

  await page.waitForTimeout(1_000);
  await page.goto(`/canvas/${canvasId}?node=${nodeId}`);
  await expect(canvasNode).toHaveClass(/selected/);
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/canvas/${canvasId}\\?node=${nodeId}$`),
  );

  const beforeUserPan = await readViewportTransform(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(center.x + 180, center.y + 120, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const afterUserPan = await readViewportTransform(page);
  expect(afterUserPan).not.toBe(beforeUserPan);
  await page.waitForTimeout(700);
  expect(await readViewportTransform(page)).toBe(afterUserPan);

  await page.reload();
  await expect(
    page.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toHaveClass(/selected/);
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();

  await page.goto(`/canvas/${canvasId}?node=malformed`);
  await expect(
    page.getByText('This linked node is unavailable.'),
  ).toBeVisible();
  await expect(page.locator('.react-flow__pane')).toBeVisible();
});
