// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as StoreModule from '../src/store/canvasStore';
import type { CreateCanvasResponse, GetCanvasResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

async function createSpace(page: Page, title: string) {
  const response = await page.request.post('/api/canvas', { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as CreateCanvasResponse).canvasId;
}

async function readSpace(page: Page, id: string) {
  const response = await page.request.get(`/api/canvas/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as GetCanvasResponse;
}

async function seedNode(
  page: Page,
  canvasId: string,
  nodeType: 'text' | 'spacePreview',
  data: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-shortcut',
              nodeType,
              data,
              position: { x: 80, y: 140 },
              selectOnCreate: false,
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-space-shortcut' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('huabu.language', 'en');
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({
        state: { inputModePreference: 'mouse' },
        version: 0,
      }),
    );
  });
});

async function history(page: Page, action: 'undo' | 'redo') {
  return page.evaluate(async (action) => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof StoreModule;
    const before = store.getState().nodes.map((node) => ({
      width: node.style?.width,
      mode: node.data.widthMode,
    }));
    await store.getState()[action]();
    return {
      before,
      after: store.getState().nodes.map((node) => ({
        width: node.style?.width,
        mode: node.data.widthMode,
      })),
    };
  }, action);
}

test('real shortcuts fit titles, persist width, undo, resize, and navigate without scenes', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const sceneRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/preview-scene'))
      sceneRequests.push(request.url());
  });
  const targetId = await createSpace(page, 'Research');
  const hostId = await createSpace(page, 'Shortcut host');
  await seedNode(page, hostId, 'spacePreview', { targetCanvasId: targetId });
  await page.goto(`/canvas/${hostId}`);
  const node = page.locator('.react-flow__node-spacePreview');
  const body = node.locator('[data-space-shortcut]');
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await page
    .getByRole('button', { name: /Canvas zoom.*Reset to 100%/ })
    .click();
  await expect(body).toContainText('Research');
  await expect(body.locator('[data-space-shortcut-summary]')).toHaveText(
    'No nodes · Updated now',
  );
  await expect(body.locator('[data-space-shortcut-summary]')).toHaveCSS(
    'font-size',
    '16px',
  );
  await expect(node).toHaveCSS('width', '240px');
  expect(await node.evaluate((element) => element.clientHeight)).toBeLessThan(
    102,
  );

  await body.click();
  await page
    .getByRole('button', { name: 'Shortcut width', exact: true })
    .click();
  const form = page.getByRole('form', { name: 'Shortcut width' });
  await expect(form.getByRole('textbox')).toHaveCount(1);
  await form.getByRole('textbox', { name: 'Width', exact: true }).fill('239');
  await form.getByRole('button', { name: 'Apply width' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await form.getByRole('textbox', { name: 'Width', exact: true }).fill('320');
  await form.getByRole('button', { name: 'Apply width' }).click();
  await expect(node).toHaveCSS('width', '320px');
  await page.keyboard.press('Escape');
  const persistedNode = async () => {
    const saved = await readSpace(page, hostId);
    return (saved.state as { nodes: Node[] }).nodes.find(
      (entry) => entry.id === 'node-shortcut',
    );
  };
  await expect
    .poll(async () => (await persistedNode())?.data.widthMode)
    .toBe('fixed');
  expect((await persistedNode())?.style?.height).toBeUndefined();

  const title = `A longer research notebook covering many observations and future product directions (${targetId})`;
  await seedNode(page, targetId, 'text', { content: 'A saved target node' });
  const target = await readSpace(page, targetId);
  const renamed = await page.request.put(`/api/canvas/${targetId}`, {
    data: { version: target.version, state: target.state, title },
  });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(body).toContainText(title);
  await expect(body.locator('[data-space-shortcut-summary]')).toContainText(
    '1 node',
  );
  await expect(node).toHaveCSS('width', '320px');
  expect(
    await node.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(138);
  expect(
    await node.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(126);
  const undone = await history(page, 'undo');
  expect(undone).toMatchObject({
    before: [{ mode: 'fixed' }],
    after: [{ mode: 'auto' }],
  });
  await expect(node).toHaveCSS('width', '480px');
  await history(page, 'redo');
  await expect(node).toHaveCSS('width', '320px');

  await body.click();
  await page
    .getByRole('button', { name: 'Shortcut width', exact: true })
    .click();
  await form.getByRole('button', { name: 'Automatic', exact: true }).click();
  await expect(node).toHaveCSS('width', '480px');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await persistedNode())?.data.widthMode)
    .toBe('auto');
  await page.reload();
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await page
    .getByRole('button', { name: /Canvas zoom.*Reset to 100%/ })
    .click();
  await expect(node).toHaveCSS('width', '480px');

  await body.click();
  await expect(node.locator('.node-resize-edge')).toHaveCount(2);
  await expect(node.locator('.node-resize-corner')).toHaveCount(0);
  const edge = node.locator('.node-resize-edge.right');
  const bounds = await edge.boundingBox();
  if (!bounds) throw new Error('Missing shortcut resize edge');
  const before = await node.boundingBox();
  if (!before) throw new Error('Missing shortcut bounds');
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 4,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 60,
    bounds.y + bounds.height / 4,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await persistedNode())?.data.widthMode)
    .toBe('fixed');
  const after = await node.boundingBox();
  expect(after?.x).toBeCloseTo(before.x, 0);
  expect(after?.width).toBeGreaterThan(before.width);
  await expect(node.locator('.semantic-lod-node')).toHaveCSS(
    'box-shadow',
    'none',
  );
  await expect(body).toHaveCSS('font-size', '28px');
  await expect(node.locator('.semantic-lod-node')).toHaveCSS(
    'border-top-width',
    '3px',
  );
  await history(page, 'undo');
  await expect(node).toHaveCSS('width', '480px');
  await history(page, 'redo');
  await expect
    .poll(async () => (await persistedNode())?.data.widthMode)
    .toBe('fixed');

  const maximumEdge = await edge.boundingBox();
  if (!maximumEdge) throw new Error('Missing right resize edge');
  await page.mouse.move(
    maximumEdge.x + maximumEdge.width / 2,
    maximumEdge.y + maximumEdge.height / 4,
  );
  await page.mouse.down();
  await page.mouse.move(
    maximumEdge.x + maximumEdge.width / 2 + 250,
    maximumEdge.y + maximumEdge.height / 4,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() => node.evaluate((element) => element.clientWidth))
    .toBeGreaterThan(720);
  const maximum = await node.boundingBox();
  const left = await node.locator('.node-resize-edge.left').boundingBox();
  if (!maximum || !left) throw new Error('Missing left resize geometry');
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 4);
  await page.mouse.down();
  await page.mouse.move(
    left.x + left.width / 2 + 600,
    left.y + left.height / 4,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(node).toHaveCSS('width', '240px');
  const minimum = await node.boundingBox();
  expect((minimum?.x ?? 0) + (minimum?.width ?? 0)).toBeCloseTo(
    maximum.x + maximum.width,
    0,
  );
  const screenshot = testInfo.outputPath('space-shortcut.png');
  await node.screenshot({ path: screenshot });
  await testInfo.attach('space-shortcut', {
    path: screenshot,
    contentType: 'image/png',
  });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/canvas/${targetId}`);
  expect(sceneRequests).toEqual([]);
});

test('moving to a new Space leaves an immediately usable shortcut without refreshing', async ({
  page,
}) => {
  const hostId = await createSpace(page, 'Move shortcut source');
  await seedNode(page, hostId, 'text', { content: 'Move this text' });
  await page.goto(`/canvas/${hostId}`);
  await page.locator('.react-flow__node-text').click();
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof StoreModule;
    store.getState().setMoveSelectionDialogOpen(true);
  });
  await page.getByRole('button', { name: 'Select destination Space' }).click();
  await page.getByRole('option', { name: 'Create new Space…' }).click();
  const title = `Moved destination ${hostId}`;
  await page.getByRole('textbox', { name: 'New Space name' }).fill(title);
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`/canvas/${hostId}`);
  const shortcut = page.locator('[data-space-shortcut]');
  await expect(shortcut).toHaveAttribute('data-target-status', 'ready');
  await expect(shortcut).toContainText(title);
  await expect(shortcut.locator('[data-space-shortcut-summary]')).toContainText(
    '1 node',
  );
  const destinationId = await shortcut.getAttribute('data-space-shortcut');
  expect(destinationId).toBeTruthy();
  await shortcut.dblclick();
  await expect(page).toHaveURL(`/canvas/${destinationId}`);
});

test('custom width above 720 survives history and reload, while automatic width still fits content', async ({
  page,
}) => {
  const targetId = await createSpace(page, 'Wide shortcut');
  const hostId = await createSpace(page, 'Wide shortcut host');
  await seedNode(page, hostId, 'spacePreview', { targetCanvasId: targetId });
  await page.goto(`/canvas/${hostId}`);
  const node = page.locator('.react-flow__node-spacePreview');
  const body = node.locator('[data-space-shortcut]');
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  const automaticWidth = await node.evaluate(
    (element) => getComputedStyle(element).width,
  );
  await body.click();
  await page
    .getByRole('button', { name: 'Shortcut width', exact: true })
    .click();
  const form = page.getByRole('form', { name: 'Shortcut width' });
  await form.getByRole('textbox', { name: 'Width', exact: true }).fill('1200');
  await form.getByRole('button', { name: 'Apply width' }).click();
  await expect(node).toHaveCSS('width', '1200px');
  await page.keyboard.press('Escape');
  await history(page, 'undo');
  await expect(node).toHaveCSS('width', automaticWidth);
  await history(page, 'redo');
  await expect(node).toHaveCSS('width', '1200px');
  await expect
    .poll(async () => {
      const saved = await readSpace(page, hostId);
      return (saved.state as { nodes: Node[] }).nodes[0]?.style?.width;
    })
    .toBe(1200);
  await page.reload();
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await expect(node).toHaveCSS('width', '1200px');
  await body.click();
  await page
    .getByRole('button', { name: 'Shortcut width', exact: true })
    .click();
  await form.getByRole('button', { name: 'Automatic', exact: true }).click();
  await expect(node).toHaveCSS('width', automaticWidth);
  expect(
    await node.evaluate((element) => element.clientWidth),
  ).toBeLessThanOrEqual(480);
  await expect(body).toHaveCSS('font-size', '28px');
});

test('a known shortcut can navigate while focus-triggered metadata refresh is pending', async ({
  page,
}) => {
  const targetId = await createSpace(page, 'Pending refresh target');
  const hostId = await createSpace(page, 'Pending refresh host');
  await seedNode(page, hostId, 'spacePreview', { targetCanvasId: targetId });
  await page.goto(`/canvas/${hostId}`);
  const shortcut = page.locator('[data-space-shortcut]');
  await expect(shortcut).toHaveAttribute('data-target-status', 'ready');
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/api/canvas', async (route) => {
    requested = true;
    await paused;
    await route.continue();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requested).toBe(true);
    await expect(shortcut).toHaveAttribute('data-target-status', 'ready');
    await shortcut.dblclick();
    await expect(page).toHaveURL(`/canvas/${targetId}`);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
