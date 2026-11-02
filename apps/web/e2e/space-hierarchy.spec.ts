// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as CanvasStore from '../src/store/canvasStore';
import type * as WorkspaceStore from '../src/store/workspaceStore';
import type { CanvasSummary } from '@huabu/shared';

async function create(page: Page, title: string) {
  const response = await page.request.post('/api/canvas', { data: { title } });
  expect(response.ok()).toBe(true);
  return (await response.json()).canvasId as string;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('huabu.language', 'en'));
});

test('Add Content brings an existing Space into the visible destination and selects its entry', async ({
  page,
}, testInfo) => {
  const oldParent = await create(page, 'Bring old parent');
  const destination = await create(page, 'Bring destination');
  const created = await page.request.post(`/api/canvas/${oldParent}/children`, {
    data: { title: 'Bring source' },
  });
  expect(created.ok()).toBe(true);
  const source = await created.json();
  const grandchild = await page.request.post(
    `/api/canvas/${source.canvasId}/children`,
    {
      data: { title: 'Bring retained child' },
    },
  );
  expect(grandchild.ok()).toBe(true);
  const original = await (
    await page.request.get(`/api/canvas/${source.canvasId}`)
  ).json();
  const seeded = await page.request.post(`/api/canvas/${destination}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-far',
              nodeType: 'text',
              position: { x: 20000, y: 20000 },
              data: { content: 'Far away' },
            },
            {
              id: 'node-center',
              nodeType: 'note',
              position: { x: 440, y: 250 },
              size: { width: 400, height: 300 },
              data: { content: 'Keep clear' },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-bring-space' },
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.goto(`/canvas/${destination}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return !!store.getState().rfInstance;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    const viewport = { x: 0, y: 0, zoom: 1 };
    const instance = store.getState().rfInstance;
    if (!instance) throw new Error('Canvas viewport is missing');
    await instance.setViewport(viewport);
    store.getState().setViewport(viewport);
  });
  await page.getByRole('button', { name: 'Add Content', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Add Space Shortcut', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('menuitem', { name: 'Move existing Space here', exact: true })
    .click();
  const picker = page.getByRole('dialog', {
    name: 'Move existing Space here',
    exact: true,
  });
  await picker.getByRole('textbox').fill('Bring source');
  await expect(
    picker.getByRole('button', { name: 'Bring source', exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath('bring-space-picker-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picker.locator('..')).toHaveCSS('max-width', '358px');
  await expect
    .poll(async () => {
      const box = await picker.boundingBox();
      return box ? box.x + box.width : Infinity;
    })
    .toBeLessThanOrEqual(378);
  const bounds = await picker.boundingBox();
  if (!bounds) throw new Error('Source picker is missing');
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(378);
  await page.screenshot({
    path: testInfo.outputPath('bring-space-picker-mobile.png'),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(
    `**/api/canvas/${source.canvasId}/parent`,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Move test failure' }),
      }),
    { times: 1 },
  );
  const sourceChoice = picker.getByRole('button', {
    name: 'Bring source',
    exact: true,
  });
  await sourceChoice.click();
  await expect(picker.getByRole('alert')).toHaveText('Move test failure');
  await expect(
    page.getByText('Move test failure', { exact: true }),
  ).toHaveCount(1);
  await expect(sourceChoice).toBeEnabled();
  let releaseMove!: () => void;
  const moveGate = new Promise<void>((resolve) => {
    releaseMove = resolve;
  });
  await page.route(`**/api/canvas/${source.canvasId}/parent`, async (route) => {
    await moveGate;
    await route.continue();
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/canvas/${source.canvasId}/parent`) &&
      response.request().method() === 'PATCH',
  );
  await picker
    .getByRole('button', { name: 'Bring source', exact: true })
    .click();
  await expect(sourceChoice).toBeVisible();
  await expect(sourceChoice).toBeDisabled();
  await expect(picker.getByRole('status')).toHaveText('Moving Space…');
  await expect(picker.getByRole('textbox')).toHaveValue('Bring source');
  await page.screenshot({ path: testInfo.outputPath('bring-space-busy.png') });
  releaseMove();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    parentSpaceId: destination,
    expectedParentSpaceId: oldParent,
    position: { x: expect.any(Number), y: expect.any(Number) },
  });
  const moved = await response.json();
  await expect(picker).toBeHidden();
  const card = page.locator(
    `.react-flow__node[data-id="${moved.parentEntryNodeId}"]`,
  );
  await expect(card).toHaveClass(/selected/);
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(new RegExp(`/canvas/${destination}$`));
  const cardBounds = await card.boundingBox();
  const noteBounds = await page
    .locator('.react-flow__node[data-id="node-center"]')
    .boundingBox();
  if (!cardBounds || !noteBounds) throw new Error('Placement bounds missing');
  expect(
    cardBounds.x + cardBounds.width <= noteBounds.x ||
      cardBounds.x >= noteBounds.x + noteBounds.width ||
      cardBounds.y + cardBounds.height <= noteBounds.y ||
      cardBounds.y >= noteBounds.y + noteBounds.height,
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('bring-space-result.png'),
  });
  const after = await (
    await page.request.get(`/api/canvas/${source.canvasId}`)
  ).json();
  const { canvases }: { canvases: CanvasSummary[] } = await (
    await page.request.get('/api/canvas')
  ).json();
  expect(
    canvases.find((space) => space.canvasId === source.canvasId)?.parentSpaceId,
  ).toBe(destination);
  expect(after.state).toEqual(original.state);
  const previous = await (
    await page.request.get(`/api/canvas/${oldParent}`)
  ).json();
  expect(previous.state.nodes).not.toContainEqual(
    expect.objectContaining({ id: source.parentEntryNodeId }),
  );
});

test('Home moves an existing Space subtree and the current Space menu promotes it without changing content', async ({
  page,
}, testInfo) => {
  const source = await create(page, 'Organize existing Space');
  const destination = await create(page, 'Organize destination');
  const childResponse = await page.request.post(
    `/api/canvas/${source}/children`,
    {
      data: { title: 'Organize retained child' },
    },
  );
  expect(childResponse.ok()).toBe(true);
  const child = (await childResponse.json()).canvasId;
  const seeded = await page.request.post(`/api/canvas/${source}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-retained-text',
              nodeType: 'text',
              data: { content: 'Keep this content and its position' },
              position: { x: 120, y: 240 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-organize' },
    },
  });
  expect(seeded.ok()).toBe(true);
  const original = await (
    await page.request.get(`/api/canvas/${source}`)
  ).json();

  await page.goto('/spaces');
  const homeTrigger = page.getByRole('button', {
    name: 'Actions for Organize existing Space',
    exact: true,
  });
  await homeTrigger.focus();
  await homeTrigger.press('ArrowDown');
  await page
    .getByRole('menuitem', { name: 'Move into another Space', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Move Organize existing Space',
    exact: true,
  });
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(homeTrigger).toBeFocused();
  await homeTrigger.press('ArrowDown');
  await page
    .getByRole('menuitem', { name: 'Move into another Space', exact: true })
    .click();
  await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
  await dialog
    .getByRole('textbox', { name: 'Search destination Spaces' })
    .fill('Organize');
  await expect(
    dialog.getByRole('button', {
      name: 'Organize existing Space',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', {
      name: 'Organize retained child',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Top level', exact: true }),
  ).toHaveCount(0);
  await expect(dialog).not.toContainText('Current location:');
  await expect(dialog).not.toContainText('will become a child Space');
  const anchor = page.getByRole('button', {
    name: 'Actions for Organize existing Space',
    exact: true,
  });
  const anchorBounds = await anchor.boundingBox();
  const desktopBounds = await dialog.boundingBox();
  if (!anchorBounds || !desktopBounds)
    throw new Error('Move popover anchor is not visible');
  expect(desktopBounds.y).toBeGreaterThanOrEqual(
    anchorBounds.y + anchorBounds.height,
  );
  expect(desktopBounds.y - anchorBounds.y - anchorBounds.height).toBeLessThan(
    24,
  );
  await page.screenshot({
    path: testInfo.outputPath('move-space-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('..')).toHaveCSS('max-width', '358px');
  const bounds = await dialog.boundingBox();
  if (!bounds) throw new Error('Move dialog is not visible');
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(378);
  await page.screenshot({ path: testInfo.outputPath('move-space-mobile.png') });
  await dialog
    .getByRole('button', { name: 'Organize destination', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/spaces$/);
  await expect(page.locator(`a[href="/canvas/${source}"]`)).toHaveCount(0);

  const list = async (): Promise<CanvasSummary[]> =>
    (await (await page.request.get('/api/canvas')).json()).canvases;
  const nested = (await list()).find((space) => space.canvasId === source);
  if (!nested) throw new Error('Moved Space is missing');
  expect(nested.parentSpaceId).toBe(destination);
  expect(
    (await list()).find((space) => space.canvasId === child)?.parentSpaceId,
  ).toBe(source);
  const moved = await (await page.request.get(`/api/canvas/${source}`)).json();
  expect(moved.state.nodes).toEqual(original.state.nodes);
  expect(moved.state.edges).toEqual(original.state.edges);

  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.locator(`a[href="/canvas/${source}"]`).click();
  await expect(
    page.getByRole('link', { name: 'Organize destination', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Space menu', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Move into another Space', exact: true })
    .click();
  await expect(dialog).not.toContainText('will remain as a shortcut');
  await expect(
    dialog.getByRole('button', { name: 'Move to top level', exact: true }),
  ).toHaveCount(0);
  const titleAnchor = await page
    .getByRole('button', { name: 'Space menu', exact: true })
    .boundingBox();
  const titlePopover = await dialog.boundingBox();
  if (!titleAnchor || !titlePopover)
    throw new Error('Title popover anchor is not visible');
  expect(titlePopover.y).toBeGreaterThanOrEqual(
    titleAnchor.y + titleAnchor.height,
  );
  expect(titlePopover.y - titleAnchor.y - titleAnchor.height).toBeLessThan(24);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Space menu', exact: true }).click();
  await page
    .getByRole('menu')
    .screenshot({ path: testInfo.outputPath('promote-space-menu.png') });
  await page
    .getByRole('menuitem', { name: 'Move to top level', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/canvas/${source}$`));
  await expect
    .poll(
      async () =>
        (await list()).find((space) => space.canvasId === source)
          ?.parentSpaceId ?? null,
    )
    .toBeNull();
  const promoted = (await list()).find((space) => space.canvasId === source);
  expect(promoted).toBeDefined();
  expect(promoted?.parentSpaceId ?? null).toBeNull();
  expect(
    (await list()).find((space) => space.canvasId === child)?.parentSpaceId,
  ).toBe(source);
  const parentRecord = await (
    await page.request.get(`/api/canvas/${destination}`)
  ).json();
  expect(parentRecord.state.nodes).not.toContainEqual(
    expect.objectContaining({
      id: nested.parentEntryNodeId,
      data: expect.objectContaining({ targetCanvasId: source }),
    }),
  );
  await page.reload();
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByRole('link', { name: 'Organize destination', exact: true }),
  ).toHaveCount(0);

  const reattach = await page.request.patch(`/api/canvas/${source}/parent`, {
    data: { parentSpaceId: destination, expectedParentSpaceId: null },
  });
  expect(reattach.ok()).toBe(true);
  const reattached = await reattach.json();
  await page.goto('/spaces');
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Actions for Organize existing Space',
      exact: true,
    })
    .click();
  await page
    .getByRole('menuitem', { name: 'Move to top level', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await list()).find((space) => space.canvasId === source)
          ?.parentSpaceId ?? null,
    )
    .toBeNull();
  await expect
    .poll(async () => {
      const record = await (
        await page.request.get(`/api/canvas/${destination}`)
      ).json();
      return record.state.nodes.some(
        (node: { id: string }) => node.id === reattached.parentEntryNodeId,
      );
    })
    .toBe(false);
  await page
    .getByRole('button', {
      name: 'Actions for Organize existing Space',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Move to top level', exact: true }),
  ).toHaveCount(0);
});

test('cancelling child-Space deletion preserves separately selected edges', async ({
  page,
}, testInfo) => {
  const parent = await create(page, 'Guarded delete parent');
  const response = await page.request.post(`/api/canvas/${parent}/children`, {
    data: { title: 'Guarded delete child' },
  });
  expect(response.ok()).toBe(true);
  const child = await response.json();
  const seeded = await page.request.post(`/api/canvas/${parent}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: ['node-a', 'node-b'].map((id, index) => ({
            id,
            nodeType: 'text',
            data: { content: id },
            position: { x: 500 + index * 300, y: 100 },
          })),
        },
        {
          type: 'CONNECT_NODES',
          edges: [{ id: 'edge-selected', source: 'node-a', target: 'node-b' }],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-guarded-delete' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.goto(`/canvas/${parent}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(() =>
      page.evaluate(async (childId) => {
        const path = '/src/store/workspaceStore.ts';
        const { useWorkspaceStore } = (await import(
          path
        )) as typeof WorkspaceStore;
        return useWorkspaceStore.getState().spaceSummaries[childId]
          ?.parentEntryNodeId;
      }, child.canvasId),
    )
    .toBe(child.parentEntryNodeId);
  await page.evaluate(async (entryId) => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    store.getState()._setStateNoAutosave({
      nodes: store
        .getState()
        .nodes.map((node) => ({ ...node, selected: node.id === entryId })),
      edges: store
        .getState()
        .edges.map((edge) => ({ ...edge, selected: true })),
    });
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  }, child.parentEntryNodeId);
  await page.keyboard.press('Backspace');
  const dialog = page.getByRole('dialog', {
    name: 'Delete “Guarded delete child”?',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Guarded delete child', { exact: true }),
  ).toHaveCount(0);
  await expect(dialog).not.toContainText('shortcuts');
  await expect(dialog).toContainText(
    'All contents will be permanently deleted.',
  );
  await page.screenshot({
    path: testInfo.outputPath('delete-space-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveCSS('max-width', '342px');
  await page.screenshot({
    path: testInfo.outputPath('delete-space-mobile.png'),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const retained = await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    await store.getState().saveCanvas();
    return {
      nodes: store.getState().nodes.map((node) => node.id),
      edges: store.getState().edges.map((edge) => edge.id),
    };
  });
  expect(retained.nodes).toContain(child.parentEntryNodeId);
  expect(retained.edges).toEqual(['edge-selected']);
  const persisted = await (
    await page.request.get(`/api/canvas/${parent}`)
  ).json();
  expect(persisted.state.edges).toEqual([
    expect.objectContaining({ id: 'edge-selected' }),
  ]);
  expect(persisted.state.nodes).toContainEqual(
    expect.objectContaining({ id: child.parentEntryNodeId }),
  );
});

test('immediate Undo after child creation keeps its entry and leaves saves usable', async ({
  page,
}) => {
  const parent = await create(page, 'Undo parent');
  await page.goto(`/canvas/${parent}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const response = await page.request.post(`/api/canvas/${parent}/children`, {
    data: { title: 'Undo child' },
  });
  expect(response.ok()).toBe(true);
  const child = await response.json();
  await expect
    .poll(() =>
      page.evaluate(async (entryId) => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return store.getState().nodes.some((node) => node.id === entryId);
      }, child.parentEntryNodeId),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    await store.getState().undo();
    await store.getState().saveCanvas();
  });
  const record = await (await page.request.get(`/api/canvas/${parent}`)).json();
  expect(record.state.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: child.parentEntryNodeId }),
    ]),
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return store.getState().versionConflict;
      }),
    )
    .toBe(false);
});

test('leaves a deleted current Space and keeps the partial-cleanup error visible', async ({
  page,
}) => {
  const id = await create(page, 'Partial cleanup');
  await page.goto(`/canvas/${id}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.route(`**/api/canvas/${id}/delete-tree`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SPACE_TREE_DELETE_FAILED',
        message: 'Parent cleanup failed',
        details: {
          deletedCanvasIds: [id],
          remainingCanvasIds: [],
          cause: 'Cleanup failed',
        },
      }),
    });
  });
  await page.getByRole('button', { name: 'Space menu', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Delete Space', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Delete “Partial cleanup”?',
    exact: true,
  });
  await dialog
    .getByRole('button', { name: 'Delete Space', exact: true })
    .click();
  await expect(page).toHaveURL(/\/spaces$/);
  await expect(
    page.getByText('Parent cleanup failed', { exact: true }),
  ).toBeVisible();
});

test('change-parent menu waits for metadata before opening', async ({
  page,
}) => {
  const root = await create(page, 'Review root');
  const destination = await create(page, 'Review destination');
  const childResponse = await page.request.post(
    `/api/canvas/${root}/children`,
    { data: { title: 'Review child' } },
  );
  expect(childResponse.ok()).toBe(true);
  const child = (await childResponse.json()).canvasId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/canvas(?:\?.*)?$/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`/canvas/${child}`);
  await page.getByRole('button', { name: 'Space menu', exact: true }).click();
  const moveItem = page.getByRole('menuitem', {
    name: 'Move into another Space',
    exact: true,
  });
  await expect(moveItem).toBeDisabled();
  release();
  await expect(moveItem).toBeEnabled();
  await moveItem.click();
  const dialog = page.getByRole('dialog', {
    name: 'Move Review child',
    exact: true,
  });
  await expect(
    dialog.getByRole('button', { name: 'Review root', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Review root', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const request = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/canvas/${child}/parent`) &&
      response.request().method() === 'PATCH',
  );
  await dialog
    .getByRole('button', { name: 'Review destination', exact: true })
    .click();
  const response = await request;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({
    parentSpaceId: destination,
    expectedParentSpaceId: root,
  });
  await expect(dialog).toBeHidden();
});

test('World clears selection when a selected top-level Space becomes nested', async ({
  page,
}) => {
  const root = await create(page, 'Review world root');
  const child = await create(page, 'Review world candidate');
  const info = await (await page.request.get('/api/workspace')).json();
  const world = info.worldCanvasId;
  expect(typeof world).toBe('string');
  await page.goto(`/canvas/${world}`);
  await expect
    .poll(() =>
      page.evaluate(async (child) => {
        const path = '/src/store/workspaceStore.ts';
        const { useWorkspaceStore } = (await import(
          path
        )) as typeof WorkspaceStore;
        return !!useWorkspaceStore.getState().spaceSummaries[child];
      }, child),
    )
    .toBe(true);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const nodeId = await page.evaluate(
    async ({ child, root }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasStore;
      const node = store
        .getState()
        .nodes.find(
          (node) =>
            node.data.type === 'spacePreview' &&
            node.data.targetCanvasId === child,
        );
      const rootNode = store
        .getState()
        .nodes.find(
          (node) =>
            node.data.type === 'spacePreview' &&
            node.data.targetCanvasId === root,
        );
      if (!node || !rootNode) throw new Error('World entry missing');
      store.getState().selectNodes([node.id, rootNode.id]);
      store.getState()._setStateNoAutosave({
        edges: [
          ...store.getState().edges,
          {
            id: 'edge-selection-regression',
            source: rootNode.id,
            target: node.id,
            selected: true,
          },
        ],
      });
      return node.id;
    },
    { child, root },
  );
  const result = await page.request.patch(`/api/canvas/${child}/parent`, {
    data: { parentSpaceId: root, expectedParentSpaceId: null },
  });
  expect(result.ok()).toBe(true);
  await page.evaluate(async () => {
    const path = '/src/store/workspaceStore.ts';
    const { useWorkspaceStore } = (await import(path)) as typeof WorkspaceStore;
    await useWorkspaceStore.getState().refreshSpaceTitles();
  });
  await expect
    .poll(() =>
      page.evaluate(async (nodeId) => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return !!store.getState().rfInstance?.getInternalNode(nodeId);
      }, nodeId),
    )
    .toBe(false);
  const selection = await page.evaluate(
    async ({ nodeId, root }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasStore;
      const state = store.getState();
      return {
        child: state.nodes.find((node) => node.id === nodeId)?.selected,
        root: state.nodes.find(
          (node) =>
            node.data.type === 'spacePreview' &&
            node.data.targetCanvasId === root,
        )?.selected,
        edge: state.edges.find(
          (edge) => edge.id === 'edge-selection-regression',
        )?.selected,
      };
    },
    { nodeId, root },
  );
  expect(selection).toEqual({ child: false, root: true, edge: false });
});

test('World first fit waits for hierarchy metadata', async ({ page }) => {
  await create(page, 'Review viewport root');
  const world = (await (await page.request.get('/api/workspace')).json())
    .worldCanvasId;
  const record = await (await page.request.get(`/api/canvas/${world}`)).json();
  const items = record.state.nodes.map((node: { id: string }) => ({
    nodeId: node.id,
    position: { x: 10000, y: 10000 },
  }));
  const moved = await page.request.post(`/api/canvas/${world}/execute`, {
    data: {
      commands: [{ type: 'SET_NODE_GEOMETRY', items }],
      originator: { source: 'ui' },
    },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/canvas(?:\?.*)?$/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`/canvas/${world}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  release();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/store/workspaceStore.ts';
        const { useWorkspaceStore } = (await import(
          path
        )) as typeof WorkspaceStore;
        return useWorkspaceStore.getState().spaceTitlesStatus;
      }),
    )
    .toBe('ready');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return store.getState().rfInstance?.getNodes().length ?? 0;
      }),
    )
    .toBeGreaterThan(0);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const point = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    return store
      .getState()
      .rfInstance?.flowToScreenPosition({ x: 10180, y: 10051 });
  });
  if (!point) throw new Error('Missing Canvas instance');
  expect(point.x).toBeGreaterThan(0);
  expect(point.y).toBeGreaterThan(0);
  expect(point.x).toBeLessThan(1280);
  expect(point.y).toBeLessThan(800);
});

test('change-parent conflict reloads the baseline and allows a fresh choice', async ({
  page,
}) => {
  const original = await create(page, 'Original parent');
  const concurrent = await create(page, 'Concurrent parent');
  const destination = await create(page, 'Chosen parent');
  const response = await page.request.post(`/api/canvas/${original}/children`, {
    data: { title: 'Conflict child' },
  });
  expect(response.ok()).toBe(true);
  const child = (await response.json()).canvasId;
  await page.goto(`/canvas/${child}`);
  await expect(
    page.getByRole('link', { name: 'Original parent', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Space menu', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Move into another Space', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Move Conflict child',
    exact: true,
  });
  await expect(
    dialog.getByRole('button', { name: 'Chosen parent', exact: true }),
  ).toBeVisible();
  const changed = await page.request.patch(`/api/canvas/${child}/parent`, {
    data: { parentSpaceId: concurrent, expectedParentSpaceId: original },
  });
  expect(changed.ok()).toBe(true);
  await dialog
    .getByRole('button', { name: 'Chosen parent', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('Space parent changed');
  await expect(
    dialog.getByRole('button', { name: 'Concurrent parent', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const completion = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/canvas/${child}/parent`) &&
      response.request().method() === 'PATCH',
  );
  await dialog
    .getByRole('button', { name: 'Chosen parent', exact: true })
    .click();
  const completed = await completion;
  expect(completed.ok()).toBe(true);
  expect(completed.request().postDataJSON()).toEqual({
    parentSpaceId: destination,
    expectedParentSpaceId: concurrent,
  });
  await expect(dialog).toBeHidden();
});
