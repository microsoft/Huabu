import { test, expect, type Page } from '@playwright/test';

import {
  oneFingerDrag,
  oneFingerPath,
  openNewCanvas,
  paneCenter,
  touchTap,
} from './helpers';

/**
 * Baseline behavior guardrail for the canvas touch tools that the pointer
 * router refactor (docs/proposals/canvas-pointer-router.md) will migrate
 * into recognizers: click-to-place, frame drag-to-create, and lasso.
 *
 * Pinning current behavior here lets the bubble-phase → capture-phase
 * migration in router steps 3–4 be verified as behavior-preserving.
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
  test('tapping with the Text tool places a node', async ({ page }) => {
    await openNewCanvas(page);
    const client = await page.context().newCDPSession(page);

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await pickCreateTool(page, /^Text/, 'canvas-pending-text');
    await touchTap(client, await paneCenter(page));

    await expect(page.locator('.react-flow__node')).toHaveCount(1);
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

    // Exit the node editor and clear the selection, then arm the lasso tool
    // via its keyboard shortcut (works regardless of the resolved device
    // toolbar layout). Escape first so the 'l' key cannot type into a still
    // focused editor.
    await page.keyboard.press('Escape');
    await page.mouse.click(center.x + 300, center.y + 200);
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
  });
});
