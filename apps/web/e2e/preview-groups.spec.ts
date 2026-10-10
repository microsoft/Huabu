// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as WorkspaceStore from '../src/store/previewWorkspace/store';

test.use({ hasTouch: false, viewport: { width: 1600, height: 1000 } });

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
