// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { editsPerCommand } from './helpers';

import type * as CanvasStore from '../src/store/canvasStore';

for (const failure of ['content', 'structure'] as const) {
  for (const recover of [false, true]) {
    test(`save failure keeps the Space until ${recover ? 'retry succeeds' : 'explicit discard'} (${failure})`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript(() =>
        localStorage.setItem('huabu.language', 'en'),
      );
      const destinationTitle = `Destination B ${failure} ${recover}`;
      const parentResponse = await page.request.post('/api/canvas', {
        data: { title: destinationTitle },
      });
      expect(parentResponse.ok()).toBe(true);
      const parent = (await parentResponse.json()).canvasId as string;
      const childResponse = await page.request.post(
        `/api/canvas/${parent}/children`,
        { data: { title: 'Source A' } },
      );
      expect(childResponse.ok()).toBe(true);
      const child = (await childResponse.json()).canvasId as string;
      const seeded = await page.request.post(`/api/canvas/${child}/execute`, {
        data: {
          edits: editsPerCommand([
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-save-navigation',
                  nodeType: 'text',
                  data: { content: 'Saved text' },
                  position: { x: 100, y: 100 },
                },
              ],
            },
          ]),
          originator: { source: 'ui', tabId: 'e2e-save-navigation' },
        },
      });
      expect(seeded.ok()).toBe(true);
      await page.goto(`/canvas/${child}`);
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const sourceNode = await page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return store
          .getState()
          .nodes.find((node) => node.id === 'node-save-navigation');
      });
      expect(sourceNode).toBeDefined();
      // A body is saved by the per-node content PUT; a structure edit is
      // sent as an execute request. Nothing saves the whole Space.
      const failingRoute = `**/api/canvas/${child}${failure === 'content' ? '/nodes/*/content' : '/execute'}`;
      const failingMethod = failure === 'content' ? 'PUT' : 'POST';
      await page.route(failingRoute, async (route) => {
        if (route.request().method() !== failingMethod) return route.continue();
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Disk unavailable' }),
        });
      });
      await page.evaluate(async (kind) => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        if (kind === 'content') {
          store.setState({
            nodes: store
              .getState()
              .nodes.map((node) =>
                node.id === 'node-save-navigation'
                  ? { ...node, data: { ...node.data, content: 'Unsaved text' } }
                  : node,
              ),
          });
          return;
        }
        // The move a drag commits, through the store's own action.
        store.getState().beginGesture('SET_NODE_GEOMETRY');
        store
          .getState()
          .setNodeGeometry([
            { nodeId: 'node-save-navigation', position: { x: 400, y: 400 } },
          ]);
      }, failure);
      await page
        .getByRole('link', { name: destinationTitle, exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Space could not be saved',
      });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/canvas/${child}$`));
      await expect(
        dialog.getByRole('button', { name: 'Stay in this Space' }),
      ).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath('save-failure-desktop.png'),
      });
      if (failure === 'content') {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          dialog.getByRole('button', { name: 'Discard and leave' }),
        ).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath('save-failure-narrow.png'),
        });
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      await dialog.getByRole('button', { name: 'Stay in this Space' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/canvas/${child}$`));
      if (recover) await page.unroute(failingRoute);
      await page
        .getByRole('link', { name: destinationTitle, exact: true })
        .click();
      if (!recover) {
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Discard and leave' }).click();
      }
      await expect(page).toHaveURL(new RegExp(`/canvas/${parent}$`));
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/canvas/${child}$`));
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const restored = await page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasStore;
        return {
          node: store
            .getState()
            .nodes.find((node) => node.id === 'node-save-navigation'),
          pending: store.getState().pendingContentNodeIds(),
          canUndo: store.getState().canUndo,
        };
      });
      expect(restored.node?.data.content).toBe(
        recover && failure === 'content' ? 'Unsaved text' : 'Saved text',
      );
      expect(restored.node?.position).toEqual(
        recover && failure === 'structure'
          ? { x: 400, y: 400 }
          : sourceNode?.position,
      );
      expect(restored.pending).toEqual([]);
      // The move is a real edit with an undo entry, which a Space keeps
      // across navigation once it is saved; a discard clears it.
      expect(restored.canUndo).toBe(recover && failure === 'structure');
    });
  }
}
