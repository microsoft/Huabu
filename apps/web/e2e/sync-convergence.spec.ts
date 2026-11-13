// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * Cases where a page used to end up stale, stuck or asking the wrong
 * question, each against the real server with real browser contexts:
 *
 * - closing the page while only a derived report (a renderer-measured box)
 *   is unanswered does not ask "leave site?"; a user's edit does.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-conv-x';
const Y = 'node-conv-y';
const FRAME = 'node-conv-frame';
const TEXT = 'node-conv-text';

interface Device {
  context: BrowserContext;
  page: Page;
  /** `GET /api/canvas/:id` requests: loads of the whole Space. */
  spaceLoads: () => number;
}

async function seedSpace(request: APIRequestContext) {
  const created = await request.post('/api/canvas', {
    data: { title: 'Sync convergence' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const note = (id: string, x: number, y: number) => ({
    id,
    nodeType: 'note',
    data: { type: 'note', label: `Label ${id}`, content: `Body of ${id}` },
    selectOnCreate: false,
    position: { x, y },
    size: { width: 260, height: 160 },
  });
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            note(X, 380, 90),
            note(Y, 380, 320),
            {
              id: FRAME,
              nodeType: 'frame',
              data: { type: 'frame', label: 'Hug frame', sizing: 'hug' },
              selectOnCreate: false,
              position: { x: 720, y: 90 },
              size: { width: 360, height: 220 },
            },
          ],
        },
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: TEXT,
              nodeType: 'text',
              parentId: FRAME,
              data: { type: 'text', content: 'One line' },
              selectOnCreate: false,
              position: { x: 24, y: 64 },
              size: { width: 300 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-sync-convergence-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function newDevice(
  browser: Browser,
  canvasId: string,
): Promise<Device & { open: () => Promise<void> }> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ canvasId }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
    },
    { canvasId },
  );
  const page = await context.newPage();
  let spaceLoads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === `/api/canvas/${canvasId}`
    )
      spaceLoads += 1;
  });
  const open = async () => {
    await page.goto(`/canvas/${canvasId}`);
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(page.locator(`[data-id="${X}"]`)).toBeVisible();
    // A reload replaces the document; this marker proves one did not happen.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
  };
  return { context, page, spaceLoads: () => spaceLoads, open };
}

/** Run one of the store's own actions on the page, as the UI would. */
async function act(
  page: Page,
  action: string,
  ...args: unknown[]
): Promise<unknown> {
  return page.evaluate(
    async ({ action, args }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasStore;
      const fn = (
        store.getState() as unknown as Record<
          string,
          (...values: unknown[]) => unknown
        >
      )[action];
      return fn(...args);
    },
    { action, args },
  );
}

/** Whether closing the page now would ask the browser's "leave site?". */
async function asksBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('closing with only an unanswered measured box does not ask to stay; an unsent edit does', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const device = await newDevice(browser, canvasId);
  // The server never answers a command batch: every batch stays unanswered.
  const held: Route[] = [];
  const batches: string[][] = [];
  await device.context.route('**/api/canvas/*/execute', async (route) => {
    const body = route.request().postDataJSON() as {
      commands: Array<{ type: string }>;
    };
    batches.push(body.commands.map((command) => command.type));
    held.push(route);
  });
  await device.open();

  // The page reports the Text's rendered box on load; nobody did anything.
  await expect.poll(() => batches.flat()).toContain('APPLY_MEASURED_SIZE');
  expect(
    batches.flat().every((type) => type.startsWith('APPLY_MEASURED_')),
  ).toBe(true);
  expect(await asksBeforeLeaving(device.page)).toBe(false);
  // It was still flushed on the way out, best effort.
  await expect.poll(() => batches.length).toBeGreaterThan(1);

  // A change the user made is unsent work.
  await act(device.page, 'updateNodeData', X, { pinned: true });
  expect(await asksBeforeLeaving(device.page)).toBe(true);

  await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
  await device.context.close();
});
