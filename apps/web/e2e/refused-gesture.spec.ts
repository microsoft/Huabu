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
 * A gesture the engine refuses as a whole changes nothing and is not sent,
 * and the person is told why by a hint that goes away by itself. The case
 * here is the group shortcut over a selection that contains a locked note.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-refused-x';
const Y = 'node-refused-y';
const Z = 'node-refused-z';
const ALL = [X, Y, Z];
const LOCKED_GROUP =
  'The selection contains a locked node, so it cannot be grouped into a frame.';

async function seedSpace(request: APIRequestContext) {
  const created = await request.post('/api/canvas', {
    data: { title: 'Refused gesture' },
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
          nodes: [note(X, 420, 120), note(Y, 420, 340), note(Z, 420, 560)],
        },
        { type: 'SET_NODE_LOCKED', items: [{ nodeId: X, locked: true }] },
      ]),
      originator: { tabId: 'e2e-refused-gesture-seed' },
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

async function serverNodes(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const { state } = (await response.json()) as GetCanvasResponse;
  return state.nodes
    .map((node) => `${node.id} in ${node.parentId ?? 'the Space'}`)
    .sort();
}

/** Rubber-band the two notes, top one first, and release. */
async function marquee(page: Page, top: string, bottom: string) {
  const first = await page
    .locator(`.react-flow__node[data-id="${top}"]`)
    .boundingBox();
  const last = await page
    .locator(`.react-flow__node[data-id="${bottom}"]`)
    .boundingBox();
  if (!first || !last) throw new Error('The notes are not on the page');
  await page.mouse.move(first.x + first.width + 60, first.y - 20);
  await page.mouse.down();
  await page.mouse.move(last.x - 40, last.y + last.height + 20, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  // Away from where a toast appears: a toast under the pointer stays.
  await page.mouse.move(first.x + first.width + 200, last.y + last.height);
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

test('grouping a selection that contains a locked note changes nothing, sends nothing and says why in a hint that goes away', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openPage(browser, canvasId);
  const b = await openPage(browser, canvasId);
  const onServer = await serverNodes(request, canvasId);
  const sent = sentCommandTypes(a);
  const hint = a.getByRole('status').filter({ hasText: LOCKED_GROUP });

  await marquee(a, X, Y);
  await a.keyboard.press('ControlOrMeta+g');

  // The person is told once, and nothing was grouped.
  await expect(hint).toHaveCount(1);
  await expect(a.locator('.react-flow__node-frame')).toHaveCount(0);
  expect(await nodeIds(a)).toEqual(ALL);
  await expect(a.locator('.react-flow__node.selected')).toHaveCount(2);

  // The hint leaves by itself; nobody dismisses it.
  await expect(hint).toHaveCount(0, { timeout: 10_000 });

  // Nothing was sent, so the server and the other page are as they were.
  expect(sent).toEqual([]);
  expect(await serverNodes(request, canvasId)).toEqual(onServer);
  expect(await nodeIds(b)).toEqual(ALL);
  await expect(b.locator('.react-flow__node-frame')).toHaveCount(0);
  await expect(b.getByRole('status')).toHaveCount(0);

  // There is nothing to undo: undo leaves the three notes alone.
  await a.keyboard.press('ControlOrMeta+z');
  expect(await nodeIds(a)).toEqual(ALL);
  expect(sent).toEqual([]);

  // The same shortcut over unlocked notes groups them, without a hint.
  await marquee(a, Y, Z);
  await a.keyboard.press('ControlOrMeta+g');
  await expect(a.locator('.react-flow__node-frame')).toHaveCount(1);
  await expect(b.locator('.react-flow__node-frame')).toHaveCount(1);
  await expect(a.getByRole('status')).toHaveCount(0);
  // (The selection the gesture ends with is this page's own and is not sent.)
  expect(sent).toEqual([['CREATE_NODES', 'SET_NODE_PARENT']]);

  await a.context().close();
  await b.context().close();
});
