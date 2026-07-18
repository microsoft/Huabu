import { test, expect } from '@playwright/test';

import {
  oneFingerDrag,
  openNewCanvas,
  paneCenter,
  pinch,
  readViewportTransform,
  scaleOf,
  translateOf,
} from './helpers';

/**
 * Baseline behavior guardrail for canvas touch navigation.
 *
 * These tests pin the current touch gesture behavior so the planned
 * pointer-router refactor (docs/proposals/canvas-pointer-router.md) can
 * be verified as behavior-preserving. They run in a `hasTouch` context
 * so the app resolves to touch mode with the default (finger) interaction
 * mode and no explicit tool active.
 */
test.describe('canvas touch navigation', () => {
  test('two-finger pinch out zooms the viewport in', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    const before = await readViewportTransform(page);
    await pinch(client, center, 60, 460);
    await page.waitForTimeout(150);
    const after = await readViewportTransform(page);

    expect(scaleOf(after)).toBeGreaterThan(scaleOf(before));
  });

  test('two-finger pinch in zooms the viewport out', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    // First zoom in so there is room to zoom back out.
    await pinch(client, center, 60, 460);
    await page.waitForTimeout(150);
    const zoomedIn = await readViewportTransform(page);

    await pinch(client, center, 460, 60);
    await page.waitForTimeout(150);
    const zoomedOut = await readViewportTransform(page);

    expect(scaleOf(zoomedOut)).toBeLessThan(scaleOf(zoomedIn));
  });

  test('one-finger drag on empty canvas pans the viewport', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    const before = await readViewportTransform(page);
    await oneFingerDrag(client, center, 200, 120);
    await page.waitForTimeout(150);
    const after = await readViewportTransform(page);

    // Pan changes translate but not zoom.
    expect(scaleOf(after)).toBeCloseTo(scaleOf(before), 5);
    const b = translateOf(before);
    const a = translateOf(after);
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(50);
  });
});
