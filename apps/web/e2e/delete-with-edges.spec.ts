// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

import { personEdits } from './helpers';

import type { CreateCanvasResponse, GetCanvasResponse } from '@huabu/shared';

/**
 * Deleting nodes together with the edges between them, as one gesture: a
 * marquee selects two connected notes and their edge, Delete removes all
 * three. The deletion stands on the deleting page, reaches a second page, and
 * is what a reload shows; the server does not refuse it.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-del-x';
const Y = 'node-del-y';
const Z = 'node-del-z';
const REJECTED = /A change could not be applied/;

async function seedSpace(request: APIRequestContext) {
  const created = await request.post('/api/canvas', {
    data: { title: 'Delete with edges' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const note = (id: string, x: number, y: number) => ({
    id,
    nodeType: 'note',
    data: { type: 'note', label: `Label ${id}`, content: `Body of ${id}` },
    position: { x, y },
    size: { width: 220, height: 140 },
  });
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: personEdits([
        {
          type: 'CREATE_NODES',
          nodes: [note(X, 420, 120), note(Y, 420, 340), note(Z, 860, 120)],
        },
        { type: 'CONNECT_NODES', edges: [{ source: X, target: Y }] },
      ]),
      originator: { tabId: 'e2e-delete-with-edges-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function openPage(browser: Browser, canvasId: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ canvasId }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({
          version: 4,
          state: {
            inputModePreference: 'mouse',
            mouseToolPreference: 'select',
          },
        }),
      );
    },
    { canvasId },
  );
  const page = await context.newPage();
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${Z}"]`)).toBeVisible();
  return page;
}

const nodeIds = (page: Page) =>
  page
    .locator('.react-flow__node')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-id')).sort(),
    );

async function serverSpace(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const { state } = (await response.json()) as GetCanvasResponse;
  return {
    nodes: state.nodes.map((node) => node.id).sort(),
    edges: state.edges.length,
  };
}

/** Drag a marquee over both connected notes; the pointer stays down. */
async function dragMarqueeOverBoth(page: Page) {
  const x = await page
    .locator(`.react-flow__node[data-id="${X}"]`)
    .boundingBox();
  const y = await page
    .locator(`.react-flow__node[data-id="${Y}"]`)
    .boundingBox();
  if (!x || !y) throw new Error('The notes are not on the page');
  await page.mouse.move(x.x + x.width + 60, x.y - 40);
  await page.mouse.down();
  await page.mouse.move(y.x + 20, y.y + y.height + 30, { steps: 12 });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
}

/** The commands of every execute request the page sends from now on. */
function sentCommandTypes(page: Page): string[][] {
  const sent: string[][] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/execute'))
      return;
    const body = request.postDataJSON() as {
      edits: { commands: { type: string }[] }[];
    };
    for (const edit of body.edits)
      sent.push(edit.commands.map((command) => command.type));
  });
  return sent;
}

async function expectDeletionStands(
  a: Page,
  b: Page,
  request: APIRequestContext,
  canvasId: string,
) {
  await expect.poll(() => nodeIds(a)).toEqual([Z]);
  await expect.poll(() => nodeIds(b)).toEqual([Z]);
  await expect
    .poll(() => serverSpace(request, canvasId))
    .toEqual({ nodes: [Z], edges: 0 });

  // A refusal would arrive with the answer to the request; give it time.
  await a.waitForTimeout(2_000);
  await expect(a.getByText(REJECTED)).toHaveCount(0);
  expect(await nodeIds(a)).toEqual([Z]);
  expect(await nodeIds(b)).toEqual([Z]);
  await expect(b.locator('.react-flow__edge')).toHaveCount(0);

  await a.reload();
  await expect(a.locator(`[data-id="${Z}"]`)).toBeVisible();
  expect(await nodeIds(a)).toEqual([Z]);
  await expect(a.locator('.react-flow__edge')).toHaveCount(0);
}

test('deleting two connected notes selected by a marquee stands on both pages and after a reload', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openPage(browser, canvasId);
  const b = await openPage(browser, canvasId);
  await expect(b.locator('.react-flow__edge')).toHaveCount(1);

  await dragMarqueeOverBoth(a);
  await a.mouse.up();
  await a.keyboard.press('Delete');
  await expectDeletionStands(a, b, request, canvasId);

  await a.context().close();
  await b.context().close();
});

test('Delete pressed while the marquee is still held deletes the notes and the edge it selected', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openPage(browser, canvasId);
  const b = await openPage(browser, canvasId);
  await expect(b.locator('.react-flow__edge')).toHaveCount(1);
  const sent = sentCommandTypes(a);

  // During the drag the edge is selected in its own right, so Delete names
  // it beside the notes whose deletion already removes it.
  await dragMarqueeOverBoth(a);
  await a.keyboard.press('Delete');
  await a.mouse.up();
  await expectDeletionStands(a, b, request, canvasId);
  // One gesture, one edit, and the edge is removed before the notes are.
  expect(sent).toEqual([['DISCONNECT_EDGES', 'DELETE_NODES']]);

  await a.context().close();
  await b.context().close();
});
