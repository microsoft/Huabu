// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as CanvasStore from '../src/store/canvasStore';
import type * as WorkspaceStore from '../src/store/workspaceStore';

async function create(page: Page, title: string) {
  const response = await page.request.post('/api/canvas', { data: { title } });
  expect(response.ok()).toBe(true);
  return (await response.json()).canvasId as string;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('huabu.language', 'en'));
});

test('cancelling child-Space deletion preserves separately selected edges', async ({
  page,
}) => {
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
    name: 'Delete Space?',
    exact: true,
  });
  await expect(dialog).toBeVisible();
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
    name: 'Delete Space?',
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

test('change-parent dialog initializes from metadata arriving after opening', async ({
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
  await page
    .getByRole('menuitem', { name: 'Change parent', exact: true })
    .click();
  release();
  const dialog = page.getByRole('dialog', {
    name: 'Change parent',
    exact: true,
  });
  await expect(
    dialog.getByRole('button', { name: 'Parent Space', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Parent Space', exact: true }),
  ).toHaveText('Review root');
  await dialog
    .getByRole('button', { name: 'Parent Space', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Review destination', exact: true })
    .click();
  const request = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/canvas/${child}/parent`) &&
      response.request().method() === 'PATCH',
  );
  await dialog
    .getByRole('button', { name: 'Change parent', exact: true })
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
    .getByRole('menuitem', { name: 'Change parent', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Change parent',
    exact: true,
  });
  const parent = dialog.getByRole('button', {
    name: 'Parent Space',
    exact: true,
  });
  await expect(parent).toBeEnabled();
  await parent.click();
  await page
    .getByRole('option', { name: 'Chosen parent', exact: true })
    .click();
  const changed = await page.request.patch(`/api/canvas/${child}/parent`, {
    data: { parentSpaceId: concurrent, expectedParentSpaceId: original },
  });
  expect(changed.ok()).toBe(true);
  await dialog
    .getByRole('button', { name: 'Change parent', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('Space parent changed');
  await expect(parent).toHaveText('Concurrent parent');
  await parent.click();
  await page
    .getByRole('option', { name: 'Chosen parent', exact: true })
    .click();
  const completion = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/canvas/${child}/parent`) &&
      response.request().method() === 'PATCH',
  );
  await dialog
    .getByRole('button', { name: 'Change parent', exact: true })
    .click();
  const completed = await completion;
  expect(completed.ok()).toBe(true);
  expect(completed.request().postDataJSON()).toEqual({
    parentSpaceId: destination,
    expectedParentSpaceId: concurrent,
  });
  await expect(dialog).toBeHidden();
});
