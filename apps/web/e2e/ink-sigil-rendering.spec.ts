// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { oneFingerDrag, openNewCanvas, readScreenshotPixels } from './helpers';

async function seed(page: Page, split: boolean) {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.evaluate(async (split) => {
    const path = '/e2e/fixtures/ink-sigil-rendering.ts';
    (await import(/* @vite-ignore */ path)).seedInkSigilScene(split);
  }, split);
  await expect(page.locator('[data-ink-sigil-label]')).toHaveText(
    'A long resource reference',
  );
  await page.evaluate(() => document.fonts.ready);
}

test('selected and hovered split sources keep highlights below all Ink and pointer-transparent', async ({
  page,
}) => {
  await seed(page, true);
  const highlight = page.locator('[data-ink-sigil-highlight]');
  await expect(
    page.locator(
      '[data-ink-sigil-highlights="ink"] [data-ink-sigil-highlight]',
    ),
  ).toHaveCount(1);
  await page.evaluate(async () => {
    const path = '/e2e/fixtures/ink-sigil-rendering.ts';
    (await import(/* @vite-ignore */ path)).selectInk();
  });
  await expect(
    page.locator(
      '[data-ink-sigil-highlights="other-ink"] [data-ink-sigil-highlight]',
    ),
  ).toHaveCount(1);
  const source = page.locator('.react-flow__node[data-id="ink"]');
  const box = await source.boundingBox();
  if (!box) throw new Error('Missing source');
  await page.mouse.move(box.x + 10, box.y + 20);
  const pixels = await readScreenshotPixels(page, [
    { x: box.x + 10, y: box.y + 20 },
    { x: box.x + 20, y: box.y + 10 },
  ]);
  for (const pixel of pixels)
    expect(Math.max(...pixel.slice(0, 3))).toBeLessThan(60);
  const bounds = await highlight.boundingBox();
  if (!bounds) throw new Error('Missing highlight');
  // The rounded highlight extends below both intentional sigil hit targets.
  const point = {
    x: bounds.x + bounds.width - 10,
    y: bounds.y + bounds.height - 2,
  };
  for (const state of ['selected', 'hovered']) {
    await page
      .locator('.react-flow__node[data-id="other-ink"]')
      .evaluate((el, state) => {
        if (state === 'selected') el.classList.add('selected');
        else {
          el.classList.remove('selected');
          el.setAttribute('data-sketch-hover', 'true');
        }
      }, state);
    expect(
      await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const highlight = document.querySelector<HTMLElement>(
          '[data-ink-sigil-highlight]',
        );
        if (!highlight) throw new Error('Missing highlight');
        highlight.style.visibility = 'hidden';
        const uncovered = document.elementFromPoint(x, y);
        highlight.style.removeProperty('visibility');
        return {
          highlight: !!hit?.closest('[data-ink-sigil-highlights]'),
          sameTarget: hit !== null && hit === uncovered,
        };
      }, point),
    ).toEqual({ highlight: false, sameTarget: true });
  }
});

test('a visible label retains its highlight above the Frame after its source is culled', async ({
  page,
}) => {
  await seed(page, false);
  const source = page.locator('.react-flow__node[data-id="ink"]');
  const box = await source.boundingBox();
  if (!box) throw new Error('Missing source');
  const client = await page.context().newCDPSession(page);
  await oneFingerDrag(
    client,
    { x: 1100, y: 650 },
    -(box.x + box.width + 20),
    0,
  );
  await expect(source).toHaveCount(0);
  await expect(page.locator('[data-ink-sigil-label]')).toBeVisible();
  const highlight = page.locator(
    '.react-flow__viewport-portal [data-ink-sigil-highlight]',
  );
  await expect(highlight).toHaveCount(1);
  const bounds = await highlight.boundingBox();
  if (!bounds) throw new Error('Missing culled-source highlight');
  const [pixel] = await readScreenshotPixels(page, [
    { x: bounds.x + bounds.width - 10, y: bounds.y + bounds.height - 2 },
  ]);
  expect(pixel[1] - pixel[0]).toBeGreaterThan(10);
  expect(pixel[1] - pixel[2]).toBeGreaterThan(5);
  await oneFingerDrag(client, { x: 1000, y: 650 }, box.x + box.width + 20, 0);
  await expect(
    page.locator(
      '[data-ink-sigil-highlights="ink"] [data-ink-sigil-highlight]',
    ),
  ).toHaveCount(1);
  await expect(page.locator('[data-ink-sigil-highlight]')).toHaveCount(1);
});
