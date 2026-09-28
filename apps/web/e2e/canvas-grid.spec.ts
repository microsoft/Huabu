// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  scaleOf,
} from './helpers';

test('production grid stays visible, bounded and world-anchored across zoom and pan', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  expect(canvasId).toBeTruthy();
  const grid = page.getByTestId('canvas-grid');
  await page.addInitScript((canvasId) => {
    const zoom = Number(new URL(location.href).searchParams.get('gridZoom'));
    if (zoom > 0) {
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: -137, y: 83, zoom }),
      );
    }
  }, canvasId);

  for (const zoom of [0.05, 0.125, 0.5, 1, 1.9999, 2, 4, 5]) {
    // Set the supported persisted viewport before the next production mount.
    await page.goto(`/canvas/${canvasId}?gridZoom=${zoom}`);
    await expect(grid).toBeVisible();
    await expect
      .poll(async () => scaleOf(await readViewportTransform(page)))
      .toBeCloseTo(zoom, 4);
    const metrics = await grid.evaluate((svg) => {
      const pattern = svg.querySelector('pattern');
      const dot = svg.querySelector('circle');
      const viewport = svg.parentElement?.querySelector<HTMLElement>(
        '.react-flow__viewport',
      );
      if (!pattern || !dot || !viewport)
        throw new Error('Missing canvas grid or viewport');
      const transform = new DOMMatrix(viewport.style.transform);
      return {
        width: Number(pattern.getAttribute('width')),
        x: Number(pattern.getAttribute('x')),
        y: Number(pattern.getAttribute('y')),
        radius: Number(dot.getAttribute('r')),
        cx: Number(dot.getAttribute('cx')),
        cy: Number(dot.getAttribute('cy')),
        opacity: getComputedStyle(dot).opacity,
        fill: getComputedStyle(dot).fill,
        pointerEvents: getComputedStyle(svg).pointerEvents,
        translateX: transform.e,
        translateY: transform.f,
      };
    });
    expect(metrics.width).toBeGreaterThanOrEqual(36);
    expect(metrics.width).toBeLessThan(72);
    expect(metrics.radius).toBe(0.85);
    expect(metrics.opacity).toBe('1');
    expect(metrics.fill).not.toBe('none');
    expect(metrics.pointerEvents).toBe('none');
    expect(metrics.x + metrics.cx).toBeCloseTo(
      metrics.translateX % metrics.width,
      5,
    );
    expect(metrics.y + metrics.cy).toBeCloseTo(
      metrics.translateY % metrics.width,
      5,
    );
    await expect(grid.locator('circle')).toHaveCount(4);
  }

  await grid.screenshot({ path: test.info().outputPath('grid-500-light.png') });
  const light = await grid
    .locator('circle')
    .first()
    .evaluate((dot) => getComputedStyle(dot).fill);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect
    .poll(() =>
      grid
        .locator('circle')
        .first()
        .evaluate((dot) => getComputedStyle(dot).fill),
    )
    .not.toBe(light);
  await grid.screenshot({ path: test.info().outputPath('grid-500-dark.png') });

  const center = await paneCenter(page);
  const before = await readViewportTransform(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(83, 137);
  await expect.poll(() => readViewportTransform(page)).not.toBe(before);
  await expect(grid).toBeVisible();
  expect(errors).toEqual([]);
});
