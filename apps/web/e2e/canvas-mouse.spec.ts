// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { test, expect, type Page } from '@playwright/test';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  scaleOf,
  translateOf,
} from './helpers';

import type * as PanelModule from '../src/store/panelStore';
import type * as PreviewModule from '../src/store/previewWorkspace/store';

/**
 * Mouse-mode canvas behavior — the half of the touch/pen interaction work
 * that *can* be driven by automation (real-device tests cover finger/pen).
 *
 * The suite forces the effective input mode to Mouse via the persisted
 * `inputModePreference`, then exercises the mouse paths that the recent
 * touch-first changes must not regress: the Select/Pan/Lasso toolbar,
 * click-to-place returning to Select, click/drag selection + node move,
 * box-select, wheel zoom, pan-tool drag, and — critically — that node
 * text stays selectable for the mouse (the `user-select:none` suppression
 * is scoped to `[data-not-mouse]`).
 */

/** Force effective Mouse mode regardless of the emulated touch capability. */
async function useMouseMode(page: Page): Promise<void> {
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
        state: { ...persisted.state, inputModePreference: 'mouse' },
      }),
    );
  });
  await page.reload();
  await page.waitForSelector('.react-flow__pane');
  await page.waitForSelector('.react-flow__viewport');
}

/** Place a Text node at `at`, give it content so it survives blur, then blur. */
async function placeTextNode(
  page: Page,
  at: { x: number; y: number },
  content = 'hello',
): Promise<void> {
  // Scope to the canvas toolbar, including its portalled overlay host.
  const toolbar = page.locator(
    '[data-canvas-main-toolbar], .react-flow__panel.bottom.center',
  );
  await toolbar.getByRole('button', { name: /^Text/ }).click();
  await expect(page.locator('.canvas-pending-text').first()).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await page.keyboard.type(content);
  await page.keyboard.press('Escape');
}

async function pasteNote(page: Page, markdown: string): Promise<void> {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, markdown);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
}

async function boxSelectAllNodes(page: Page): Promise<void> {
  const bounds = await page
    .locator('.react-flow__node')
    .evaluateAll((nodes) => {
      const rects = nodes.map((node) => node.getBoundingClientRect());
      if (rects.length === 0) throw new Error('no nodes to box-select');
      return {
        left: Math.min(...rects.map((rect) => rect.left)) - 50,
        top: Math.min(...rects.map((rect) => rect.top)) - 50,
        right: Math.max(...rects.map((rect) => rect.right)) + 50,
        bottom: Math.max(...rects.map((rect) => rect.bottom)) + 50,
      };
    });
  await page.mouse.move(bounds.left, bounds.top);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.bottom, { steps: 12 });
  await page.mouse.up();
}

test.describe('canvas mouse mode', () => {
  test.beforeEach(async ({ page }) => {
    await openNewCanvas(page);
    await useMouseMode(page);
  });

  test('Lasso tool is available (l shows the lasso cursor)', async ({
    page,
  }) => {
    await page.keyboard.press('l');
    await expect(page.locator('.cursor-crosshair')).toBeVisible();
    // Back to Select clears it.
    await page.keyboard.press('s');
    await expect(page.locator('.cursor-crosshair')).toHaveCount(0);
  });

  test('Pan tool left-drag pans the viewport', async ({ page }) => {
    await page.keyboard.press('p');
    await page.waitForTimeout(150);
    const before = translateOf(await readViewportTransform(page));
    const c = await paneCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 220, c.y + 150, { steps: 12 });
    await page.mouse.up();
    const after = translateOf(await readViewportTransform(page));
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(30);
  });

  test('click-to-place a Text node then returns to Select', async ({
    page,
  }) => {
    const c = await paneCenter(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await placeTextNode(page, c);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    // Back to Select: a plain click on empty canvas must NOT place a 2nd node.
    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });

  test('click selects a node and clicking empty clears it', async ({
    page,
  }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    const node = page.locator('.react-flow__node').first();
    const box = await node.boundingBox();
    if (!box) throw new Error('node has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    await page.mouse.click(c.x + 260, c.y + 160);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  });

  test('dragging a node moves it', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    // Blur the just-created editor + clear selection so the next press
    // starts a node drag rather than re-entering the text editor.
    await page.mouse.click(c.x + 260, c.y + 160);
    const node = page.locator('.react-flow__node').first();
    const before = await node.boundingBox();
    if (!before) throw new Error('node has no bounding box');

    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      before.x + before.width / 2 + 140,
      before.y + before.height / 2 + 90,
      { steps: 10 },
    );
    await expect(page.locator('[data-node-selection-outline]')).toBeVisible();
    await expect(
      page.locator('.react-flow__resize-control.handle'),
    ).toHaveCount(0);
    await page.mouse.up();
    await expect(
      page.locator('.react-flow__resize-control.handle'),
    ).toHaveCount(4);

    const after = await node.boundingBox();
    if (!after) throw new Error('moved node has no bounding box');
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(60);
  });

  test('Sketch hover works after reload and selecting another node without a pane click', async ({
    page,
  }) => {
    const center = await paneCenter(page);
    await placeTextNode(page, { x: center.x - 250, y: center.y - 180 });
    const toolbar = page.locator('.react-flow__panel.bottom.center');
    await toolbar.getByRole('button', { name: /^Sketch/ }).click();
    await page.mouse.move(center.x - 45, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 45, center.y, { steps: 12 });
    await page.mouse.up();
    const sketch = page.locator('.react-flow__node-sketch').first();
    await expect(sketch).toBeVisible();
    await page.keyboard.press('s');
    await page.reload();
    await expect(sketch).toBeVisible();
    await expect(sketch).not.toHaveClass(/\bselected\b/);
    const bounds = await sketch.boundingBox();
    if (!bounds) throw new Error('Sketch has no bounds');
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.mouse.move(point.x, point.y);
    await expect(sketch).toHaveAttribute('data-sketch-hover', 'true');
    const text = page.locator('.react-flow__node-text').first();
    await text.click();
    await expect(text).toHaveClass(/\bselected\b/);
    await page.mouse.move(point.x, point.y);
    await expect(sketch).toHaveAttribute('data-sketch-hover', 'true');
    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        nodeId: target?.closest('.react-flow__node')?.getAttribute('data-id'),
        cursor: target ? getComputedStyle(target).cursor : null,
      };
    }, point);
    expect(hit.nodeId).toBe(await sketch.getAttribute('data-id'));
    expect(['grab', 'pointer']).toContain(hit.cursor);
    await page.mouse.click(point.x, point.y);
    await expect(sketch).toHaveClass(/\bselected\b/);
  });

  test('selected Sketch restores mouse dragging after a touch interaction', async ({
    page,
  }) => {
    const center = await paneCenter(page);
    const toolbar = page.locator('.react-flow__panel.bottom.center');
    await toolbar.getByRole('button', { name: /^Sketch/ }).click();
    await page.mouse.move(center.x - 45, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 45, center.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__node-sketch')).toHaveCount(1);

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
          state: { ...persisted.state, inputModePreference: 'finger' },
        }),
      );
    });
    await page.reload();
    await page.waitForSelector('.react-flow__pane');

    const sketch = page.locator('.react-flow__node-sketch').first();
    const sketchBox = await sketch.boundingBox();
    if (!sketchBox) throw new Error('sketch has no bounding box');
    await page.keyboard.press('s');
    await page.mouse.move(
      sketchBox.x + sketchBox.width / 2,
      sketchBox.y + sketchBox.height / 2,
    );
    await expect(sketch).toHaveAttribute('data-sketch-hover', 'true');
    await page.mouse.click(
      sketchBox.x + sketchBox.width / 2,
      sketchBox.y + sketchBox.height / 2,
    );
    await expect(sketch).toHaveClass(/\bselected\b/);
    await expect(sketch).toHaveClass(/\bdraggable\b/);

    const pointerTarget = toolbar.getByRole('button', { name: /^Select/ });
    await pointerTarget.dispatchEvent('pointerdown', {
      bubbles: true,
      pointerId: 41,
      pointerType: 'touch',
    });
    await expect(sketch).not.toHaveClass(/\bdraggable\b/);

    await pointerTarget.dispatchEvent('pointerdown', {
      bubbles: true,
      pointerId: 42,
      pointerType: 'mouse',
    });
    await expect(sketch).toHaveClass(/\bdraggable\b/);
  });

  test('empty drag box-selects a node in Select tool', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    await page.keyboard.press('s'); // ensure Select tool
    // Reliably clear the post-creation selection before marquee-selecting.
    await page.mouse.click(c.x + 320, c.y + 220);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    const box = await page.locator('.react-flow__node').first().boundingBox();
    if (!box) throw new Error('node has no bounding box');
    const pad = 60;
    await page.mouse.move(box.x - pad, box.y - pad);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + pad, box.y + box.height + pad, {
      steps: 12,
    });
    await expect(page.locator('.react-flow__selection')).toBeVisible();
    await expect(page.locator('[data-node-selection-outline]')).toHaveCount(1);
    await expect(
      page.locator('.react-flow__resize-control.handle'),
    ).toHaveCount(0);
    await expect(page.locator('[data-floating-chrome]')).toHaveCount(0);
    await expect(
      page.locator('.react-flow__handle .pointer-events-auto'),
    ).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('[data-node-selection-outline]')).toBeVisible();
    await expect(
      page.locator('.react-flow__resize-control.handle'),
    ).toHaveCount(4);
    await expect(page.locator('[data-floating-chrome]').first()).toBeVisible();
    await expect(
      page.locator('.react-flow__handle.source [role="button"]'),
    ).toHaveCount(4);
  });

  for (const modifier of ['Control', 'Meta']) {
    test(`${modifier} hides individual corners but keeps group corners`, async ({
      page,
    }) => {
      const c = await paneCenter(page);
      await placeTextNode(page, { x: c.x - 130, y: c.y }, 'a');
      await placeTextNode(page, { x: c.x + 140, y: c.y }, 'b');
      await page.mouse.click(c.x + 340, c.y + 240);
      await page.keyboard.press('s');
      const nodes = page.locator('.react-flow__node');
      await nodes.nth(0).click({ position: { x: 3, y: 3 } });
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

      await page.keyboard.down(modifier);
      await expect(page.locator('[data-node-selection-outline]')).toHaveCount(
        1,
      );
      await expect(
        page.locator('.react-flow__resize-control.handle'),
      ).toHaveCount(0);
      await expect(page.locator('[data-floating-chrome]')).toHaveCount(0);
      await expect(
        page.locator('.react-flow__handle .pointer-events-auto'),
      ).toHaveCount(0);

      await page.keyboard.up(modifier);
      await expect(
        page.locator('.react-flow__resize-control.handle'),
      ).toHaveCount(4);

      await page.mouse.click(c.x + 340, c.y + 240);
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
      await boxSelectAllNodes(page);
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
      await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);

      await page.keyboard.down(modifier);
      await expect(page.locator('[data-node-selection-outline]')).toHaveCount(
        2,
      );
      await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);
      await expect(page.locator('[data-multi-selection]')).toBeVisible();
      await expect(
        page.locator('.react-flow__resize-control.handle'),
      ).toHaveCount(0);
      await page.keyboard.up(modifier);
      await expect(page.locator('[data-node-selection-outline]')).toHaveCount(
        2,
      );
      await expect(page.locator('[data-multi-selection]')).toBeVisible();
      await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);
    });
  }

  for (const count of [1, 2]) {
    for (const modifier of ['Control', 'Meta']) {
      test(`${count}-node resize finishes when ${modifier} is pressed mid-gesture`, async ({
        page,
      }) => {
        const c = await paneCenter(page);
        await placeTextNode(page, { x: c.x - 130, y: c.y }, 'a');
        if (count === 2) {
          await placeTextNode(page, { x: c.x + 140, y: c.y }, 'b');
        }
        await page.mouse.click(c.x + 340, c.y + 240);
        await page.keyboard.press('s');
        await boxSelectAllNodes(page);
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(
          count,
        );
        const nodes = page.locator('.react-flow__node');
        await expect(nodes).toHaveCount(count);
        const readWidths = () =>
          nodes.evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().width),
          );
        const before = await readWidths();
        const handles = page.locator(
          count === 1
            ? '.react-flow__resize-control.handle'
            : '[data-multi-resize-control]',
        );
        await expect(handles).toHaveCount(4);
        const corner = await handles.last().boundingBox();
        if (!corner) throw new Error('resize corner has no bounding box');
        const start = {
          x: corner.x + corner.width / 2,
          y: corner.y + corner.height / 2,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 40, start.y + 20, { steps: 6 });
        for (let index = 0; index < count; index++) {
          await expect
            .poll(async () => (await readWidths())[index])
            .toBeGreaterThan(before[index] + 1);
        }
        const beforeModifier = await readWidths();
        await page.keyboard.down(modifier);
        await expect(handles).toHaveCount(4);
        await page.mouse.move(start.x + 100, start.y + 40, { steps: 6 });
        for (let index = 0; index < count; index++) {
          await expect
            .poll(async () => (await readWidths())[index])
            .toBeGreaterThan(beforeModifier[index] + 5);
        }
        const duringModifier = await readWidths();
        await page.mouse.up();
        await expect(handles).toHaveCount(count === 1 ? 0 : 4);
        await page.keyboard.up(modifier);
        await expect(handles).toHaveCount(4);
        for (let index = 0; index < count; index++) {
          await expect
            .poll(async () =>
              Math.abs((await readWidths())[index] - duringModifier[index]),
            )
            .toBeLessThan(1);
        }

        await page.keyboard.press('ControlOrMeta+z');
        for (let index = 0; index < count; index++) {
          await expect
            .poll(async () =>
              Math.abs((await readWidths())[index] - before[index]),
            )
            .toBeLessThan(1);
        }
      });
    }
  }

  test('ctrl + wheel over the pane zooms the viewport', async ({ page }) => {
    const c = await paneCenter(page);
    const before = scaleOf(await readViewportTransform(page));
    await page.mouse.move(c.x, c.y);
    // Plain wheel pans in mouse mode (panOnScroll); Ctrl+wheel zooms.
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const after = scaleOf(await readViewportTransform(page));
    expect(after).toBeGreaterThan(before);
  });

  test('node text stays selectable for the mouse', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c, 'selectable text');
    // Mouse mode must NOT set the touch-only user-select suppression.
    await expect(page.locator('[data-canvas-root]')).not.toHaveAttribute(
      'data-not-mouse',
      /.*/,
    );
  });

  test('box-select two nodes then dragging one moves the whole group', async ({
    page,
  }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, { x: c.x - 130, y: c.y }, 'a');
    await placeTextNode(page, { x: c.x + 140, y: c.y }, 'b');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    await page.keyboard.press('s');
    await page.mouse.click(c.x + 340, c.y + 240); // clear selection
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    // Marquee enclosing both nodes.
    const nodes = page.locator('.react-flow__node');
    const a0 = await nodes.nth(0).boundingBox();
    const b0 = await nodes.nth(1).boundingBox();
    if (!a0 || !b0) throw new Error('nodes have no bounding box');
    const left = Math.min(a0.x, b0.x) - 50;
    const top = Math.min(a0.y, b0.y) - 50;
    const right = Math.max(a0.x + a0.width, b0.x + b0.width) + 50;
    const bottom = Math.max(a0.y + a0.height, b0.y + b0.height) + 50;
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 14 });
    await expect(page.locator('.react-flow__selection')).toBeVisible();
    await expect(page.locator('[data-node-selection-outline]')).toHaveCount(2);
    await expect(page.locator('[data-multi-selection]')).toBeVisible();
    await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);
    await expect(
      page.locator('.react-flow__resize-control.handle'),
    ).toHaveCount(0);
    await expect(page.locator('[data-floating-chrome]')).toHaveCount(0);
    await expect(
      page.locator('.react-flow__handle .pointer-events-auto'),
    ).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

    // Drag one selected member: the whole selection moves.
    await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
    await page.mouse.down();
    await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2 + 130, {
      steps: 12,
    });
    await expect(page.locator('[data-node-selection-outline]')).toHaveCount(2);
    await expect(page.locator('[data-multi-selection]')).toBeVisible();
    await expect(page.locator('[data-multi-resize-control]')).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);

    const a1 = await nodes.nth(0).boundingBox();
    const b1 = await nodes.nth(1).boundingBox();
    if (!a1 || !b1) throw new Error('moved nodes have no bounding box');
    expect(a1.y - a0.y).toBeGreaterThan(60);
    expect(b1.y - b0.y).toBeGreaterThan(60);
  });

  test('lasso selects an enclosed node with the mouse', async ({ page }) => {
    const c = await paneCenter(page);
    await placeTextNode(page, c);
    await page.mouse.click(c.x + 340, c.y + 240); // blur + clear selection
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

    await page.keyboard.press('l');
    await expect(page.locator('.cursor-crosshair')).toBeVisible();

    const box = await page.locator('.react-flow__node').first().boundingBox();
    if (!box) throw new Error('node has no bounding box');
    const pad = 55;
    const path = [
      { x: box.x - pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y + box.height + pad },
      { x: box.x - pad, y: box.y + box.height + pad },
      { x: box.x - pad, y: box.y - pad },
    ];
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (let i = 1; i < path.length; i++) {
      await page.mouse.move(path[i].x, path[i].y, { steps: 6 });
    }
    await page.mouse.up();

    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  });

  test('Lasso preserves Audio pointer seeking and keyboard focus with or without a retained region', async ({
    page,
  }) => {
    const sampleRate = 8000;
    const dataSize = sampleRate * 20 * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'audio',
                  position: { x: 400, y: 300 },
                  size: { width: 360, height: 100 },
                  data: {
                    label: 'Lasso seek regression',
                    src: `data:audio/wav;base64,${wav.toString('base64')}`,
                  },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-lasso-audio-seek' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const node = page.locator('.react-flow__node-audio');
    const slider = node.getByRole('slider');
    await expect(slider).toHaveAttribute('aria-valuemax', '20');
    await page.keyboard.press('l');
    await expect(page.locator('.canvas-lasso')).toBeVisible();
    const region = page.locator('[data-stroke-selection-region]');
    for (const retained of [false, true]) {
      if (retained) {
        const bounds = await node.boundingBox();
        if (!bounds) throw new Error('Audio node has no bounds');
        const path = [
          { x: bounds.x - 30, y: bounds.y - 30 },
          { x: bounds.x + bounds.width + 30, y: bounds.y - 30 },
          {
            x: bounds.x + bounds.width + 30,
            y: bounds.y + bounds.height + 30,
          },
          { x: bounds.x - 30, y: bounds.y + bounds.height + 30 },
          { x: bounds.x - 30, y: bounds.y - 30 },
        ];
        await page.mouse.move(path[0].x, path[0].y);
        await page.mouse.down();
        for (const point of path.slice(1)) {
          await page.mouse.move(point.x, point.y, { steps: 6 });
        }
        await page.mouse.up();
        await expect(region).toBeVisible();
      }
      const regionBefore = retained
        ? await region.evaluate((element) => element.outerHTML)
        : null;
      const bounds = await slider.boundingBox();
      const bar = await slider.locator('span').nth(10).boundingBox();
      if (!bounds || !bar) throw new Error('Audio seek bar has no bounds');
      const x = bar.x + bar.width / 2;
      const expectedTime = ((x - bounds.x) / bounds.width) * 20;
      await page.mouse.click(x, bar.y + bar.height / 2);
      await expect(slider).toBeFocused();
      const currentTime = () =>
        node.locator('audio').evaluate((audio) => audio.currentTime);
      await expect.poll(currentTime).toBeCloseTo(expectedTime, 1);
      await page.keyboard.press('ArrowRight');
      await expect.poll(currentTime).toBeCloseTo(expectedTime + 5, 1);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(currentTime).toBeCloseTo(expectedTime, 1);
      await expect(page.locator('.canvas-lasso')).toBeVisible();
      if (retained) {
        await expect(region).toBeVisible();
        expect(await region.evaluate((element) => element.outerHTML)).toBe(
          regionBefore,
        );
        await expect(node).toHaveClass(/\bselected\b/);
      } else {
        await expect(region).toHaveCount(0);
      }
    }
  });

  for (const type of ['note', 'sketch'] as const) {
    test(`Lasso starts inside a selected ${type} and retains a densely sampled loop`, async ({
      page,
    }) => {
      const center = await paneCenter(page);
      if (type === 'note') {
        await page.mouse.move(center.x - 160, center.y - 40);
        await pasteNote(page, 'A Note surface can start a Lasso.');
        await page.keyboard.press('s');
      } else {
        const toolbar = page.locator(
          '[data-canvas-main-toolbar], .react-flow__panel.bottom.center',
        );
        await toolbar.getByRole('button', { name: /^Sketch/ }).click();
        await page.mouse.move(center.x - 120, center.y - 60);
        await page.mouse.down();
        await page.mouse.move(center.x - 120, center.y + 60, { steps: 12 });
        await page.mouse.move(center.x + 120, center.y + 60, { steps: 24 });
        await page.mouse.move(center.x + 120, center.y - 60, { steps: 12 });
        await page.mouse.up();
        await page.keyboard.press('s');
        await page.mouse.move(center.x, center.y + 60);
        await expect(page.locator('.react-flow__node-sketch')).toHaveAttribute(
          'data-sketch-hover',
          'true',
        );
        await page.mouse.click(center.x, center.y + 60);
      }
      const node = page.locator(`.react-flow__node-${type}`);
      await expect(node).toBeVisible();
      await expect(node).toHaveClass(/\bselected\b/);
      await page.keyboard.press('l');
      const before = await node.boundingBox();
      if (!before) throw new Error('Lasso source node has no bounds');
      const start = {
        x: before.x + before.width / 2,
        y: before.y + before.height / 2,
      };
      await expect(node).toHaveCSS('cursor', 'crosshair');
      expect(
        await page.evaluate(
          ({ x, y, type }) =>
            Boolean(
              document
                .elementFromPoint(x, y)
                ?.closest(`.react-flow__node-${type}`),
            ),
          { ...start, type },
        ),
      ).toBe(true);
      const path = [
        start,
        { x: before.x + before.width + 20, y: start.y },
        {
          x: before.x + before.width + 20,
          y: before.y + before.height + 30,
        },
        { x: before.x - 20, y: before.y + before.height + 30 },
        { x: before.x - 20, y: start.y },
        start,
      ];
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let index = 1; index < path.length; index++) {
        const previous = path[index - 1];
        const next = path[index];
        await page.mouse.move(next.x, next.y, {
          steps: Math.ceil(
            Math.hypot(next.x - previous.x, next.y - previous.y) / 2,
          ),
        });
      }
      await page.mouse.up();
      const region = page.locator('[data-stroke-selection-region]');
      await expect(region).toBeVisible();
      if (type === 'sketch') {
        await expect(
          page.locator('[data-sketch-stroke-emphasis="selected"]'),
        ).toBeVisible();
        await expect(node).not.toHaveClass(/\bselected\b/);
      } else {
        await expect(node).toHaveClass(/\bselected\b/);
      }
      const after = await node.boundingBox();
      if (!after) throw new Error('Lasso source node lost its bounds');
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);

      const regionBefore = await region.boundingBox();
      if (!regionBefore) throw new Error('Retained Lasso has no bounds');
      await page.mouse.move(start.x, start.y + 15);
      await page.mouse.down();
      await page.mouse.move(start.x + 40, start.y + 45, { steps: 10 });
      await page.mouse.up();
      await expect(region).toBeVisible();
      const regionAfter = await region.boundingBox();
      if (!regionAfter) throw new Error('Moved Lasso has no bounds');
      expect(regionAfter.x - regionBefore.x).toBeCloseTo(40, 0);
      expect(regionAfter.y - regionBefore.y).toBeCloseTo(30, 0);
    });
  }

  test('lassoed Ink creates one Question and clears after acceptance', async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const path = '/src/store/panelStore.ts';
      const { usePanelStore } = (await import(path)) as typeof PanelModule;
      usePanelStore.getState().setRightCollapsed(true);
    });
    await expect(page.locator('[data-canvas-panel="right"]')).toBeHidden();
    const center = await paneCenter(page);
    const toolbar = page.locator('[data-canvas-main-toolbar]');
    await toolbar.getByRole('button', { name: /^Sketch/ }).click();

    await page.mouse.move(center.x - 45, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 45, center.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__node-sketch')).toHaveCount(1);

    await page.keyboard.press('l');
    const sketch = await page.locator('.react-flow__node-sketch').boundingBox();
    if (!sketch) throw new Error('sketch has no bounding box');
    const padding = 45;
    const path = [
      { x: sketch.x - padding, y: sketch.y - padding },
      { x: sketch.x + sketch.width + padding, y: sketch.y - padding },
      {
        x: sketch.x + sketch.width + padding,
        y: sketch.y + sketch.height + padding,
      },
      { x: sketch.x - padding, y: sketch.y + sketch.height + padding },
      { x: sketch.x - padding, y: sketch.y - padding },
    ];
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (let index = 1; index < path.length; index += 1) {
      await page.mouse.move(path[index].x, path[index].y, { steps: 6 });
    }
    await page.mouse.up();

    const selectedInk = page.locator(
      '[data-sketch-stroke-emphasis="selected"]',
    );
    await expect(selectedInk).toBeVisible();
    await expect(selectedInk).toHaveAttribute('stroke', 'var(--color-info)');
    await expect(selectedInk).toHaveAttribute(
      'vector-effect',
      'non-scaling-stroke',
    );

    const send = page.getByRole('button', { name: 'Send ink request' });
    await expect(send).toBeVisible();
    const retainedLasso = await page
      .locator('[data-stroke-selection-region]')
      .boundingBox();
    const inkToolbar = await send
      .locator('xpath=ancestor::*[@data-floating-chrome][1]')
      .boundingBox();
    if (!retainedLasso || !inkToolbar) {
      throw new Error('Ink toolbar or retained Lasso has no bounding box');
    }
    expect(
      Math.abs(
        inkToolbar.x +
          inkToolbar.width / 2 -
          (retainedLasso.x + retainedLasso.width / 2),
      ),
    ).toBeLessThanOrEqual(2);

    await page.mouse.click(retainedLasso.x + 10, retainedLasso.y + 10);
    await expect(selectedInk).toHaveCount(0);
    await expect(page.locator('[data-stroke-selection-region]')).toHaveCount(0);
    await expect(send).toHaveCount(0);

    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (let index = 1; index < path.length; index += 1) {
      await page.mouse.move(path[index].x, path[index].y, { steps: 6 });
    }
    await page.mouse.up();
    await expect(selectedInk).toBeVisible();
    await expect(send).toBeVisible();
    const sendBox = await send.boundingBox();
    if (!sendBox) throw new Error('Ink send button has no bounding box');

    let releaseAgentRequest!: () => void;
    const agentRequestHeld = new Promise<void>((resolve) => {
      releaseAgentRequest = resolve;
    });
    await page.route('**/api/agent', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const request = route.request().postDataJSON() as {
        threadId: string;
        inputKind?: string;
      };
      expect(request.inputKind).toBe('ink-intent');
      await agentRequestHeld;
      const frame = (type: string, data: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          frame('accepted', {
            threadId: request.threadId,
            turnStartSeq: 1,
          }) + frame('end', {}),
      });
    });

    await send.click();

    const pendingSend = page.getByRole('button', {
      name: 'Sending ink request',
    });
    const spinner = pendingSend.locator('[data-loading-spinner]');
    await expect(spinner).toBeVisible();
    const pendingSendBox = await pendingSend.boundingBox();
    if (!pendingSendBox) {
      throw new Error('Pending Ink send button has no bounding box');
    }
    expect(pendingSendBox.width).toBe(sendBox.width);
    expect(pendingSendBox.height).toBe(sendBox.height);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('[data-stroke-selection-region]')).toBeVisible();
    await expect(selectedInk).toBeVisible();
    releaseAgentRequest();

    await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
    await expect(send).toHaveCount(0);
    await expect(page.locator('[data-stroke-selection-region]')).toHaveCount(0);
    await expect(selectedInk).toHaveCount(0);
    await expect(page.locator('[data-canvas-panel="right"]')).toBeVisible();
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    const nodeId = await page
      .locator('.react-flow__node-question')
      .getAttribute('data-id');
    expect(
      await page.evaluate(async () => {
        const path = '/src/store/previewWorkspace/store.ts';
        const { usePreviewWorkspaceStore, selectActiveTab } = (await import(
          path
        )) as typeof PreviewModule;
        return selectActiveTab(usePreviewWorkspaceStore.getState())?.target;
      }),
    ).toMatchObject({ kind: 'node', nodeId });
  });

  test('mixed Ink submits hidden current-LOD Canvas grounding', async ({
    page,
  }) => {
    await pasteNote(page, 'First point\nSecond point\nThird comparison step');
    const noteNode = page.locator('.react-flow__node-note').first();
    const noteBox = await noteNode.boundingBox();
    if (!noteBox) throw new Error('note node has no bounding box');
    const noteNodeId = await noteNode.getAttribute('data-id');
    if (!noteNodeId) throw new Error('note node has no id');

    const toolbar = page.locator('.react-flow__panel.bottom.center');
    await toolbar.getByRole('button', { name: /^Sketch/ }).click();
    const underlineY = noteBox.y + noteBox.height + 24;
    await page.mouse.move(noteBox.x + 18, underlineY);
    await page.mouse.down();
    await page.mouse.move(noteBox.x + noteBox.width - 18, underlineY, {
      steps: 12,
    });
    await page.mouse.up();
    const sketchNode = page.locator('.react-flow__node-sketch').first();

    const canvasCenter = await paneCenter(page);
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    const zoomOut = page.getByRole('button', { name: 'Zoom Out' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const zoom = scaleOf(await readViewportTransform(page));
      if (zoom < 0.25) break;
      await zoomOut.click();
      await expect
        .poll(async () => scaleOf(await readViewportTransform(page)))
        .toBeLessThan(zoom);
    }
    await expect(noteNode.locator('.semantic-lod-node')).toHaveAttribute(
      'data-lod',
      'minimal',
    );
    const submissionZoom = scaleOf(await readViewportTransform(page));
    expect(submissionZoom).toBeLessThan(0.25);

    const zoomedNoteBox = await noteNode.boundingBox();
    const sketchBox = await sketchNode.boundingBox();
    if (!zoomedNoteBox || !sketchBox)
      throw new Error('grounding sources have no bounding box');

    await page.keyboard.press('l');
    const left = Math.min(zoomedNoteBox.x, sketchBox.x) - 45;
    const top = Math.min(zoomedNoteBox.y, sketchBox.y) - 45;
    const right =
      Math.max(
        zoomedNoteBox.x + zoomedNoteBox.width,
        sketchBox.x + sketchBox.width,
      ) + 45;
    const bottom =
      Math.max(
        zoomedNoteBox.y + zoomedNoteBox.height,
        sketchBox.y + sketchBox.height,
      ) + 45;
    const path = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
      { x: left, y: top },
    ];
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (let index = 1; index < path.length; index += 1) {
      await page.mouse.move(path[index].x, path[index].y, { steps: 6 });
    }
    await page.mouse.up();

    await page.route('**/api/agent', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const request = route.request().postDataJSON() as {
        threadId: string;
        canvasId: string;
        groundingVisual?: {
          kind: string;
          dataUrl: string;
          viewport: { zoom: number };
          selectedNodeIds: string[];
        };
      };
      expect(request.groundingVisual).toMatchObject({
        kind: 'visible-canvas',
        selectedNodeIds: [noteNodeId],
      });
      expect(request.groundingVisual?.viewport.zoom).toBeCloseTo(
        submissionZoom,
        5,
      );
      expect(request.groundingVisual?.dataUrl).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(request.groundingVisual?.dataUrl.length).toBeLessThan(750_000);
      const frame = (type: string, data: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          frame('accepted', {
            threadId: request.threadId,
            turnStartSeq: 1,
          }) + frame('end', {}),
      });
    });

    const send = page.getByRole('button', { name: 'Send ink request' });
    await expect(send).toBeVisible();
    await send.click();
    await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
    await expect(send).toHaveCount(0);
  });
});
