// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as StoreModule from '../src/store/canvasStore';
import type {
  CreateCanvasResponse,
  GetCanvasResponse,
  ListCanvasesResponse,
  SpaceHierarchyResponse,
} from '@huabu/shared';
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

async function selectAllContent(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof StoreModule;
    store.getState().selectNodes(
      store
        .getState()
        .nodes.filter((node) => node.type !== 'spacePreview')
        .map((node) => node.id),
      false,
    );
  });
}

test('collection and movement stay in place, with animated explicit navigation', async ({
  page,
}, testInfo) => {
  const source = await createSpace(page, 'Collection source');
  const destination = await createSpace(
    page,
    'Existing collection destination',
  );
  await seedNode(page, source, 'text', { content: 'Collected content' });
  await page.goto(`/canvas/${source}`);
  await expect(page.locator('.react-flow__node-text')).toBeVisible();
  await selectAllContent(page);
  await page.keyboard.press('ControlOrMeta+Alt+s');
  await expect(page.locator('.react-flow__node-spacePreview')).toBeVisible();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await page.evaluate(() => {
    const pauseEntrance = (event: AnimationEvent) => {
      if (
        event.animationName !== 'space-canvas-enter' ||
        !(event.target instanceof HTMLElement)
      )
        return;
      const surface = event.target;
      document.documentElement.dataset.spaceEnterReady = String(
        surface.closest('[data-canvas-root]')?.getAttribute('aria-busy') ===
          'false' && getComputedStyle(surface).visibility === 'visible',
      );
      delete document.documentElement.dataset.spaceEnterDuration;
      const animation = surface
        .getAnimations()
        .find(
          (item) =>
            item instanceof CSSAnimation &&
            item.animationName === 'space-canvas-enter',
        );
      animation?.pause();
      if (animation) animation.currentTime = 120;
      document.removeEventListener('animationstart', pauseEntrance);
    };
    document.addEventListener('animationstart', pauseEntrance);
    document.addEventListener('animationend', (event) => {
      if (event.animationName === 'space-canvas-enter')
        document.documentElement.dataset.spaceEnterDuration = String(
          event.elapsedTime,
        );
    });
  });
  await page
    .getByRole('button', { name: 'Open destination', exact: true })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/canvas/${source}$`));
  await expect(page.locator('.react-flow__node-text.selected')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute(
    'data-space-enter-ready',
    'true',
  );
  const midOpacity = await page
    .locator('.space-canvas-enter')
    .evaluate((surface) => Number(getComputedStyle(surface).opacity));
  expect(midOpacity).toBeGreaterThan(0);
  expect(midOpacity).toBeLessThan(1);
  await page.locator('.space-canvas-enter').evaluate((surface) => {
    for (const animation of surface.getAnimations()) animation.play();
  });
  await expect(page.locator('html')).toHaveAttribute(
    'data-space-enter-duration',
    '0.24',
  );
  await expect(page.locator('.space-canvas-enter')).toHaveCSS(
    'animation-duration',
    '0.24s',
  );
  expect(
    await page.evaluate(async () => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof StoreModule;
      return store.getState().rfInstance?.getZoom();
    }),
  ).toBeLessThanOrEqual(1);
  const childId = page.url().split('/canvas/')[1];
  if (!childId) throw new Error('Missing child route');
  const list = await page.request.get('/api/canvas');
  const child = ((await list.json()) as ListCanvasesResponse).canvases.find(
    (canvas) => canvas.canvasId === childId,
  );
  expect(child?.parentSpaceId).toBe(source);
  const header = page.getByRole('banner');
  const back = header.getByRole('button', {
    name: 'Back to Collection source',
    exact: true,
  });
  const layers = header.getByRole('button', {
    name: 'Show layers panel',
    exact: true,
  });
  await expect(
    header
      .getByRole('navigation')
      .getByRole('button', { name: 'Back to Collection source' }),
  ).toHaveCount(0);
  const backBox = await back.boundingBox();
  const layersBox = await layers.boundingBox();
  if (!backBox || !layersBox) throw new Error('Missing header controls');
  expect(backBox.x + backBox.width).toBeLessThanOrEqual(layersBox.x);
  expect(backBox.width).toBe(layersBox.width);
  expect(backBox.height).toBe(layersBox.height);
  await expect(back.locator('svg')).toHaveCSS('width', '16px');
  await expect(back).toHaveCSS(
    'color',
    await layers.evaluate((element) => getComputedStyle(element).color),
  );
  await header.screenshot({ path: testInfo.outputPath('header-return.png') });
  await page
    .getByRole('button', { name: 'Back to Collection source', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await expect(page.locator('.react-flow__node-spacePreview')).toBeVisible();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-space-shortcut-summary]').dblclick();
  await expect(page).toHaveURL(new RegExp(`/canvas/${childId}$`));
  await expect(page.locator('.react-flow__node-text')).toBeVisible();
  await expect(page.locator('.space-canvas-enter')).toHaveCSS(
    'animation-name',
    'none',
  );
  await selectAllContent(page);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move to another Space' }).click();
  const chooser = page.getByRole('dialog', { name: 'Move to another Space' });
  await expect(chooser.locator('input[type="checkbox"]')).toHaveCount(0);
  await chooser
    .getByRole('textbox', { name: 'Search destination Spaces' })
    .fill('Existing collection');
  await chooser
    .getByRole('button', {
      name: 'Existing collection destination',
      exact: true,
    })
    .click();
  await expect(chooser).not.toBeVisible();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/canvas/${childId}$`));
  await page
    .getByRole('button', { name: 'Open destination', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/canvas/${destination}$`));
  await expect(page.locator('.react-flow__node-text.selected')).toBeVisible();
  const saved = await readSpace(page, childId);
  expect((saved.state as { nodes: Node[] }).nodes).toHaveLength(0);
});

test('the child tool ignores selection on click and supports cancellation and rectangle collection', async ({
  page,
}) => {
  const source = await createSpace(page, 'Child tool source');
  await seedNode(page, source, 'text', { content: 'Rectangle content' });
  await page.goto(`/canvas/${source}`);
  const text = page.locator('.react-flow__node-text');
  await expect(text).toBeVisible();
  await selectAllContent(page);
  await page.keyboard.press('5');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await page
    .getByRole('button', { name: 'New child Space (5)', exact: true })
    .click();
  const wrapper = page.locator('[data-canvas-root]');
  const bounds = await wrapper.boundingBox();
  if (!bounds) throw new Error('Missing canvas bounds');
  await page.mouse.click(
    bounds.x + bounds.width * 0.65,
    bounds.y + bounds.height * 0.7,
  );
  await expect(page.locator('.react-flow__node-spacePreview')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await expect(text).toBeVisible();
  await page.getByRole('button', { name: /Canvas zoom/ }).click();
  await page.getByRole('menuitem', { name: /Reset.*100%/ }).click();
  const textBounds = await text.boundingBox();
  if (!textBounds) throw new Error('Missing content bounds');
  await page.keyboard.press('5');
  await page.mouse.move(textBounds.x - 12, textBounds.y - 12);
  await page.mouse.down();
  await page.mouse.move(
    textBounds.x + textBounds.width + 12,
    textBounds.y + textBounds.height + 12,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(page.locator('.react-flow__node-spacePreview')).toHaveCount(2);
  await expect(text).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
});

test('single-node collection is in More and creates an owned child without navigating', async ({
  page,
}) => {
  const source = await createSpace(page, 'Collection button source');
  await seedNode(page, source, 'text', { content: 'Button content' });
  await page.goto(`/canvas/${source}`);
  await expect(page.locator('.react-flow__node-text')).toBeVisible();
  await selectAllContent(page);
  await expect(
    page.getByRole('button', { name: /Collect into child Space/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('menuitem', { name: /Collect into child Space/ })
    .click();
  await expect(page.locator('.react-flow__node-spacePreview')).toBeVisible();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  const list = await page.request.get('/api/canvas');
  const child = ((await list.json()) as ListCanvasesResponse).canvases.find(
    (canvas) => canvas.parentSpaceId === source,
  );
  expect(child?.parentSpaceId).toBe(source);
});

test('mixed collection reparents child Spaces and the tree picker blocks cyclic destinations', async ({
  page,
}, testInfo) => {
  const source = await createSpace(page, 'Mixed collection source');
  const destination = await createSpace(page, 'Mixed destination');
  const linked = await createSpace(page, 'Linked only');
  const created = await page.request.post(`/api/canvas/${source}/children`, {
    data: { title: 'Owned child' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const child = (await created.json()) as SpaceHierarchyResponse;
  const nested = await page.request.post(
    `/api/canvas/${child.canvasId}/children`,
    { data: { title: 'Owned descendant' } },
  );
  expect(nested.ok(), await nested.text()).toBe(true);
  await seedNode(page, source, 'text', { content: 'Mixed content' });
  const shortcut = await page.request.post(`/api/canvas/${source}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-link',
              nodeType: 'spacePreview',
              data: { targetCanvasId: linked },
              position: { x: 800, y: 200 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'mixed-move-e2e' },
    },
  });
  expect(shortcut.ok(), await shortcut.text()).toBe(true);
  await page.goto(`/canvas/${source}`);
  await expect(page.locator('.react-flow__node-text')).toBeVisible();
  const selectEverything = async () =>
    page.evaluate(async () => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof StoreModule;
      store.getState().selectNodes(
        store.getState().nodes.map((node) => node.id),
        false,
      );
    });
  await selectEverything();
  await page.getByRole('button', { name: /Collect into child Space/ }).click();
  await expect(page.locator('.react-flow__node-spacePreview')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await page
    .getByRole('button', { name: 'Open destination', exact: true })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/canvas/${source}$`));
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
  const collection = page.url().split('/canvas/')[1];
  if (!collection) throw new Error('Missing collection');
  const summaries = async () => {
    const response = await page.request.get('/api/canvas');
    return ((await response.json()) as ListCanvasesResponse).canvases;
  };
  expect(
    (await summaries()).find((item) => item.canvasId === child.canvasId)
      ?.parentSpaceId,
  ).toBe(collection);
  expect(
    (await summaries()).find((item) => item.canvasId === linked)
      ?.parentSpaceId ?? null,
  ).toBeNull();
  await page
    .getByRole('button', { name: 'Move to another Space', exact: true })
    .click();
  const chooser = page.getByRole('dialog', { name: 'Move to another Space' });
  const search = chooser.getByRole('textbox', {
    name: 'Search destination Spaces',
  });
  await search.fill('Owned');
  await expect(
    chooser.getByRole('button', { name: 'Owned child', exact: true }),
  ).toBeDisabled();
  await expect(
    chooser.getByRole('button', { name: 'Owned descendant', exact: true }),
  ).toBeDisabled();
  await search.fill('');
  await expect(
    chooser.getByRole('button', { name: 'Mixed destination', exact: true }),
  ).toHaveCSS('text-align', 'left');
  await chooser.screenshot({
    path: testInfo.outputPath('move-space-tree.png'),
  });
  await search.fill('Mixed destination');
  await chooser
    .getByRole('button', { name: 'Mixed destination', exact: true })
    .click();
  await expect(chooser).not.toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/canvas/${collection}$`));
  await page
    .getByRole('button', { name: 'Open destination', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/canvas/${destination}$`));
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
  expect(
    (await summaries()).find((item) => item.canvasId === child.canvasId)
      ?.parentSpaceId,
  ).toBe(destination);
  expect((await readSpace(page, collection)).state).toMatchObject({
    nodes: [],
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

test('Add Space Shortcut browses the shared tree and preserves target ownership', async ({
  page,
}, testInfo) => {
  const host = await createSpace(page, 'Shortcut picker host');
  const parent = await createSpace(page, 'Shortcut tree parent');
  const response = await page.request.post(`/api/canvas/${parent}/children`, {
    data: { title: 'Shortcut tree child' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const child = (await response.json()) as SpaceHierarchyResponse;
  await page.goto(`/canvas/${host}`);
  const trigger = page.getByRole('button', {
    name: 'Add Content',
    exact: true,
  });
  const openPicker = async () => {
    await trigger.click();
    await page
      .getByRole('menuitem', { name: 'Add Space Shortcut', exact: true })
      .click();
  };
  await openPicker();
  const picker = page.getByRole('dialog', { name: 'Choose a Space' });
  await expect(
    picker.getByRole('button', { name: 'Shortcut picker host', exact: true }),
  ).toBeDisabled();
  await expect(
    picker.getByRole('button', { name: 'Shortcut tree child', exact: true }),
  ).toHaveCount(0);
  await picker
    .getByRole('button', { name: 'Expand Shortcut tree parent', exact: true })
    .click();
  await expect(
    picker.getByRole('button', { name: 'Shortcut tree child', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-space-shortcut]')).toHaveCount(0);
  await picker.screenshot({ path: testInfo.outputPath('shortcut-tree.png') });
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await openPicker();
  const search = picker.getByRole('textbox', {
    name: 'Search Spaces',
    exact: true,
  });
  await search.fill('Shortcut tree child');
  await expect(
    picker.getByRole('button', { name: 'Shortcut tree child', exact: true }),
  ).toContainText('Shortcut tree parent');
  await picker
    .getByRole('button', { name: 'Shortcut tree child', exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/canvas/${host}$`));
  const shortcut = page.locator(`[data-space-shortcut="${child.canvasId}"]`);
  await expect(shortcut).toBeVisible();
  await expect(shortcut.locator('svg[aria-label="Shortcut"]')).toHaveCount(1);
  const list = await page.request.get('/api/canvas');
  const target = ((await list.json()) as ListCanvasesResponse).canvases.find(
    (item) => item.canvasId === child.canvasId,
  );
  expect(target).toMatchObject({
    parentSpaceId: parent,
    parentEntryNodeId: child.parentEntryNodeId,
  });
  await shortcut.locator('[data-space-shortcut-summary]').dblclick();
  await expect(page).toHaveURL(new RegExp(`/canvas/${child.canvasId}$`));
  await page
    .getByRole('button', { name: 'Back to Shortcut picker host', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/canvas/${host}$`));
});

test('real shortcuts keep fixed widths, undo, resize, and navigate without scenes', async ({
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
  await page.getByRole('button', { name: /Canvas zoom/ }).click();
  await page.getByRole('menuitem', { name: /Reset.*100%/ }).click();
  await expect(body).toContainText('Research');
  await expect(body.locator('[data-space-shortcut-summary]')).toHaveText('now');
  await expect(body.locator('[data-space-shortcut-summary]')).toHaveCSS(
    'font-size',
    '18px',
  );
  await expect(node).toHaveCSS('width', '360px');
  expect(await node.evaluate((element) => element.clientHeight)).toBeLessThan(
    120,
  );

  await body.click();
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  const widthInput = page.locator('input[name="node-width"]');
  await expect(widthInput).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Fit width to content' }),
  ).toHaveCount(0);
  await widthInput.fill('320');
  await widthInput.press('Enter');
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
    'now',
  );
  await expect(node).toHaveCSS('width', '320px');
  expect(
    await node.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(152);
  expect(
    await node.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(126);
  const undone = await history(page, 'undo');
  expect(undone).toMatchObject({
    before: [{ mode: 'fixed', width: 320 }],
    after: [{ mode: 'fixed', width: 360 }],
  });
  await expect(node).toHaveCSS('width', '360px');
  await history(page, 'redo');
  await expect(node).toHaveCSS('width', '320px');

  await expect
    .poll(async () => (await persistedNode())?.style?.width)
    .toBe(320);
  await page.reload();
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await page.getByRole('button', { name: /Canvas zoom/ }).click();
  await page.getByRole('menuitem', { name: /Reset.*100%/ }).click();
  await expect(node).toHaveCSS('width', '320px');

  await body.click();
  await expect(node.locator('.node-resize-edge')).toHaveCount(2);
  await expect(node.locator('.node-resize-corner')).toHaveCount(4);
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
  await expect(body).toHaveCSS('font-size', '24px');
  await expect(node.locator('.semantic-lod-node')).toHaveCSS(
    'border-top-width',
    '2px',
  );
  await history(page, 'undo');
  await expect(node).toHaveCSS('width', '320px');
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
    maximumEdge.x + maximumEdge.width / 2 + 400,
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
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('menuitem', { name: /Collect into child Space/ })
    .click();
  await expect(page.locator('.react-flow__node-text')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`/canvas/${hostId}`);
  const shortcut = page.locator('[data-space-shortcut]');
  await expect(shortcut).toHaveAttribute('data-target-status', 'ready');
  await expect(shortcut).toContainText('Untitled');
  await expect(shortcut.locator('[data-space-shortcut-summary]')).toContainText(
    'now',
  );
  const destinationId = await shortcut.getAttribute('data-space-shortcut');
  expect(destinationId).toBeTruthy();
  await shortcut.locator('[data-space-shortcut-summary]').dblclick();
  await expect(page).toHaveURL(`/canvas/${destinationId}`);
});

test('nested breadcrumbs keep header actions close at every depth and viewport width', async ({
  page,
}, testInfo) => {
  const root = await createSpace(page, 'Nested Spaces Demo');
  const spaces = [root];
  for (const title of [
    'Promotion Materials',
    'Working collection',
    'Untitled',
    'Outline',
    'Final',
  ]) {
    const response = await page.request.post(
      `/api/canvas/${spaces.at(-1)}/children`,
      { data: { title } },
    );
    expect(response.ok(), await response.text()).toBe(true);
    spaces.push(((await response.json()) as SpaceHierarchyResponse).canvasId);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const id of [spaces[1], spaces[3], spaces[5]]) {
    await page.goto(`/canvas/${id}`);
    const header = page.getByRole('banner');
    await expect(
      header.getByRole('link', { name: 'Nested Spaces Demo', exact: true }),
    ).toBeVisible();
    const wideCount = await header.locator('nav a').count();
    const checkGaps = async () => {
      const titleBox = await header
        .getByRole('group', { name: 'Space title', exact: true })
        .boundingBox();
      const toggleBox = await header
        .getByRole('button', { name: 'Show layers panel', exact: true })
        .boundingBox();
      const headerBox = await header.boundingBox();
      if (!titleBox || !toggleBox || !headerBox)
        throw new Error('Missing header geometry');
      expect(toggleBox.x - titleBox.x - titleBox.width).toBeGreaterThanOrEqual(
        0,
      );
      expect(toggleBox.x - titleBox.x - titleBox.width).toBeLessThanOrEqual(12);
      expect(
        headerBox.x + headerBox.width - toggleBox.x - toggleBox.width,
      ).toBeLessThanOrEqual(10);
    };
    await checkGaps();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(header.locator('nav a')).toHaveCount(1);
    await checkGaps();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(header.locator('nav a')).toHaveCount(wideCount);
    await checkGaps();
  }
  const header = page.getByRole('banner');
  const ancestors = header.getByRole('button', {
    name: 'Parent Spaces',
    exact: true,
  });
  await expect(ancestors).toHaveText('…');
  await header.screenshot({
    path: testInfo.outputPath('compact-breadcrumbs.png'),
  });
  await ancestors.focus();
  await ancestors.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Promotion Materials', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ancestors).toBeFocused();
});

test('custom width above 720 survives history and reload', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  const widthInput = page.locator('input[name="node-width"]');
  await widthInput.fill('1200');
  await widthInput.press('Enter');
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
    await shortcut.locator('[data-space-shortcut-summary]').dblclick();
    await expect(page).toHaveURL(`/canvas/${targetId}`);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
