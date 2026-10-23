// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { devices, expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

test.use({ ...devices['iPad (gen 7)'], browserName: 'webkit' });

// Desktop WebKit emulates iPad layout/input but not the iOS touch-callout UI.
test('iPad canvas chrome cannot form native selections while title editing remains available', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').tap({ position: { x: 800, y: 200 } });
  const header = page.locator('[data-canvas-header]:visible');
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  await expect(toolbar).toBeVisible();
  for (const surface of [
    header,
    toolbar,
    toolbar.locator('button').first(),
    toolbar.locator('svg').first(),
  ]) {
    await expect(surface).toHaveCSS('-webkit-user-select', 'none');
  }
  const box = await toolbar.boundingBox();
  if (!box) throw new Error('Missing canvas toolbar');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

  const title = header.locator('input[name="space-title"]');
  await expect(title).toHaveCSS('-webkit-user-select', 'text');
  await title.fill('Editable Space title');
  await title.press('ControlOrMeta+A');
  expect(
    await title.evaluate((el: HTMLInputElement) =>
      el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    ),
  ).toBe('Editable Space title');
  await title.press('Enter');
  await expect(title).toHaveValue('Editable Space title');
});

test('iPad portalled tool controls and canvas objects stay natively nonselectable', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const path = '/e2e/fixtures/ink-sigil-rendering.ts';
    const fixture = await import(/* @vite-ignore */ path);
    fixture.seedInkSigilScene(false);
    fixture.selectInk();
  });
  const toolbar = page.locator('.node-floating-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCSS('-webkit-user-select', 'none');
  await expect(page.locator('.react-flow__node[data-id="ink"]')).toHaveClass(
    /selected/,
  );
  await page.locator('.react-flow__pane').tap({ position: { x: 600, y: 800 } });
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'data-not-mouse',
    '',
  );
  await expect(page.locator('.react-flow__node[data-id="ink"]')).toHaveCSS(
    '-webkit-user-select',
    'none',
  );
});
