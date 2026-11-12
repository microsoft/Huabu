// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * Multi-page sync baseline.
 *
 * Two real browser contexts ("devices") open the same Space against the real
 * server, storage, autosave and Canvas Sync stream. Nothing is mocked and no
 * store is written from the test; the store is only *read* for evidence.
 *
 * Cases (a)–(e) are structure edits. They are sent as execute requests and
 * reach the other page live; their tests assert that behaviour.
 *
 * Case (f) is a note body. It is saved by the per-node content request, which
 * does not change the Space version; the other page is told which node was
 * saved, fetches it and shows it. Its tests assert that, and that receiving a
 * body changes nothing else on the receiving page. Titles, an open preview
 * and the one-editor-at-a-time rule are in `content-sync.spec.ts`.
 *
 * Case (g) is the control: a headless execute request. Case (h) takes one
 * page offline while it edits. Case (i) undoes on one page after the other
 * page changed the same node. Case (j) opens two pages on a note whose
 * height neither has measured yet.
 *
 * Timing: a structure edit is sent at once and a body is autosaved shortly
 * after the last change, so every scenario waits on the server record rather
 * than on a clock. "The other page
 * did not change" cannot be observed as an event, so `observeRemote` waits for
 * the other page's sync stream to deliver a frame written after the edit and
 * then keeps sampling for `LIVE_WINDOW_MS`.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const LIVE_WINDOW_MS = 2_000;
const CONFLICT_TOAST = /This Space was modified elsewhere/;

const X = 'node-sync-x';
const Y = 'node-sync-y';
const Z = 'node-sync-z';
const SEED = {
  [X]: { x: 380, y: 90 },
  [Y]: { x: 380, y: 340 },
  [Z]: { x: 820, y: 90 },
} as const;

interface Point {
  x: number;
  y: number;
}

interface ApiCall {
  method: string;
  path: string;
  sentVersion?: number;
  expectRev?: string;
  status?: number;
  response?: string;
}

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call this page made, in order. */
  calls: ApiCall[];
  /** Raw text of everything received on the Canvas Sync stream. */
  syncText: () => string;
}

interface ServerNode {
  id: string;
  position: Point;
  data: { content?: string; style?: { accent?: string } };
}

async function seedSpace(request: APIRequestContext, title: string) {
  const created = await request.post('/api/canvas', { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [X, Y, Z].map((id) => ({
            id,
            nodeType: 'note',
            data: {
              type: 'note',
              label: `Label ${id}`,
              content: `Seed body ${id}`,
            },
            selectOnCreate: false,
            position: SEED[id as keyof typeof SEED],
            size: { width: 300, height: 200 },
          })),
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-multi-page-sync-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function serverRecord(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    version: number;
    state: { nodes: ServerNode[] };
  };
  const nodes = record.state.nodes;
  return {
    version: record.version,
    order: nodes.map((node) => node.id),
    position: (id: string) => nodes.find((node) => node.id === id)?.position,
    node: (id: string) => nodes.find((node) => node.id === id),
  };
}

async function waitForCanvas(page: Page) {
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${X}"]`)).toBeVisible();
}

async function openDevice(
  browser: Browser,
  canvasId: string,
  name: string,
): Promise<Device> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ canvasId }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
      if (!localStorage.getItem('huabu-sketch-tools')) {
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
      }
    },
    { canvasId },
  );
  const page = await context.newPage();

  const calls: ApiCall[] = [];
  const pending = new Map<unknown, ApiCall>();
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' || !path.startsWith('/api/canvas/')) return;
    let body: { version?: number; expectRev?: string } = {};
    try {
      body = JSON.parse(request.postData() ?? '{}');
    } catch {
      // Non-JSON bodies carry no version.
    }
    const call: ApiCall = {
      method: request.method(),
      path: path.replace(`/api/canvas/${canvasId}`, '<space>'),
      ...(typeof body.version === 'number'
        ? { sentVersion: body.version }
        : {}),
      ...(typeof body.expectRev === 'string'
        ? { expectRev: body.expectRev.slice(0, 8) }
        : {}),
    };
    calls.push(call);
    pending.set(request, call);
  });
  page.on('response', async (response) => {
    const call = pending.get(response.request());
    if (!call) return;
    call.status = response.status();
    call.response = (await response.text().catch(() => '')).slice(0, 200);
  });

  // The sync stream is a long-lived fetch; CDP is the only way to read what
  // actually arrived on it without touching the page's own reader.
  let syncText = '';
  const streams = new Set<string>();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const decode = (data: string) => Buffer.from(data, 'base64').toString('utf8');
  cdp.on('Network.requestWillBeSent', (event) => {
    if (event.request.url.includes('/sync/stream'))
      streams.add(event.requestId);
  });
  cdp.on('Network.responseReceived', (event) => {
    if (!streams.has(event.requestId)) return;
    cdp
      .send('Network.streamResourceContent', { requestId: event.requestId })
      .then((result) => {
        syncText += decode(result.bufferedData);
      })
      .catch(() => {});
  });
  cdp.on('Network.dataReceived', (event) => {
    if (streams.has(event.requestId) && event.data)
      syncText += decode(event.data);
  });

  await page.goto(`/canvas/${canvasId}`);
  await waitForCanvas(page);
  // A reload replaces the document; this marker proves one did not happen.
  await page.evaluate(() => {
    (
      window as unknown as { __syncBaselineLoaded: boolean }
    ).__syncBaselineLoaded = true;
  });
  return { name, context, page, calls, syncText: () => syncText };
}

async function storeState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      canUndo: state.canUndo,
      order: state.nodes.map((node) => node.id),
      selected: state.nodes
        .filter((node) => node.selected)
        .map((node) => node.id),
      content: Object.fromEntries(
        state.nodes.map((node) => [
          node.id,
          (node.data as { content?: string }).content,
        ]),
      ),
      pendingContent: state.pendingContentNodeIds(),
    };
  });
}

/** Rendered position of a node, or null when it is not on the page. */
async function domPosition(page: Page, id: string): Promise<Point | null> {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${id}"]`,
    );
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
      element?.style.transform ?? '',
    );
    return match
      ? { x: Math.round(Number(match[1])), y: Math.round(Number(match[2])) }
      : null;
  }, id);
}

async function domNodeIds(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.react-flow__node'))
      .map((element) => element.getAttribute('data-id') ?? '')
      .sort(),
  );
}

async function viewport(page: Page) {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>('.react-flow__viewport')?.style
        .transform ?? '',
  );
}

async function wasReloaded(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __syncBaselineLoaded?: boolean })
        .__syncBaselineLoaded !== true,
  );
}

/** Both pages have loaded the same version and nothing is waiting to save. */
async function settle(
  request: APIRequestContext,
  canvasId: string,
  devices: Device[],
) {
  // Outlast one autosave debounce so a load-time save would have been sent.
  await devices[0].page.waitForTimeout(1_300);
  await expect(async () => {
    const { version } = await serverRecord(request, canvasId);
    for (const device of devices) {
      const state = await storeState(device.page);
      expect(state.version, `${device.name} version`).toBe(version);
    }
  }).toPass();
  for (const device of devices) device.calls.length = 0;
}

async function openBoth(
  browser: Browser,
  request: APIRequestContext,
  title: string,
) {
  const canvasId = await seedSpace(request, title);
  const a = await openDevice(browser, canvasId, 'A');
  const b = await openDevice(browser, canvasId, 'B');
  await settle(request, canvasId, [a, b]);
  return { canvasId, a, b };
}

async function closeBoth(...devices: Device[]) {
  for (const device of devices) await device.context.close();
}

/**
 * What `device` shows once the edit has had every chance to arrive: wait for
 * a sync frame newer than `syncMark`, then sample until the value leaves
 * `before` or the live window closes.
 */
async function observeRemote<T>(
  device: Device,
  syncMark: number,
  before: T,
  read: () => Promise<T>,
) {
  const frameArrived = await expect
    .poll(() => frameTypes(device.syncText().slice(syncMark)).length, {
      timeout: 3_000,
    })
    .toBeGreaterThan(0)
    .then(
      () => true,
      () => false,
    );
  const deadline = Date.now() + LIVE_WINDOW_MS;
  let value = await read();
  while (
    JSON.stringify(value) === JSON.stringify(before) &&
    Date.now() < deadline
  ) {
    await device.page.waitForTimeout(100);
    value = await read();
  }
  return {
    value,
    frameArrived,
    frames: frameTypes(device.syncText().slice(syncMark)),
  };
}

function frameTypes(text: string) {
  return Array.from(
    text.matchAll(/^event: (snapshot|update|invalidate)$/gm),
    (match) => match[1],
  );
}

async function reloadAndRead<T>(device: Device, read: () => Promise<T>) {
  await device.page.reload();
  await waitForCanvas(device.page);
  return read();
}

async function selectNode(page: Page, id: string) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await node.click({ position: { x: 150, y: 12 } });
  await expect(node).toHaveClass(/selected/);
}

async function dragNode(page: Page, id: string, dx: number, dy: number) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const rect = await node.boundingBox();
  if (!rect) throw new Error(`Node ${id} is not visible`);
  const start = { x: rect.x + rect.width / 2, y: rect.y + 12 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 });
  await page.mouse.up();
  const moved = await domPosition(page, id);
  if (!moved) throw new Error(`Node ${id} disappeared while dragging`);
  expect(moved.x, `${id} moved on the dragging page`).toBeGreaterThan(
    SEED[id as keyof typeof SEED].x + dx / 2,
  );
  return moved;
}

async function waitForServerPosition(
  request: APIRequestContext,
  canvasId: string,
  id: string,
  position: Point,
) {
  await expect
    .poll(
      async () => {
        const saved = (await serverRecord(request, canvasId)).position(id);
        return saved && { x: Math.round(saved.x), y: Math.round(saved.y) };
      },
      { message: `${id} saved at ${JSON.stringify(position)}` },
    )
    .toEqual(position);
}

async function editBody(page: Page, id: string, body: string) {
  await selectNode(page, id);
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  const editor = page.locator(
    '[data-search-scope="node"] .ProseMirror[contenteditable="true"]',
  );
  await expect(editor).toHaveCount(1);
  await editor.fill(body);
  // Closing the preview tab returns the page to the plain Canvas.
  await page
    .getByRole('tab', { selected: true })
    .getByRole('button', { name: /^Close / })
    .click();
  await expect(editor).toHaveCount(0);
}

async function serverBody(
  request: APIRequestContext,
  canvasId: string,
  id: string,
) {
  return (await serverRecord(request, canvasId)).node(id)?.data.content?.trim();
}

/** Rendered body text of a note card on the Canvas. */
async function domBody(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      document
        .querySelector(`.react-flow__node[data-id="${id}"] .ProseMirror`)
        ?.textContent?.trim() ?? null,
    id,
  );
}

async function evidence(testInfo: TestInfo, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  await testInfo.attach('evidence', { body, contentType: 'application/json' });
  if (process.env.E2E_SYNC_EVIDENCE)
    console.log(`EVIDENCE ${testInfo.title}\n${body}`);
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

/** (a) A drags a free node. */
async function moveScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync move');
  await selectNode(b.page, Y);
  const bBefore = {
    viewport: await viewport(b.page),
    selected: (await storeState(b.page)).selected,
  };
  const mark = b.syncText().length;
  const moved = await dragNode(a.page, X, 120, 0);
  await waitForServerPosition(request, canvasId, X, moved);
  const live = await observeRemote(b, mark, SEED[X] as Point, async () =>
    domPosition(b.page, X),
  );
  const result = {
    moved,
    aCalls: [...a.calls],
    bLive: live.value,
    bFrames: live.frames,
    bFrameArrived: live.frameArrived,
    bConflictToast: await b.page.getByText(CONFLICT_TOAST).count(),
    bReloaded: await wasReloaded(b.page),
    bViewportKept: (await viewport(b.page)) === bBefore.viewport,
    bSelectionKept:
      JSON.stringify((await storeState(b.page)).selected) ===
      JSON.stringify(bBefore.selected),
    bAfterReload: await reloadAndRead(b, () => domPosition(b.page, X)),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (b) A creates a node from the toolbar. */
async function createScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync create');
  const mark = b.syncText().length;
  await a.page.getByRole('button', { name: /^Note \(/ }).click();
  await expect(a.page.locator('.canvas-pending-note')).toBeVisible();
  await a.page.mouse.click(900, 560);
  await expect(a.page.locator('.react-flow__node')).toHaveCount(4);
  await a.page.keyboard.press('Escape');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).order.length)
    .toBe(4);
  const live = await observeRemote(b, mark, 3, async () =>
    b.page.locator('.react-flow__node').count(),
  );
  const result = {
    aCalls: [...a.calls],
    bLiveCount: live.value,
    bFrames: live.frames,
    bReloaded: await wasReloaded(b.page),
    bCountAfterReload: await reloadAndRead(b, () =>
      b.page.locator('.react-flow__node').count(),
    ),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (b) A deletes a node with the keyboard. */
async function deleteScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync delete');
  const mark = b.syncText().length;
  await selectNode(a.page, Z);
  await a.page.locator('[data-canvas-root]').focus();
  await a.page.keyboard.press('Delete');
  await expect(a.page.locator(`[data-id="${Z}"]`)).toHaveCount(0);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).order)
    .toEqual([X, Y]);
  const all = [X, Y, Z].sort();
  const live = await observeRemote(b, mark, all, () => domNodeIds(b.page));
  const result = {
    aCalls: [...a.calls],
    bLiveIds: live.value,
    bFrames: live.frames,
    bReloaded: await wasReloaded(b.page),
    bIdsAfterReload: await reloadAndRead(b, () => domNodeIds(b.page)),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

async function accent(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      document
        .querySelector<HTMLElement>(`[data-node-surface="${id}"]`)
        ?.style.getPropertyValue('--note-surface-background') ?? null,
    id,
  );
}

/** (c) A changes a note's accent colour from the node toolbar. */
async function styleScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync style');
  const before = await accent(b.page, X);
  const savedBefore = (await serverRecord(request, canvasId)).node(X)?.data
    .style?.accent;
  const mark = b.syncText().length;
  await selectNode(a.page, X);
  await a.page
    .getByRole('button', { name: 'Accent color', exact: true })
    .click();
  await a.page.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect.poll(() => accent(a.page, X)).not.toBe(before);
  const applied = await accent(a.page, X);
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(X)?.data.style?.accent,
    )
    .not.toBe(savedBefore);
  const live = await observeRemote(b, mark, before, () => accent(b.page, X));
  const result = {
    before,
    applied,
    savedAccent: (await serverRecord(request, canvasId)).node(X)?.data.style
      ?.accent,
    aCalls: [...a.calls],
    bLive: live.value,
    bFrames: live.frames,
    bReloaded: await wasReloaded(b.page),
    bAfterReload: await reloadAndRead(b, () => accent(b.page, X)),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (d) A sends a node backward in the layer order with the `[` shortcut. */
async function layerScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync layers');
  const before = (await storeState(b.page)).order;
  const mark = b.syncText().length;
  await selectNode(a.page, Z);
  await a.page.locator('[data-canvas-root]').focus();
  await a.page.keyboard.press('[');
  await expect
    .poll(async () => (await storeState(a.page)).order)
    .not.toEqual(before);
  const applied = (await storeState(a.page)).order;
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).order)
    .toEqual(applied);
  const live = await observeRemote(
    b,
    mark,
    before,
    async () => (await storeState(b.page)).order,
  );
  const result = {
    before,
    applied,
    aCalls: [...a.calls],
    bLive: live.value,
    bFrames: live.frames,
    bReloaded: await wasReloaded(b.page),
    bAfterReload: await reloadAndRead(
      b,
      async () => (await storeState(b.page)).order,
    ),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (e) A moves X, then B, without reloading, moves a different node Y. */
async function twoWriterScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync writers');
  const bViewport = await viewport(b.page);
  const xMoved = await dragNode(a.page, X, 120, 0);
  await waitForServerPosition(request, canvasId, X, xMoved);
  const afterA = await serverRecord(request, canvasId);

  // A structure edit is sent as an execute request, not a whole-Space save.
  const bSave = b.page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/canvas/${canvasId}/execute`,
  );
  const aMark = a.syncText().length;
  const yMoved = await dragNode(b.page, Y, 120, 0);
  const bSaveResponse = await bSave;
  const bSaveStatus = bSaveResponse.status();
  const bSaveBody = await bSaveResponse.text();
  // Give B a full debounce to retry or recover on its own before sampling.
  await b.page.waitForTimeout(1_500);
  const aLive = await observeRemote(a, aMark, SEED[Y] as Point, () =>
    domPosition(a.page, Y),
  );
  const afterB = await serverRecord(request, canvasId);
  const bState = await storeState(b.page);
  const toast = b.page.getByText(CONFLICT_TOAST);
  const result = {
    xMoved,
    yMoved,
    aCalls: [...a.calls],
    bCalls: [...b.calls],
    bSaveStatus,
    bSaveBody,
    serverVersionAfterA: afterA.version,
    serverVersionAfterB: afterB.version,
    serverX: afterB.position(X),
    serverY: afterB.position(Y),
    bShowsX: await domPosition(b.page, X),
    bShowsY: await domPosition(b.page, Y),
    aShowsY: aLive.value,
    bConflictToast: await toast.count(),
    bSelected: bState.selected,
    bReloadedBeforeChoice: await wasReloaded(b.page),
    bViewportKept: (await viewport(b.page)) === bViewport,
    // Filled in below when the conflict toast offers a reload.
    afterReloadChoice: null as null | {
      bShowsX: Point | null;
      bShowsY: Point | null;
      serverY: Point | undefined;
    },
  };
  if (result.bConflictToast > 0) {
    // The only recovery the product offers B.
    await b.page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => wasReloaded(b.page)).toBe(true);
    await waitForCanvas(b.page);
    await b.page.waitForTimeout(1_500);
    result.afterReloadChoice = {
      bShowsX: await domPosition(b.page, X),
      bShowsY: await domPosition(b.page, Y),
      serverY: (await serverRecord(request, canvasId)).position(Y),
    };
  }
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (f) A edits a note body; B then edits a different note and moves a node. */
async function bodyScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync body');
  const versionBefore = (await serverRecord(request, canvasId)).version;
  const bodyA = 'Body written by page A';
  const bodyB = 'Body written by page B';
  const before = await domBody(b.page, X);
  // What B is doing when the body arrives: Z selected, its own viewport.
  await selectNode(b.page, Z);
  const bViewportBefore = await viewport(b.page);
  const bCallsBeforeA = b.calls.length;
  const mark = b.syncText().length;
  await editBody(a.page, X, bodyA);
  await expect.poll(() => serverBody(request, canvasId, X)).toBe(bodyA);
  // Let A finish any structure save that follows the content save.
  await expect
    .poll(async () => (await storeState(a.page)).pendingContent)
    .toEqual([]);
  await a.page.waitForTimeout(1_300);
  const versionAfterA = (await serverRecord(request, canvasId)).version;
  const live = await observeRemote(b, mark, before, () => domBody(b.page, X));
  const bStateLive = await storeState(b.page);
  const bStoreLive = bStateLive.content[X];
  const bReloadedLive = await wasReloaded(b.page);
  // Everything B sent while it received the body, presence reports aside.
  const bCallsWhileReceiving = b.calls
    .slice(bCallsBeforeA)
    .filter((call) => !call.path.startsWith('<space>/presence'));
  const bViewportLive = await viewport(b.page);

  // B, still not reloaded, edits a different note.
  const bCallsBefore = b.calls.length;
  await editBody(b.page, Y, bodyB);
  await expect
    .poll(() => b.calls.slice(bCallsBefore).some((call) => call.status))
    .toBe(true);
  await b.page.waitForTimeout(1_500);
  const afterBodyB = await serverRecord(request, canvasId);
  const bodyCalls = b.calls.slice(bCallsBefore);
  const bToastAfterBody = await b.page.getByText(CONFLICT_TOAST).count();

  // B then makes a structural edit from its stale scene.
  const moveCallsBefore = b.calls.length;
  const yMoved = await dragNode(b.page, Y, 120, 0);
  await expect
    .poll(() =>
      b.calls
        .slice(moveCallsBefore)
        .some((call) => call.path === '<space>/execute' && call.status),
    )
    .toBe(true);
  await b.page.waitForTimeout(1_500);
  const afterMove = await serverRecord(request, canvasId);
  const result = {
    before,
    versionBefore,
    versionAfterA,
    aCalls: [...a.calls],
    bLiveDom: live.value,
    bLiveStore: bStoreLive,
    bFrames: live.frames,
    bReloadedLive,
    bSelectedLive: bStateLive.selected,
    bCanUndoLive: bStateLive.canUndo,
    bPendingContentLive: bStateLive.pendingContent,
    bViewportKept: bViewportLive === bViewportBefore,
    bCallsWhileReceiving,
    bBodyCalls: bodyCalls,
    bToastAfterBody,
    serverBodyX: afterBodyB.node(X)?.data.content?.trim(),
    serverBodyY: afterBodyB.node(Y)?.data.content?.trim(),
    versionAfterBodyB: afterBodyB.version,
    yMoved,
    bMoveCalls: b.calls.slice(moveCallsBefore),
    serverYAfterMove: afterMove.position(Y),
    serverBodyYAfterMove: afterMove.node(Y)?.data.content?.trim(),
    versionAfterMove: afterMove.version,
    serverBodyXAfterMove: afterMove.node(X)?.data.content?.trim(),
    bToastAfterMove: await b.page.getByText(CONFLICT_TOAST).count(),
    aShowsBodyY: (await storeState(a.page)).content[Y],
    bDomAfterReload: await reloadAndRead(b, () => domBody(b.page, X)),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (f) A edits a note body; B then edits the same note from its stale copy. */
async function sameBodyScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync same body');
  const bodyA = 'Body written by page A';
  const bodyB = 'Body written by page B';
  const mark = b.syncText().length;
  await editBody(a.page, X, bodyA);
  await expect.poll(() => serverBody(request, canvasId, X)).toBe(bodyA);
  await expect
    .poll(async () => (await storeState(a.page)).pendingContent)
    .toEqual([]);
  // B gets the same chance to catch up as in every other case.
  await observeRemote(b, mark, await domBody(b.page, X), () =>
    domBody(b.page, X),
  );
  const callsBefore = b.calls.length;
  await editBody(b.page, X, bodyB);
  await expect
    .poll(() => b.calls.slice(callsBefore).some((call) => call.status))
    .toBe(true);
  await b.page.waitForTimeout(1_500);
  const result = {
    bCalls: b.calls.slice(callsBefore),
    serverBodyX: await serverBody(request, canvasId, X),
    bShowsBody: await domBody(b.page, X),
    bConflictActions: await b.page
      .getByRole('button', { name: /^(Keep mine|Load latest)$/ })
      .allTextContents(),
    bReloaded: await wasReloaded(b.page),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

/** (g) Control: a headless `/execute` write moves a node. */
async function executeScenario(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync execute');
  await selectNode(b.page, Y);
  const bViewport = await viewport(b.page);
  const marks = { a: a.syncText().length, b: b.syncText().length };
  const destination = { x: 600, y: 420 };
  const moved = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: X, position: destination }],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-multi-page-sync-execute' },
    },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  const aLive = await observeRemote(a, marks.a, SEED[X] as Point, () =>
    domPosition(a.page, X),
  );
  const bLive = await observeRemote(b, marks.b, SEED[X] as Point, () =>
    domPosition(b.page, X),
  );
  const serverVersion = (await serverRecord(request, canvasId)).version;
  const result = {
    destination,
    aLive: aLive.value,
    bLive: bLive.value,
    aFrames: aLive.frames,
    bFrames: bLive.frames,
    serverVersion,
    aVersion: (await storeState(a.page)).version,
    bVersion: (await storeState(b.page)).version,
    reloaded: [await wasReloaded(a.page), await wasReloaded(b.page)],
    bSelected: (await storeState(b.page)).selected,
    bViewportKept: (await viewport(b.page)) === bViewport,
    toasts:
      (await a.page.getByText(CONFLICT_TOAST).count()) +
      (await b.page.getByText(CONFLICT_TOAST).count()),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);
  return result;
}

// ─── (a) move ───────────────────────────────────────────────────────────────

test('(a) a node dragged on page A moves on page B without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await moveScenario(browser, request, testInfo);
  expect(result.bLive).toEqual(result.moved);
  expect(result.bReloaded).toBe(false);
  expect(result.bConflictToast).toBe(0);
  expect(result.bViewportKept).toBe(true);
  expect(result.bSelectionKept).toBe(true);
});

// ─── (b) create / delete ────────────────────────────────────────────────────

test('(b) a node created on page A appears on page B without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await createScenario(browser, request, testInfo);
  expect(result.bLiveCount).toBe(4);
  expect(result.bReloaded).toBe(false);
});

test('(b) a node deleted on page A disappears from page B without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await deleteScenario(browser, request, testInfo);
  expect(result.bLiveIds).toEqual([X, Y].sort());
  expect(result.bReloaded).toBe(false);
});

// ─── (c) style ──────────────────────────────────────────────────────────────

test('(c) an accent colour chosen on page A shows on page B without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await styleScenario(browser, request, testInfo);
  expect(result.bLive).toBe(result.applied);
  expect(result.bReloaded).toBe(false);
});

// ─── (d) layer order ────────────────────────────────────────────────────────

test('(d) a layer-order change on page A shows on page B without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await layerScenario(browser, request, testInfo);
  expect(result.bLive).toEqual(result.applied);
  expect(result.bReloaded).toBe(false);
});

// ─── (e) two writers, different nodes ───────────────────────────────────────

test('(e) moves of different nodes from page A and page B are both saved and shown on both pages', async ({
  browser,
  request,
}, testInfo) => {
  const result = await twoWriterScenario(browser, request, testInfo);
  expect(result.serverX).toEqual(result.xMoved);
  expect(result.serverY).toEqual(result.yMoved);
  expect(result.bShowsX).toEqual(result.xMoved);
  expect(result.bShowsY).toEqual(result.yMoved);
  expect(result.aShowsY).toEqual(result.yMoved);
  expect(result.bConflictToast).toBe(0);
  expect(result.bReloadedBeforeChoice).toBe(false);
  expect(result.bViewportKept).toBe(true);
  expect(result.bSelected).toEqual([Y]);
});

// ─── (h) offline ────────────────────────────────────────────────────────────

test('(h) an edit made offline stays on screen, is flagged as unsynced and is sent when the connection returns', async ({
  browser,
  request,
}, testInfo) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync offline');
  const unsynced = a.page.getByText(/not synced yet/);
  const mark = b.syncText().length;

  await a.context.setOffline(true);
  const moved = await dragNode(a.page, X, 120, 0);
  await expect(unsynced).toBeVisible();
  const whileOffline = {
    server: (await serverRecord(request, canvasId)).position(X),
    aShows: await domPosition(a.page, X),
  };

  await a.context.setOffline(false);
  await waitForServerPosition(request, canvasId, X, moved);
  await expect(unsynced).toHaveCount(0);
  const live = await observeRemote(b, mark, SEED[X] as Point, () =>
    domPosition(b.page, X),
  );
  const result = {
    moved,
    whileOffline,
    executeCalls: a.calls
      .filter((call) => call.path === '<space>/execute')
      .map((call) => call.status),
    aShows: await domPosition(a.page, X),
    bLive: live.value,
    aReloaded: await wasReloaded(a.page),
    serverVersion: (await serverRecord(request, canvasId)).version,
    aVersion: (await storeState(a.page)).version,
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);

  expect(result.whileOffline.server).toEqual(SEED[X]);
  expect(result.whileOffline.aShows).toEqual(moved);
  expect(result.aShows).toEqual(moved);
  expect(result.bLive).toEqual(moved);
  expect(result.aReloaded).toBe(false);
  // Sent more than once, executed once.
  expect(result.executeCalls.length).toBeGreaterThan(1);
  expect(result.executeCalls.at(-1)).toBe(200);
  expect(result.aVersion).toBe(result.serverVersion);
});

// ─── (i) undo ───────────────────────────────────────────────────────────────

test('(i) undo on page A takes back its own move and keeps the colour page B chose since', async ({
  browser,
  request,
}, testInfo) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Sync undo');
  const savedAccent = async () =>
    (await serverRecord(request, canvasId)).node(X)?.data.style?.accent;
  const accentBefore = await savedAccent();

  // A moves X; B, once it shows the move, recolours X.
  let mark = b.syncText().length;
  const moved = await dragNode(a.page, X, 120, 0);
  await waitForServerPosition(request, canvasId, X, moved);
  await observeRemote(b, mark, SEED[X] as Point, () => domPosition(b.page, X));
  mark = a.syncText().length;
  const aAccentBefore = await accent(a.page, X);
  await selectNode(b.page, X);
  await b.page
    .getByRole('button', { name: 'Accent color', exact: true })
    .click();
  await b.page.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect.poll(savedAccent).not.toBe(accentBefore);
  const blue = await accent(b.page, X);
  await observeRemote(a, mark, aAccentBefore, () => accent(a.page, X));

  // A undoes. Its history holds the move, not B's recolour.
  a.calls.length = 0;
  mark = b.syncText().length;
  await a.page.locator('[data-canvas-root]').focus();
  await a.page.keyboard.press('ControlOrMeta+z');
  await waitForServerPosition(request, canvasId, X, SEED[X]);
  const bLive = await observeRemote(b, mark, moved, () =>
    domPosition(b.page, X),
  );
  const result = {
    moved,
    blue,
    aCalls: [...a.calls],
    aShows: await domPosition(a.page, X),
    aAccent: await accent(a.page, X),
    bShows: bLive.value,
    bAccent: await accent(b.page, X),
    savedAccentChanged: (await savedAccent()) !== accentBefore,
    reloaded: [await wasReloaded(a.page), await wasReloaded(b.page)],
    toasts:
      (await a.page.getByText(CONFLICT_TOAST).count()) +
      (await b.page.getByText(CONFLICT_TOAST).count()),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);

  expect(result.aShows).toEqual(SEED[X]);
  expect(result.bShows).toEqual(SEED[X]);
  expect(result.aAccent).toBe(blue);
  expect(result.bAccent).toBe(blue);
  expect(result.savedAccentChanged).toBe(true);
  // Sent as a command, not as a whole-Space save.
  expect(result.aCalls.map((call) => call.path)).toContain('<space>/execute');
  expect(result.aCalls.map((call) => call.path)).not.toContain('<space>');
  expect(result.reloaded).toEqual([false, false]);
  expect(result.toasts).toBe(0);
});

// ─── (j) measured heights ───────────────────────────────────────────────────

test('(j) two pages that measure the same auto-height note report it once and do not save over each other', async ({
  browser,
  request,
}, testInfo) => {
  const AUTO = 'node-sync-auto';
  const canvasId = await seedSpace(request, 'Sync heights');
  // An auto-height note nobody has rendered yet: it has no measured height.
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: AUTO,
              nodeType: 'note',
              data: {
                type: 'note',
                label: 'Auto',
                content: Array.from(
                  { length: 12 },
                  (_, line) =>
                    `Line ${line + 1} of a body tall enough to need measuring.`,
                ).join('\n\n'),
              },
              selectOnCreate: false,
              position: { x: 820, y: 340 },
              size: { width: 300, height: 'auto' },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-multi-page-sync-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const saved = async () => {
    const node = (await serverRecord(request, canvasId)).node(AUTO) as
      | (ServerNode & {
          style?: { height?: number };
          data: { autoHeight?: { measuredFor?: string } };
        })
      | undefined;
    return {
      height: node?.style?.height,
      measuredFor: node?.data.autoHeight?.measuredFor,
    };
  };
  const before = await saved();

  const a = await openDevice(browser, canvasId, 'A');
  const b = await openDevice(browser, canvasId, 'B');
  // Both pages measured on load; wait until the server has a measurement
  // and both pages have caught up with it.
  await expect.poll(async () => (await saved()).measuredFor).toBeTruthy();
  await a.page.waitForTimeout(2_500);
  await expect(async () => {
    const { version } = await serverRecord(request, canvasId);
    for (const device of [a, b]) {
      const state = await storeState(device.page);
      expect(state.version, `${device.name} version`).toBe(version);
    }
  }).toPass();
  const shown = (page: Page) =>
    page.evaluate(
      (id) =>
        document
          .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
          ?.getBoundingClientRect().height ?? null,
      AUTO,
    );
  const after = await saved();
  const result = {
    before,
    after,
    aCalls: [...a.calls],
    bCalls: [...b.calls],
    aShows: await shown(a.page),
    bShows: await shown(b.page),
    reloaded: [await wasReloaded(a.page), await wasReloaded(b.page)],
    toasts:
      (await a.page.getByText(CONFLICT_TOAST).count()) +
      (await b.page.getByText(CONFLICT_TOAST).count()),
  };
  await evidence(testInfo, result);
  await closeBoth(a, b);

  const paths = [...result.aCalls, ...result.bCalls].map((call) => call.path);
  // The measurement is reported as a command; no page saves the whole Space.
  expect(paths).toContain('<space>/execute');
  expect(paths).not.toContain('<space>');
  expect(result.after.measuredFor).toBeTruthy();
  expect(result.after.height).not.toBe(result.before.height);
  expect(result.aShows).toBe(result.after.height);
  expect(result.bShows).toBe(result.after.height);
  expect(result.toasts).toBe(0);
  expect(result.reloaded).toEqual([false, false]);
});

// ─── (f) note body ──────────────────────────────────────────────────────────

test('(f) a note body edited on page A shows on page B without a reload, and B keeps editing other notes and moving nodes', async ({
  browser,
  request,
}, testInfo) => {
  const result = await bodyScenario(browser, request, testInfo);
  const bodyA = 'Body written by page A';
  const bodyB = 'Body written by page B';
  // A body save is a per-node write: the Space version does not move, and B
  // is told which node was saved rather than sent an update.
  expect(result.versionAfterA).toBe(result.versionBefore);
  expect(result.bFrames).toContain('invalidate');
  expect(result.bFrames).not.toContain('update');
  // B's card and store show A's body, and the page was not reloaded.
  expect(result.bLiveDom).toBe(bodyA);
  expect(result.bLiveStore?.trim()).toBe(bodyA);
  expect(result.bReloadedLive).toBe(false);
  // Receiving it changed nothing else on B: no request of any kind was sent
  // (no save, structure write or preprocessing run), nothing is waiting to
  // be saved, there is nothing to undo, and selection and viewport stayed.
  expect(result.bCallsWhileReceiving).toEqual([]);
  expect(result.bPendingContentLive).toEqual([]);
  expect(result.bCanUndoLive).toBe(false);
  expect(result.bSelectedLive).toEqual([Z]);
  expect(result.bViewportKept).toBe(true);
  // B's own body edit to a different note is accepted; both bodies are saved
  // and A shows B's without reloading either.
  expect(result.bBodyCalls.map((call) => call.status)).not.toContain(409);
  expect(result.serverBodyX).toBe(bodyA);
  expect(result.serverBodyY).toBe(bodyB);
  expect(result.bToastAfterBody).toBe(0);
  expect(result.aShowsBodyY?.trim()).toBe(bodyB);
  // B's later move is an execute request; it is accepted and leaves both
  // bodies intact.
  expect(
    result.bMoveCalls.find((call) => call.path === '<space>/execute')?.status,
  ).toBe(200);
  expect(result.serverYAfterMove).toEqual(result.yMoved);
  expect(result.serverBodyXAfterMove).toBe(bodyA);
  expect(result.serverBodyYAfterMove).toBe(bodyB);
  expect(result.bToastAfterMove).toBe(0);
  expect(result.bDomAfterReload).toBe(bodyA);
});

test("(f) page B editing the same note after page A has saved builds on A's body and is accepted", async ({
  browser,
  request,
}, testInfo) => {
  const result = await sameBodyScenario(browser, request, testInfo);
  // B's save descends from the revision it fetched, so it is not refused.
  expect(result.bCalls.map((call) => call.status)).not.toContain(409);
  expect(result.bCalls.map((call) => call.response).join()).not.toContain(
    'NODE_CONTENT_CONFLICT',
  );
  expect(result.serverBodyX).toBe('Body written by page B');
  expect(result.bShowsBody).toBe('Body written by page B');
  expect(result.bConflictActions).toEqual([]);
  expect(result.bReloaded).toBe(false);
});

// ─── (g) control: execute ───────────────────────────────────────────────────

test('current: (g) an execute request moves the node on both pages without a reload', async ({
  browser,
  request,
}, testInfo) => {
  const result = await executeScenario(browser, request, testInfo);
  expect(result.aFrames).toContain('update');
  expect(result.bFrames).toContain('update');
  expect(result.aLive).toEqual(result.destination);
  expect(result.bLive).toEqual(result.destination);
  expect(result.aVersion).toBe(result.serverVersion);
  expect(result.bVersion).toBe(result.serverVersion);
  expect(result.reloaded).toEqual([false, false]);
  expect(result.bSelected).toEqual([Y]);
  expect(result.bViewportKept).toBe(true);
  expect(result.toasts).toBe(0);
});
