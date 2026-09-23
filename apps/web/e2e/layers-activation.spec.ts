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

test('mounts Layers on demand and restores filtered scrolling and focus', async ({
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
          nodes: Array.from({ length: 50 }, (_, index) => ({
            nodeType: index === 0 ? 'text' : 'note',
            data: { label: `Layer ${index}`, content: `Body ${index}` },
            position: { x: 3000 + index * 450, y: 3000 },
            size: { width: 400, height: 200 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-layers-lifecycle' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const tree = page.getByRole('tree', { name: 'Layers' });
  await expect(tree).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(50);
  await page
    .getByRole('button', { name: 'Filter by Note', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  const focusedRow = tree.getByRole('treeitem').nth(12);
  await focusedRow.focus();
  const focusedId = await focusedRow.getAttribute('data-layer-id');
  const scrollHost = tree.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]',
  );
  await scrollHost.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(300);
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(tree).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  await expect(
    page.getByRole('button', { name: 'Stop filtering by Note', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(300);
  await expect(tree.locator(`[data-layer-id="${focusedId}"]`)).toHaveAttribute(
    'tabindex',
    '0',
  );
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reopenedRow = tree.locator(`[data-layer-id="${focusedId}"]`);
  await reopenedRow.click({ position: { x: 50, y: 18 } });
  await expect(reopenedRow).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^Body 37/ })).toBeVisible();
  await page.getByRole('button', { name: /^Search this Space/ }).click();
  const searchInput = page.locator('[data-canvas-search-input]');
  await searchInput.fill('Body');
  const searchResults = page.locator('[data-canvas-search-results]');
  await expect(searchResults.getByRole('button').first()).toBeVisible();
  await expect(page.getByLabel('Searching', { exact: true })).toHaveCount(0);
  await searchInput.focus();
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press('ArrowDown');
  }
  const searchScroller = searchResults.locator('[data-virtuoso-scroller]');
  await expect
    .poll(() => searchScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const searchScrollTop = await searchScroller.evaluate(
    (element) => element.scrollTop,
  );
  const activeResult = searchResults.locator('button.bg-info-bg');
  const activeText = await activeResult.textContent();
  const selectedNode = await page
    .locator('.react-flow__node.selected')
    .getAttribute('data-id');
  await searchResults.evaluate((element) => {
    element.setAttribute('data-lifecycle-probe', 'retained');
  });
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await page.waitForTimeout(350);
  await expect(searchResults).toHaveAttribute(
    'data-lifecycle-probe',
    'retained',
  );
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(searchInput).toHaveValue('Body');
  await expect(activeResult).toHaveText(activeText ?? '');
  await expect
    .poll(() => searchScroller.evaluate((element) => element.scrollTop))
    .toBe(searchScrollTop);
  await expect(page.locator('.react-flow__node.selected')).toHaveAttribute(
    'data-id',
    selectedNode ?? '',
  );
  await searchInput.press('Escape');
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(tree).toHaveCount(0);
  await openNewCanvas(page);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(0);
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test('activates a Layers node without repeated viewport takeover', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const center = await paneCenter(page);
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);

  const collapsePreviews = page.getByRole('button', {
    name: 'Collapse previews',
  });
  if (await collapsePreviews.isVisible()) await collapsePreviews.click();
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

  await collapsePreviews.click();
  await layer.focus();
  await layer.press('Enter');
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();
});

test('reorders Layers rows from the keyboard drag handle', async ({ page }) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const center = await paneCenter(page);
  const toolbar = page.locator('[data-canvas-main-toolbar]');
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
