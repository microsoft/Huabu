// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { editsPerCommand } from './helpers';

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * A deleted note that undo brings back keeps its body, whatever another page
 * is doing.
 *
 * The batch that deletes a node removes its record on the server; no page
 * sends a request of its own for that. This spec holds one of page B's
 * content saves on the wire while page A deletes a note and undoes the
 * deletion. A page that still unlinked the record itself would do so only
 * after its pending save — that is, after page A's undo had written the
 * record again — and the note would come back empty.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const KEPT = 'node-undo-kept';
const DELETED = 'node-undo-deleted';

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call, as `METHOD <space>/…`. */
  writes: string[];
}

async function seedSpace(request: APIRequestContext): Promise<string> {
  const created = await request.post('/api/canvas', {
    data: { title: 'Delete, undo, body' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const note = (id: string, x: number) => ({
    id,
    nodeType: 'note',
    data: { type: 'note', label: `Label ${id}`, content: `Body of ${id}` },
    selectOnCreate: false,
    position: { x, y: 120 },
    size: { width: 260, height: 160 },
  });
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand([
        { type: 'CREATE_NODES', nodes: [note(KEPT, 380), note(DELETED, 700)] },
      ]),
      originator: { source: 'ui', tabId: 'e2e-delete-undo-body-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function serverNode(
  request: APIRequestContext,
  canvasId: string,
  nodeId: string,
) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    state: { nodes: { id: string; data: Record<string, unknown> }[] };
  };
  return record.state.nodes.find((node) => node.id === nodeId);
}

async function openDevice(browser: Browser, canvasId: string): Promise<Device> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('huabu.language', 'en');
  });
  const page = await context.newPage();
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/canvas/') || request.method() === 'GET') return;
    writes.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${DELETED}"]`)).toBeVisible();
  return { context, page, writes };
}

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

async function shownContent(page: Page, nodeId: string) {
  return page.evaluate(async (nodeId) => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    const node = store.getState().nodes.find((item) => item.id === nodeId);
    return node ? (node.data as { content?: unknown }).content : null;
  }, nodeId);
}

test('a note deleted on one page and restored by its undo keeps its body while the other page has a save on the wire', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId);
  const b = await openDevice(browser, canvasId);
  // Let load-time measurement reports settle.
  await a.page.waitForTimeout(1_500);

  // Page B's save of another note stays on the wire until released.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldSaves = 0;
  await b.page.route(
    `**/api/canvas/${canvasId}/nodes/${KEPT}/content`,
    async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      heldSaves += 1;
      await held;
      await route.continue();
    },
  );
  await act(b.page, 'updateNodeData', KEPT, { content: 'Edited on page B' });
  await expect.poll(() => heldSaves, { timeout: 15_000 }).toBeGreaterThan(0);

  // Page A deletes the note; page B receives the deletion.
  await act(a.page, 'deleteNodes', [DELETED]);
  await expect
    .poll(async () => await serverNode(request, canvasId, DELETED))
    .toBeUndefined();
  await expect(b.page.locator(`[data-id="${DELETED}"]`)).toHaveCount(0);

  // Page A takes the deletion back: the server has the note and its body.
  await act(a.page, 'undo');
  await expect
    .poll(async () => (await serverNode(request, canvasId, DELETED))?.data)
    .toMatchObject({ content: `Body of ${DELETED}` });
  await expect(b.page.locator(`[data-id="${DELETED}"]`)).toBeVisible();

  // Page B's save completes; whatever it was waiting to do, it does now.
  release();
  await expect
    .poll(async () => (await serverNode(request, canvasId, KEPT))?.data)
    .toMatchObject({ content: 'Edited on page B' });
  await b.page.waitForTimeout(2_000);

  // The body is on the server and on both pages.
  expect((await serverNode(request, canvasId, DELETED))?.data).toMatchObject({
    content: `Body of ${DELETED}`,
    label: `Label ${DELETED}`,
  });
  expect(await shownContent(a.page, DELETED)).toBe(`Body of ${DELETED}`);
  expect(await shownContent(b.page, DELETED)).toBe(`Body of ${DELETED}`);

  // A fresh load reads the same body from storage.
  const c = await openDevice(browser, canvasId);
  expect(await shownContent(c.page, DELETED)).toBe(`Body of ${DELETED}`);

  // No page asked the server to unlink the record of a node of this Space.
  const unlinks = [...a.writes, ...b.writes].filter((write) =>
    write.startsWith('DELETE <space>/nodes/'),
  );
  expect(unlinks).toEqual([]);

  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
});
