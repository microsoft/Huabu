// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type * as PreviewModule from '../src/components/Panels/PreviewWorkspace/PreviewWorkspace';
import type * as CanvasStoreModule from '../src/store/canvasStore';
import type { CanvasPreviewWorkspace } from '../src/store/previewWorkspace/model';
import type * as WorkspaceStoreModule from '../src/store/previewWorkspace/store';
import type { Page } from '@playwright/test';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';
import type * as RouterModule from 'react-router-dom';

test.use({ hasTouch: false, viewport: { width: 1400, height: 900 } });

async function workspace(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/previewWorkspace/store.ts';
    const { usePreviewWorkspaceStore } = (await import(
      path
    )) as typeof WorkspaceStoreModule;
    return usePreviewWorkspaceStore.getState().workspace;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/setup');
  await page.evaluate(async () => {
    const dependencyUrl = (file: string) => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) =>
          new URL(entry.name).pathname.endsWith(`/deps/${file}.js`),
        );
      if (!resource) throw new Error(`Vite has not loaded ${file}`);
      return resource.name;
    };
    const previewPath =
      '/src/components/Panels/PreviewWorkspace/PreviewWorkspace.tsx';
    const canvasPath = '/src/store/canvasStore.ts';
    const workspacePath = '/src/store/previewWorkspace/store.ts';
    const [
      { default: React },
      { default: ReactDOM },
      { MemoryRouter },
      { PreviewWorkspace },
      { default: canvasStore },
      { usePreviewWorkspaceStore },
    ] = await Promise.all([
      import(dependencyUrl('react')) as Promise<{
        default: typeof ReactModule;
      }>,
      import(dependencyUrl('react-dom_client')) as Promise<{
        default: typeof ReactDOMModule;
      }>,
      import(dependencyUrl('react-router-dom')) as Promise<typeof RouterModule>,
      import(previewPath) as Promise<typeof PreviewModule>,
      import(canvasPath) as Promise<typeof CanvasStoreModule>,
      import(workspacePath) as Promise<typeof WorkspaceStoreModule>,
    ]);
    const canvasId = 'tab-drag-fixture';
    canvasStore.getState()._setStateNoAutosave({
      canvasId,
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `node-${index}`,
        type: 'note',
        position: { x: 0, y: 0 },
        data: {
          label: `Research findings and detailed follow-up actions for this project ${index}`,
          content: `Note ${index}`,
        },
      })),
      edges: [],
    });
    const initialWorkspace: CanvasPreviewWorkspace = {
      tabs: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          `tab-${index}`,
          {
            id: `tab-${index}`,
            target: { kind: 'node', canvasId, nodeId: `node-${index}` },
            transient: false,
            lastActiveSeq: index,
          },
        ]),
      ),
      groups: [
        {
          id: 'left',
          tabIds: ['tab-0', 'tab-1', 'tab-2'],
          activeTabId: 'tab-0',
        },
        {
          id: 'right',
          tabIds: ['tab-3', 'tab-4', 'tab-5'],
          activeTabId: 'tab-3',
        },
      ],
      activeGroupId: 'right',
      splitRatio: 0.5,
      activationSeq: 6,
    };
    usePreviewWorkspaceStore.getState().loadForCanvas(canvasId);
    usePreviewWorkspaceStore.setState({ workspace: initialWorkspace });
    const host = document.createElement('div');
    host.dataset.testid = 'tab-drag-fixture';
    Object.assign(host.style, {
      position: 'fixed',
      top: '80px',
      left: '20px',
      width: '800px',
      height: '700px',
      zIndex: '100',
    });
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(PreviewWorkspace),
      ),
    );
  });
  await expect(
    page.getByTestId('tab-drag-fixture').getByRole('tab'),
  ).toHaveCount(6);
});

test('clipped long-title tabs cannot steal a drop from the visible group', async ({
  page,
}) => {
  const fixture = page.getByTestId('tab-drag-fixture');
  const source = fixture.locator('[data-preview-tab-id="tab-3"]');
  const point = await source.evaluate((tab) => {
    const bounds = tab.getBoundingClientRect();
    const x = bounds.left + 37;
    const y = bounds.top + bounds.height / 2;
    const hiddenTab = document.querySelector('[data-preview-tab-id="tab-2"]');
    const strip = hiddenTab?.closest('[role="tablist"]');
    if (!hiddenTab || !strip) throw new Error('Left tab strip is missing');
    const hiddenBounds = hiddenTab.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();
    return {
      x,
      y,
      clippedTabOverlaps:
        hiddenBounds.left < x &&
        hiddenBounds.right > x + 7 &&
        stripBounds.right < x,
      visibleTarget: document
        .elementFromPoint(x, y)
        ?.closest('[role="tab"]')
        ?.getAttribute('data-preview-tab-id'),
    };
  });
  expect(point.clippedTabOverlaps).toBe(true);
  expect(point.visibleTarget).toBe('tab-3');
  const before = await workspace(page);

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 7, point.y);
  await expect(page.getByTestId('preview-tab-drag-overlay')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('preview-tab-drag-overlay')).toHaveCount(0);
  expect((await workspace(page)).groups).toEqual(before.groups);
});

for (const destination of [
  'same-group',
  'other-group',
  'empty-group',
  'outside-strip',
] as const) {
  test(`pointer drops preserve ${destination} behavior`, async ({ page }) => {
    const fixture = page.getByTestId('tab-drag-fixture');
    if (destination === 'empty-group') {
      await page.evaluate(async () => {
        const path = '/src/store/previewWorkspace/store.ts';
        const { usePreviewWorkspaceStore } = (await import(
          path
        )) as typeof WorkspaceStoreModule;
        const current = usePreviewWorkspaceStore.getState().workspace;
        const tabs = { ...current.tabs };
        for (const id of current.groups[1].tabIds) delete tabs[id];
        usePreviewWorkspaceStore.setState({
          workspace: {
            ...current,
            tabs,
            groups: [
              current.groups[0],
              { ...current.groups[1], tabIds: [], activeTabId: null },
            ],
          },
        });
      });
      await expect(
        fixture.getByRole('tablist').nth(1).getByRole('tab'),
      ).toHaveCount(0);
    }
    const sourceId = destination === 'empty-group' ? 'tab-0' : 'tab-3';
    const source = fixture.locator(`[data-preview-tab-id="${sourceId}"]`);
    const start = await source.boundingBox();
    if (!start) throw new Error('Source tab is missing');
    const target =
      destination === 'empty-group'
        ? fixture.getByRole('tablist').nth(1)
        : destination === 'outside-strip'
          ? fixture.locator('button:has(svg.lucide-plus)').first()
          : fixture.locator(
              `[data-preview-tab-id="${destination === 'same-group' ? 'tab-4' : 'tab-0'}"]`,
            );
    const end = await target.boundingBox();
    if (!end) throw new Error('Drop target is missing');
    const before = await workspace(page);
    await page.mouse.move(start.x + 37, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 44, start.y + start.height / 2);
    await expect(page.getByTestId('preview-tab-drag-overlay')).toBeVisible();
    await page.mouse.move(
      end.x + Math.min(30, end.width / 2),
      end.y + end.height / 2,
    );
    if (destination === 'empty-group') {
      await expect(
        page.getByTestId('preview-tab-append-indicator'),
      ).toBeVisible();
    } else if (destination !== 'outside-strip') {
      await expect(target).toHaveClass(
        destination === 'same-group' ? /after:bg-info/ : /before:bg-info/,
      );
    }
    await page.mouse.up();
    await expect(page.getByTestId('preview-tab-drag-overlay')).toHaveCount(0);
    const groups = (await workspace(page)).groups;
    if (destination === 'same-group') {
      expect(groups[1].tabIds).toEqual(['tab-4', 'tab-3', 'tab-5']);
      expect(groups[0]).toEqual(before.groups[0]);
    } else if (destination === 'other-group') {
      expect(groups[0].tabIds).toEqual(['tab-3', 'tab-0', 'tab-1', 'tab-2']);
      expect(groups[1].tabIds).toEqual(['tab-4', 'tab-5']);
    } else if (destination === 'empty-group') {
      expect(groups[0].tabIds).toEqual(['tab-1', 'tab-2']);
      expect(groups[1].tabIds).toEqual(['tab-0']);
    } else {
      expect(groups).toEqual(before.groups);
    }
  });
}

for (const interruption of ['blur', 'hidden'] as const) {
  for (const activated of [false, true]) {
    test(`${interruption} fully cancels a ${activated ? 'dragging' : 'pending'} pointer sensor`, async ({
      page,
    }) => {
      const fixture = page.getByTestId('tab-drag-fixture');
      const source = fixture.locator('[data-preview-tab-id="tab-3"]');
      const next = fixture.locator('[data-preview-tab-id="tab-1"]');
      const bounds = await source.boundingBox();
      if (!bounds) throw new Error('Source tab is missing');
      const x = bounds.x + 37;
      const y = bounds.y + bounds.height / 2;
      const before = await workspace(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      if (activated) {
        await page.mouse.move(x + 7, y);
        await expect(
          page.getByTestId('preview-tab-drag-overlay'),
        ).toBeVisible();
      }

      await page.evaluate((reason) => {
        if (reason === 'blur') {
          window.dispatchEvent(new Event('blur'));
        } else {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          Reflect.deleteProperty(document, 'visibilityState');
        }
      }, interruption);
      await expect(page.getByTestId('preview-tab-drag-overlay')).toHaveCount(0);
      // Do not send pointerup: a release outside the window never reaches it.
      await page.waitForTimeout(100);
      await page.evaluate(
        ({ x, y }) => {
          document.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              buttons: 0,
              clientX: x + 30,
              clientY: y,
            }),
          );
        },
        { x, y },
      );
      await expect(page.getByTestId('preview-tab-drag-overlay')).toHaveCount(0);
      expect((await workspace(page)).groups).toEqual(before.groups);

      await next.click({ position: { x: 37, y: 14 } });
      await expect(next).toHaveAttribute('aria-selected', 'true');
      expect(
        (await workspace(page)).groups.map((group) => group.tabIds),
      ).toEqual(before.groups.map((group) => group.tabIds));
      await page.mouse.up();
    });
  }
}
