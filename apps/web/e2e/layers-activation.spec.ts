// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  scaleOf,
  translateOf,
} from './helpers';

test('activates a Layers node without repeated viewport takeover', async ({
  page,
}) => {
  await openNewCanvas(page);
  const center = await paneCenter(page);
  const toolbar = page.locator('.react-flow__panel.bottom.center');
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x, center.y);

  await page
    .getByRole('button', { name: 'Collapse previews' })
    .click({ force: true });
  await page.getByRole('button', { name: 'Show layers panel' }).click();

  const tree = page.getByRole('tree', { name: 'Layers' });
  const layer = tree.getByRole('treeitem').first();
  await layer.click();
  await expect(layer).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();

  await page.waitForTimeout(500);
  const settled = await readViewportTransform(page);
  await layer.click();
  await page.waitForTimeout(500);
  const repeated = await readViewportTransform(page);
  expect(scaleOf(repeated)).toBe(scaleOf(settled));
  expect(translateOf(repeated).x).toBeCloseTo(translateOf(settled).x, 0);
  expect(translateOf(repeated).y).toBeCloseTo(translateOf(settled).y, 0);

  await page
    .getByRole('button', { name: 'Collapse previews' })
    .click({ force: true });
  await layer.focus();
  await layer.press('Enter');
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();
});

test('reorders Layers rows from the keyboard drag handle', async ({ page }) => {
  await openNewCanvas(page);
  const center = await paneCenter(page);
  const toolbar = page.locator('.react-flow__panel.bottom.center');
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x - 250, center.y);
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x + 250, center.y);
  await page.getByRole('button', { name: 'Show layers panel' }).click();

  const rows = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
  await expect(rows).toHaveCount(2);
  const before = await rows.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-layer-id')),
  );

  const handle = rows.first().getByRole('button', { name: /^Reorder / });
  await handle.focus();
  await handle.press('Space');
  await handle.press('ArrowDown');
  await handle.press('Space');

  await expect
    .poll(() =>
      rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-layer-id')),
      ),
    )
    .not.toEqual(before);
});
