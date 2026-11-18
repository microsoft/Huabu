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
 * Nothing the browser does in normal editing saves the whole Space.
 *
 * Two real browser contexts open the same Space against the real server.
 * Page A edits through every path that used to end in `PUT /api/canvas/:id`:
 * an undo that brings a deleted node back, an undo of a type change, a data
 * key cleared with `undefined`, a renderer-measured Text inside a hug Frame,
 * a read-model hint, and the Space title. Page B holds an undo entry of its
 * own from before those edits.
 *
 * A whole-Space save advanced the version behind the other page's back, so
 * its next update looked like a gap and it loaded the Space again, dropping
 * its undo history. The spec asserts the opposite for every path: page B
 * never fetches the Space after its first load, is never reloaded, shows
 * what page A did, and can still undo its own edit.
 *
 * The second test is the same claim across the two save paths that remain:
 * a body (per-node content save) and a move (command batch) from page A
 * both reach page B, whose undo of its own earlier edit then neither loads
 * the Space nor saves the body it was taken with over page A's.
 *
 * Page A's edits are issued through the store's own actions (the same ones
 * the UI calls); nothing is written to the store directly.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-put-x';
const Y = 'node-put-y';
const Z = 'node-put-z';
const W = 'node-put-w';
const FRAME = 'node-put-frame';
const TEXT = 'node-put-text';

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call, as `METHOD <space>/…`. */
  writes: string[];
  /** `GET /api/canvas/:id` requests: loads of the whole Space. */
  spaceLoads: () => number;
}

interface StoredNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  style?: { width?: number; height?: number };
  data: Record<string, unknown>;
}

async function seedSpace(request: APIRequestContext) {
  const created = await request.post('/api/canvas', {
    data: { title: 'No whole-Space save' },
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
      edits: editsPerCommand([
        {
          type: 'CREATE_NODES',
          nodes: [
            note(X, 380, 90),
            note(Y, 380, 320),
            note(Z, 700, 90),
            note(W, 700, 320),
            {
              id: FRAME,
              nodeType: 'frame',
              data: { type: 'frame', label: 'Hug frame', sizing: 'hug' },
              selectOnCreate: false,
              position: { x: 1020, y: 90 },
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
      ]),
      originator: { source: 'ui', tabId: 'e2e-no-whole-space-save-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function serverRecord(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    title: string | null;
    version: number;
    state: { nodes: StoredNode[] };
  };
  return {
    title: record.title,
    version: record.version,
    ids: record.state.nodes.map((node) => node.id),
    node: (id: string) => record.state.nodes.find((node) => node.id === id),
  };
}

async function openDevice(browser: Browser, canvasId: string): Promise<Device> {
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
  const writes: string[] = [];
  let spaceLoads = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/canvas/')) return;
    if (request.method() === 'GET') {
      if (path === `/api/canvas/${canvasId}`) spaceLoads += 1;
      return;
    }
    writes.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
  });
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
  return { context, page, writes, spaceLoads: () => spaceLoads };
}

/** What the page's store shows, read only. */
async function shown(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store, hasUnsavedCanvasEdits } = (await import(
      path
    )) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      title: state.canvasTitle,
      canUndo: state.canUndo,
      unsaved: hasUnsavedCanvasEdits(),
      reloaded:
        (window as unknown as { __noReload?: boolean }).__noReload !== true,
      nodes: Object.fromEntries(
        state.nodes.map((node) => [
          node.id,
          {
            type: node.type,
            position: node.position,
            height: (node.style as { height?: number } | undefined)?.height,
            data: node.data as Record<string, unknown>,
          },
        ]),
      ),
    };
  });
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

/** Both pages have applied the server's latest version and sent everything. */
async function settled(
  request: APIRequestContext,
  canvasId: string,
  devices: Device[],
) {
  await expect(async () => {
    const { version } = await serverRecord(request, canvasId);
    for (const device of devices) {
      const state = await shown(device.page);
      expect(state.unsaved).toBe(false);
      expect(state.version).toBe(version);
    }
  }).toPass({ timeout: 15_000 });
}

test('edits through every path that used to save the whole Space reach the other page without a reload, and it keeps its undo history', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId);
  const b = await openDevice(browser, canvasId);
  // Both pages report the Text's rendered box once; wait that out.
  await a.page.waitForTimeout(1_500);
  await settled(request, canvasId, [a, b]);
  const loadsA = a.spaceLoads();
  const loadsB = b.spaceLoads();

  // Page B makes an edit of its own: its undo history starts here.
  await act(b.page, 'beginGesture', 'SET_NODE_GEOMETRY');
  await act(b.page, 'setNodeGeometry', [
    { nodeId: Y, position: { x: 380, y: 560 } },
  ]);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Y)?.position)
    .toEqual({ x: 380, y: 560 });
  expect((await shown(b.page)).canUndo).toBe(true);
  await settled(request, canvasId, [a, b]);

  // ── 1. An undo brings a deleted node back, with its body ──────────────
  await act(a.page, 'deleteNodes', [Z]);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).ids)
    .not.toContain(Z);
  await expect(b.page.locator(`[data-id="${Z}"]`)).toHaveCount(0);
  await act(a.page, 'undo');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Z)?.data)
    .toMatchObject({ content: `Body of ${Z}`, label: `Label ${Z}` });
  await expect(b.page.locator(`[data-id="${Z}"]`)).toBeVisible();
  await settled(request, canvasId, [a, b]);
  expect((await shown(b.page)).nodes[Z].data.content).toBe(`Body of ${Z}`);

  // ── 2. A data key is set, then cleared with `undefined` ───────────────
  await act(a.page, 'updateNodeData', X, { pinnedForTest: 'yes' });
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ pinnedForTest: 'yes' });
  await act(a.page, 'updateNodeData', X, { pinnedForTest: undefined });
  await expect
    .poll(async () =>
      Object.keys((await serverRecord(request, canvasId)).node(X)?.data ?? {}),
    )
    .not.toContain('pinnedForTest');
  await settled(request, canvasId, [a, b]);
  expect((await shown(b.page)).nodes[X].data.pinnedForTest).toBeUndefined();

  // ── 3. A type change, undone ──────────────────────────────────────────
  // The action declines while the node is being preprocessed; ask until
  // it takes.
  await expect
    .poll(
      async () => {
        await act(a.page, 'convertNodeType', W, 'text');
        return (await serverRecord(request, canvasId)).node(W)?.type;
      },
      { timeout: 20_000 },
    )
    .toBe('text');
  await settled(request, canvasId, [a, b]);
  expect((await shown(b.page)).nodes[W].type).toBe('text');
  await act(a.page, 'undo');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(W))
    .toMatchObject({ type: 'note', style: { width: 260, height: 160 } });
  await settled(request, canvasId, [a, b]);
  expect((await shown(b.page)).nodes[W]).toMatchObject({
    type: 'note',
    height: 160,
  });

  // ── 4. A Text grows; its hug Frame is laid out around the new box ─────
  const frameBefore = (await serverRecord(request, canvasId)).node(FRAME)?.style
    ?.height;
  await act(a.page, 'updateNodeData', TEXT, {
    content: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'),
  });
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(FRAME)?.style?.height ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThan((frameBefore ?? 0) + 100);
  await settled(request, canvasId, [a, b]);
  const frameAfter = (await serverRecord(request, canvasId)).node(FRAME)?.style
    ?.height;
  expect((await shown(a.page)).nodes[FRAME].height).toBe(frameAfter);

  // ── 5. A read-model hint is shown here and sent nowhere ───────────────
  const versionBeforeHint = (await serverRecord(request, canvasId)).version;
  await act(a.page, 'patchNodeSilent', Y, { contentMissing: true });
  await a.page.waitForTimeout(1_500);
  expect((await shown(a.page)).nodes[Y].data.contentMissing).toBe(true);
  expect((await serverRecord(request, canvasId)).version).toBe(
    versionBeforeHint,
  );
  await act(a.page, 'patchNodeSilent', Y, { contentMissing: false });

  // ── 6. The Space title ────────────────────────────────────────────────
  expect(await act(a.page, 'tryRename', 'canvas', canvasId, 'Renamed')).toBe(
    true,
  );
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).title)
    .toBe('Renamed');
  await expect.poll(async () => (await shown(b.page)).title).toBe('Renamed');
  await settled(request, canvasId, [a, b]);

  // Outlast the old autosave debounce: nothing is sent late.
  await a.page.waitForTimeout(2_500);
  await settled(request, canvasId, [a, b]);

  // Neither page saved the whole Space…
  for (const device of [a, b])
    expect(device.writes).not.toContain('PUT <space>');
  expect(a.writes).toContain('POST <space>/execute');
  expect(a.writes).toContain('PATCH <space>/title');
  // …so neither loaded it again, or was reloaded,
  expect(a.spaceLoads()).toBe(loadsA);
  expect(b.spaceLoads()).toBe(loadsB);
  const finalA = await shown(a.page);
  const finalB = await shown(b.page);
  expect([finalA.reloaded, finalB.reloaded]).toEqual([false, false]);
  // and page B still has, and can use, its own undo entry.
  expect(finalB.canUndo).toBe(true);
  await act(b.page, 'undo');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Y)?.position)
    .toEqual({ x: 380, y: 320 });
  await expect
    .poll(async () => (await shown(a.page)).nodes[Y].position)
    .toEqual({ x: 380, y: 320 });
  expect(b.spaceLoads()).toBe(loadsB);

  await a.context.close();
  await b.context.close();
});

test('a body and a move from page A reach page B without a Space load or a whole-Space save, and B can still undo its own edit without writing the old body back', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId);
  const b = await openDevice(browser, canvasId);
  await a.page.waitForTimeout(1_500);
  await settled(request, canvasId, [a, b]);
  const loadsA = a.spaceLoads();
  const loadsB = b.spaceLoads();
  const bodyA = 'Body written by page A';
  const serverBody = async (id: string) => {
    const content = (await serverRecord(request, canvasId)).node(id)?.data
      .content;
    return typeof content === 'string' ? content.trim() : content;
  };

  // Page B's own edit, made while X still has its first body: the undo
  // entry holds that body.
  await act(b.page, 'beginGesture', 'SET_NODE_GEOMETRY');
  await act(b.page, 'setNodeGeometry', [
    { nodeId: Y, position: { x: 380, y: 560 } },
  ]);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Y)?.position)
    .toEqual({ x: 380, y: 560 });
  await settled(request, canvasId, [a, b]);
  expect((await shown(b.page)).canUndo).toBe(true);
  const bWritesBefore = b.writes.length;

  // Page A rewrites X's body (a per-node content save) and moves Z (a
  // command batch).
  await act(a.page, 'updateNodeData', X, { content: bodyA });
  await act(a.page, 'beginGesture', 'SET_NODE_GEOMETRY');
  await act(a.page, 'setNodeGeometry', [
    { nodeId: Z, position: { x: 700, y: 560 } },
  ]);
  await expect.poll(() => serverBody(X)).toBe(bodyA);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Z)?.position)
    .toEqual({ x: 700, y: 560 });

  // Page B shows both, in the store and on the card.
  await expect
    .poll(async () => {
      const { nodes } = await shown(b.page);
      return [
        String(nodes[X].data.content ?? '').trim(),
        nodes[Z].position,
        nodes[Y].position,
      ];
    })
    .toEqual([bodyA, { x: 700, y: 560 }, { x: 380, y: 560 }]);
  await expect(
    b.page.locator(`.react-flow__node[data-id="${X}"] .ProseMirror`),
  ).toHaveText(bodyA);
  await settled(request, canvasId, [a, b]);

  // Receiving them made B write nothing but presence, and it kept its
  // undo entry.
  await b.page.waitForTimeout(1_500);
  expect(
    b.writes.slice(bWritesBefore).filter((call) => !call.includes('/presence')),
  ).toEqual([]);
  expect((await shown(b.page)).canUndo).toBe(true);

  // B undoes its own move: Y goes back, A's move of Z and A's body stay,
  // and the body the undo entry was taken with is not saved over A's.
  await act(b.page, 'undo');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(Y)?.position)
    .toEqual({ x: 380, y: 320 });
  await settled(request, canvasId, [a, b]);
  await b.page.waitForTimeout(1_500);
  await settled(request, canvasId, [a, b]);
  expect(await serverBody(X)).toBe(bodyA);
  expect((await serverRecord(request, canvasId)).node(Z)?.position).toEqual({
    x: 700,
    y: 560,
  });
  for (const device of [a, b]) {
    const state = await shown(device.page);
    expect(String(state.nodes[X].data.content ?? '').trim()).toBe(bodyA);
    expect(state.nodes[Z].position).toEqual({ x: 700, y: 560 });
    expect(state.nodes[Y].position).toEqual({ x: 380, y: 320 });
    expect(state.reloaded).toBe(false);
    // Neither page saved the whole Space…
    expect(device.writes).not.toContain('PUT <space>');
  }
  expect(b.writes).not.toContain(`PUT <space>/nodes/${X}/content`);
  expect(a.writes).toContain(`PUT <space>/nodes/${X}/content`);
  expect(a.writes).toContain('POST <space>/execute');
  // …and neither loaded it again.
  expect(a.spaceLoads()).toBe(loadsA);
  expect(b.spaceLoads()).toBe(loadsB);

  await a.context.close();
  await b.context.close();
});
