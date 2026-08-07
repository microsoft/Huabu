// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 * These tests pin the touch gesture contract documented in
 * docs/architecture/canvas-input-interactions.md. They run in a `hasTouch` context
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

  test('in Pen mode, one-finger drag pans while Sketch is active', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    await page.evaluate(() => {
      const key = 'huabu-sketch-tools';
      const persisted = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        state?: Record<string, unknown>;
        version?: number;
      };
      localStorage.setItem(
        key,
        JSON.stringify({
          ...persisted,
          state: { ...persisted.state, inputModePreference: 'pen' },
        }),
      );
    });
    await page.reload();
    await page.waitForSelector('.react-flow__pane');

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

  test('a second finger takes over a pending lasso as a pinch', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    // Arm the lasso tool.
    await page.keyboard.press('l');
    await expect(page.locator('.cursor-crosshair')).toBeVisible();

    const before = await readViewportTransform(page);

    // Finger one lands and barely moves, so the lasso stays pending (below
    // the activation distance) and is therefore still cancellable.
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: center.x - 100, y: center.y }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: center.x - 98, y: center.y }],
    });

    // Finger two lands: the pending lasso yields and the gesture becomes a
    // two-finger pinch that zooms the viewport.
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: center.x - 98, y: center.y },
        { x: center.x + 60, y: center.y },
      ],
    });
    for (let i = 1; i <= 6; i++) {
      const d = 60 + i * 30;
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: center.x - 60 - i * 10, y: center.y },
          { x: center.x + d, y: center.y },
        ],
      });
    }
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await page.waitForTimeout(150);

    const after = await readViewportTransform(page);
    // The takeover produced a pinch: zoom changed and nothing was selected.
    expect(scaleOf(after)).toBeGreaterThan(scaleOf(before));
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  });
});
