// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as ProfilesStore from '../src/store/acpProfilesStore';
import type * as CanvasStore from '../src/store/canvasStore';
import type * as WorkspaceStore from '../src/store/previewWorkspace/store';

test.use({ hasTouch: false, viewport: { width: 1600, height: 1000 } });

for (const zoom of [0.1, 0.3, 0.75]) {
  test(`new Agent Node is selected and readable from ${zoom} zoom`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.evaluate(async () => {
      const path = '/src/store/acpProfilesStore.ts';
      const { useAcpProfilesStore } = (await import(
        path
      )) as typeof ProfilesStore;
      useAcpProfilesStore.getState().rememberConversationAgent('huabu');
    });
    await page
      .getByRole('button', { name: 'New conversation', exact: true })
      .click();
    const panel = page.locator('[data-canvas-panel="right"]');
    await expect(panel.getByRole('tab')).toHaveCount(1);
    const before = await page.evaluate(async (zoom) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasStore;
      const rf = store.getState().rfInstance;
      if (!rf) throw new Error('Canvas is not ready');
      await rf.setViewport({ x: -300, y: -200, zoom });
      return rf.getViewport();
    }, zoom);
    await panel
      .getByRole('button', { name: 'New Agent Node', exact: true })
      .click();
    const node = page.locator('.react-flow__node-question');
    await expect(node).toHaveClass(/selected/);
    const readViewport = () =>
      page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return store.getState().rfInstance?.getViewport();
      });
    if (zoom < 0.3) {
      await expect.poll(async () => (await readViewport())?.zoom).toBe(0.3);
      const box = await node.boundingBox();
      const panelBox = await panel.boundingBox();
      if (!box || !panelBox) throw new Error('Missing canvas geometry');
      expect(box.width).toBeGreaterThanOrEqual(120);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x);
    } else {
      expect(await readViewport()).toEqual(before);
    }
    await test.info().attach(`agent-created-from-${zoom}`, {
      body: await page.screenshot({
        path: test.info().outputPath(`agent-created-from-${zoom}.png`),
      }),
      contentType: 'image/png',
    });
  });
}

test('preview creation defaults to a persistent Agent Node and retains temporary chats', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.evaluate(async () => {
    const path = '/src/store/acpProfilesStore.ts';
    const { useAcpProfilesStore } = (await import(
      path
    )) as typeof ProfilesStore;
    useAcpProfilesStore.getState().rememberConversationAgent('huabu');
  });
  await page
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  const panel = page.locator('[data-canvas-panel="right"]');
  await expect(panel.getByRole('tab')).toHaveCount(1);
  const creationGroup = panel.getByRole('group', {
    name: 'New conversation',
    exact: true,
  });
  const controls = creationGroup.getByRole('button');
  await expect(controls).toHaveCount(2);
  const primaryBounds = await controls.nth(0).boundingBox();
  const menuBounds = await controls.nth(1).boundingBox();
  if (!primaryBounds || !menuBounds)
    throw new Error('Missing creation controls');
  expect(
    menuBounds.x - primaryBounds.x - primaryBounds.width,
  ).toBeLessThanOrEqual(1);
  expect(primaryBounds.width).toBe(24);
  expect(menuBounds.width).toBe(18);
  for (const bounds of [primaryBounds, menuBounds]) {
    expect(bounds.height).toBeGreaterThanOrEqual(24);
  }
  await expect(creationGroup).toHaveCSS('border-top-width', '0px');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.mouse.move(0, 0);
    await expect(creationGroup).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    const hoverColor = await creationGroup.evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bg-hover)';
      element.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    for (const [index, control] of (await controls.all()).entries()) {
      await control.hover();
      await expect(creationGroup).toHaveCSS('background-color', hoverColor);
      await test.info().attach(`creation-hover-${theme}-${index}`, {
        body: await creationGroup.screenshot({
          path: test.info().outputPath(`creation-hover-${theme}-${index}.png`),
        }),
        contentType: 'image/png',
      });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await panel
    .getByRole('button', { name: 'New Agent Node', exact: true })
    .click();
  await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
  await expect(panel.getByRole('tab')).toHaveCount(2);
  const agentId = await page
    .locator('.react-flow__node-question')
    .getAttribute('data-id');
  const snapshot = () =>
    page.evaluate(async () => {
      const path = '/src/store/previewWorkspace/store.ts';
      const { usePreviewWorkspaceStore } = (await import(
        path
      )) as typeof WorkspaceStore;
      return usePreviewWorkspaceStore.getState().workspace;
    });
  expect(Object.values((await snapshot()).tabs)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        transient: false,
        target: expect.objectContaining({ kind: 'node', nodeId: agentId }),
      }),
    ]),
  );
  await panel
    .getByRole('button', { name: 'Conversation creation options', exact: true })
    .click();
  await test.info().attach('preview-conversation-options', {
    body: await page.screenshot({
      path: test.info().outputPath('preview-conversation-options.png'),
    }),
    contentType: 'image/png',
  });
  await page
    .getByRole('menuitem', { name: 'New temporary chat', exact: true })
    .click();
  await expect(panel.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
  const workspace = await snapshot();
  const activeTabId = workspace.groups[0].activeTabId;
  if (!activeTabId)
    throw new Error('Expected the new temporary chat to be active');
  const activeTab = workspace.tabs[activeTabId];
  expect(activeTab.target.kind).toBe('chat');
  await page.reload();
  await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
  await expect(panel.getByRole('tab')).toHaveCount(3);
});

test('empty splits persist and canvas double-clicks follow the last interacted group', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    );
  });
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Select (S)', exact: true }).click();
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  if (!canvasId) throw new Error('Canvas ID is missing');
  const positions = await page
    .locator('.react-flow__viewport')
    .evaluate((viewport) => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) throw new Error('Canvas pane is missing');
      const bounds = pane.getBoundingClientRect();
      const transform = new DOMMatrix(getComputedStyle(viewport).transform);
      return [180, 550].map((y) => ({
        x: (250 - bounds.left - transform.e) / transform.a,
        y: (y - bounds.top - transform.f) / transform.d,
      }));
    });
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: positions.map((position, index) => ({
            nodeType: 'note',
            data: {
              label: index === 0 ? 'Alpha' : 'Beta',
              content: index === 0 ? 'Alpha' : 'Beta',
            },
            position,
            size: { width: 300, height: 200 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-preview-groups' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const nodes = page.locator('.react-flow__node-note');
  await expect(nodes).toHaveCount(2);
  const firstId = await nodes.nth(0).getAttribute('data-id');
  const secondId = await nodes.nth(1).getAttribute('data-id');
  if (!firstId || !secondId) throw new Error('Notes must have stable IDs');
  const snapshot = () =>
    page.evaluate(async () => {
      const path = '/src/store/previewWorkspace/store.ts';
      const { usePreviewWorkspaceStore } = (await import(
        path
      )) as typeof WorkspaceStore;
      return usePreviewWorkspaceStore.getState().workspace;
    });

  await nodes.nth(0).dblclick({ position: { x: 15, y: 15 } });
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page
    .getByRole('button', {
      name: 'Split: create an empty group on the right',
      exact: true,
    })
    .click();
  const strips = page.getByRole('tablist', { name: 'Open previews' });
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(0);
  const split = await snapshot();
  expect(split.activeGroupId).toBe(split.groups[1].id);

  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await expect(
    page.getByText('No preview open in this group', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Double-click a node on the Space to preview it here'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Exit fullscreen', exact: true })
    .click();
  await expect(page.locator('.react-flow')).toBeVisible();

  await page.reload();
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(0);
  expect((await snapshot()).activeGroupId).toBe(split.groups[1].id);
  await page
    .getByRole('button', { name: 'Close empty group', exact: true })
    .click();
  await expect(strips).toHaveCount(1);
  await expect(strips.getByRole('tab')).toHaveCount(1);
  expect((await snapshot()).groups[0].id).toBe(split.groups[0].id);
  await page
    .getByRole('button', {
      name: 'Split: create an empty group on the right',
      exact: true,
    })
    .click();
  await expect(strips).toHaveCount(2);
  await page
    .locator(`.react-flow__node[data-id="${secondId}"]`)
    .dblclick({ position: { x: 15, y: 15 } });
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(1);
  let workspace = await snapshot();
  expect(workspace.tabs[workspace.groups[1].tabIds[0]].target).toMatchObject({
    nodeId: secondId,
  });

  await page
    .locator(`.react-flow__node[data-id="${firstId}"]`)
    .dblclick({ position: { x: 15, y: 15 } });
  workspace = await snapshot();
  expect(workspace.activeGroupId).toBe(workspace.groups[0].id);
  expect(Object.keys(workspace.tabs)).toHaveLength(2);
  await strips.nth(1).getByRole('tab').click({ button: 'right' });
  await page
    .getByRole('menuitem', {
      name: 'Close all tabs in this group',
      exact: true,
    })
    .click();
  await expect(strips).toHaveCount(1);
  await expect(strips.getByRole('tab')).toBeFocused();
  await page
    .getByRole('button', {
      name: 'Split: create an empty group on the right',
      exact: true,
    })
    .click();
  await expect(strips).toHaveCount(2);
  await strips.nth(0).getByRole('tab').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('preview-tab-drag-overlay')).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'was moved over droppable area' }),
  ).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('preview-tab-append-indicator')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(strips.nth(0).getByRole('tab')).toHaveCount(0);
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(1);
  const survivingId = (await snapshot()).groups[1].id;
  const closeEmpty = page.getByRole('button', {
    name: 'Close empty group',
    exact: true,
  });
  await closeEmpty.focus();
  await closeEmpty.press('Enter');
  await expect(strips).toHaveCount(1);
  expect((await snapshot()).groups[0].id).toBe(survivingId);
  await expect(strips.getByRole('tab')).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Close empty group', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'Split: create an empty group on the right',
      exact: true,
    })
    .click();
  await expect(strips).toHaveCount(2);
  await expect(
    page.getByRole('button', {
      name: 'Move tab to the other group',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Merge groups', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tabpanel').nth(1).click();
  await page
    .locator(`.react-flow__node[data-id="${secondId}"]`)
    .dblclick({ position: { x: 15, y: 15 } });
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(1);
  await strips
    .nth(1)
    .getByRole('button', { name: /^Close / })
    .click();
  await expect(strips).toHaveCount(1);
  await expect(strips.getByRole('tab')).toHaveCount(1);

  for (const label of [
    'Close other tabs',
    'Close tabs to the right',
    'Close',
  ]) {
    await page.evaluate(
      async ({ canvasId, nodeId }) => {
        const path = '/src/store/previewWorkspace/store.ts';
        const { usePreviewWorkspaceStore } = (await import(
          path
        )) as typeof WorkspaceStore;
        usePreviewWorkspaceStore.getState().openPreviewTarget({
          kind: 'node',
          canvasId,
          nodeId,
        });
      },
      { canvasId, nodeId: secondId },
    );
    await expect(strips.getByRole('tab')).toHaveCount(2);
    await strips
      .getByRole('tab')
      .nth(label === 'Close' ? 1 : 0)
      .focus();
    await page.keyboard.press('Shift+F10');
    await page
      .getByRole('menuitem', { name: label, exact: true })
      .press('Enter');
    await expect(strips.getByRole('tab')).toHaveCount(1);
    await expect(strips.getByRole('tab')).toBeFocused();
  }
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menuitem', {
      name: 'Close all tabs in this group',
      exact: true,
    })
    .press('Enter');
  await expect(page.locator('[data-center-editor]')).toBeFocused();
});
