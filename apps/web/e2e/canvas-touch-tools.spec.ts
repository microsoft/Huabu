// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { test, expect, type Page } from '@playwright/test';

import {
  oneFingerDrag,
  oneFingerPath,
  openNewCanvas,
  paneCenter,
  touchTap,
} from './helpers';

/**
 * Behavior guardrail for the routed canvas touch tools documented in
 * docs/architecture/canvas-input-interactions.md: click-to-place, frame
 * drag-to-create, and lasso.
 */

/**
 * Click a creation tool and wait until the canvas reflects the pending
 * state, so a following touch is not raced against the React state update
 * that arms placement.
 */
async function pickCreateTool(
  page: Page,
  name: RegExp,
  pendingClass: string,
): Promise<void> {
  await page.getByRole('button', { name }).click();
  await expect(page.locator(`.${pendingClass}`).first()).toBeVisible();
}

test.describe('canvas touch tools', () => {
  test('new touch canvas starts with Sketch active', async ({ page }) => {
    await openNewCanvas(page);

    await expect(page.getByRole('button', { name: /^Pen$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.cursor-crosshair')).toBeVisible();
  });

  test('tapping with the Text tool places a node', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await pickCreateTool(page, /^Text/, 'canvas-pending-text');
    await touchTap(client, await paneCenter(page));

    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });

  test('dragging past the threshold with the Text tool places nothing', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await pickCreateTool(page, /^Text/, 'canvas-pending-text');
    // A drag well beyond the tap activation distance is not a placement tap.
    await oneFingerDrag(client, center, 160, 120);
    await page.waitForTimeout(150);

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });

  test('dragging with the Frame tool creates a frame node', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await pickCreateTool(page, /^Frame/, 'canvas-pending-frame');
    await oneFingerDrag(
      client,
      { x: center.x - 120, y: center.y - 90 },
      240,
      180,
    );

    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });

  test('lasso selects a placed node on touch', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    // Place a text node.
    await pickCreateTool(page, /^Text/, 'canvas-pending-text');
    await touchTap(client, center);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    // Type content so the node is not discarded as an empty text node when it
    // loses focus, then exit the editor and clear the selection.
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');
    await page.mouse.click(center.x + 300, center.y + 200);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await page.keyboard.press('l');
    await expect(page.locator('.cursor-crosshair')).toBeVisible();

    // Sweep a polygon fully enclosing the node.
    const box = await page.locator('.react-flow__node').first().boundingBox();
    if (!box) throw new Error('placed node has no bounding box');
    const pad = 50;
    await oneFingerPath(client, [
      { x: box.x - pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y + box.height + pad },
      { x: box.x - pad, y: box.y + box.height + pad },
      { x: box.x - pad, y: box.y - pad },
    ]);

    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    const retainedLasso = page.locator('[data-stroke-selection-region]');
    await expect(retainedLasso).toBeVisible();
    expect(
      await retainedLasso.evaluate((element) => ({
        parentIsReactFlow:
          element.parentElement?.classList.contains('react-flow'),
        zIndex: getComputedStyle(element).zIndex,
      })),
    ).toEqual({ parentIsReactFlow: true, zIndex: '999' });
    const floatingToolbar = page
      .locator('body > [data-floating-chrome]:visible')
      .first();
    await expect(floatingToolbar).toBeVisible();
    await expect(floatingToolbar).toHaveCSS('z-index', '1000');

    await touchTap(client, { x: center.x + 300, y: center.y + 200 });

    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await expect(page.locator('[data-stroke-selection-region]')).toHaveCount(0);
  });

  test('lasso keeps selected nodes draggable', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    await page.getByRole('button', { name: /^Text/ }).click();
    await touchTap(client, center);
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');
    await page.mouse.click(center.x + 300, center.y + 200);
    await page.keyboard.press('l');
    const node = page.locator('.react-flow__node').first();
    const before = await node.boundingBox();
    if (!before) throw new Error('placed node has no bounding box');

    const pad = 50;
    await oneFingerPath(client, [
      { x: before.x - pad, y: before.y - pad },
      { x: before.x + before.width + pad, y: before.y - pad },
      { x: before.x + before.width + pad, y: before.y + before.height + pad },
      { x: before.x - pad, y: before.y + before.height + pad },
      { x: before.x - pad, y: before.y - pad },
    ]);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    await oneFingerDrag(
      client,
      { x: before.x + before.width / 2, y: before.y + before.height / 2 },
      120,
      80,
    );

    const after = await node.boundingBox();
    if (!after) throw new Error('moved node has no bounding box');
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(50);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.cursor-crosshair')).toBeVisible();
  });

  test('finger tap on overlapping Ink does not select the Sketch', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);
    const center = await paneCenter(page);

    await pickCreateTool(page, /^Text/, 'canvas-pending-text');
    await touchTap(client, center);
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');
    await touchTap(client, { x: center.x + 300, y: center.y + 200 });
    const text = page.locator('.react-flow__node-text');
    const textBox = await text.boundingBox();
    if (!textBox) throw new Error('Text node has no bounding box');
    const overlapPoint = {
      x: textBox.x + textBox.width / 2,
      y: textBox.y + textBox.height / 2,
    };

    const pen = page.getByRole('button', { name: /^Pen$/ });
    const penBox = await pen.boundingBox();
    if (!penBox) throw new Error('Pen button has no bounding box');
    await touchTap(client, {
      x: penBox.x + penBox.width / 2,
      y: penBox.y + penBox.height / 2,
    });
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    await oneFingerPath(client, [
      { x: overlapPoint.x - 30, y: overlapPoint.y },
      overlapPoint,
      { x: overlapPoint.x + 30, y: overlapPoint.y },
    ]);
    await expect(page.locator('.react-flow__node-sketch')).toHaveCount(1);
    const inkPathBox = await page
      .locator('.react-flow__node-sketch path')
      .first()
      .boundingBox();
    if (!inkPathBox) throw new Error('Ink path has no bounding box');
    const inkPoint = {
      x: inkPathBox.x + inkPathBox.width / 2,
      y: inkPathBox.y + inkPathBox.height / 2,
    };
    expect(inkPoint.x).toBeGreaterThanOrEqual(textBox.x);
    expect(inkPoint.x).toBeLessThanOrEqual(textBox.x + textBox.width);
    expect(inkPoint.y).toBeGreaterThanOrEqual(textBox.y);
    expect(inkPoint.y).toBeLessThanOrEqual(textBox.y + textBox.height);

    const select = page.getByRole('button', { name: /^Select/ });
    const selectBox = await select.boundingBox();
    if (!selectBox) throw new Error('Select button has no bounding box');
    await touchTap(client, {
      x: selectBox.x + selectBox.width / 2,
      y: selectBox.y + selectBox.height / 2,
    });
    await expect(page.locator('.canvas-pending-sketch')).toHaveCount(0);
    await expect(select).toBeVisible();
    await touchTap(client, inkPoint);

    await expect(page.locator('.react-flow__node-sketch.selected')).toHaveCount(
      0,
    );
  });
});
