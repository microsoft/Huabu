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

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * Space presence.
 *
 * Two real browser contexts ("devices") open the same Space against the real
 * server and Canvas Sync stream, with different pan and zoom. Nothing is
 * mocked; the store is only read for evidence. Device B must see A's pointer
 * and the node A selects, both placed correctly under B's own viewport, and
 * both must go when A closes or navigates away. Presence must not write the
 * Space: its version and both pages' saves are checked. While A drags a node
 * B is only told that it is being moved; the position arrives on drop. A
 * finger on a touchscreen shows as a cursor while it touches and shortly
 * after; two fingers navigating do not.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-presence-x';
const Y = 'node-presence-y';
const SEED = {
  [X]: { x: 380, y: 90 },
  [Y]: { x: 380, y: 340 },
} as const;
const SIZE = { width: 300, height: 200 };

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface Device {
  context: BrowserContext;
  page: Page;
  viewport: Viewport;
  /** Every non-GET `/api/canvas/**` call this page made, without the Space id. */
  calls: string[];
}

async function seedSpace(request: APIRequestContext) {
  const created = await request.post('/api/canvas', {
    data: { title: `Presence ${Date.now()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [X, Y].map((id) => ({
            id,
            nodeType: 'note',
            data: { type: 'note', label: `Label ${id}`, content: `Body ${id}` },
            selectOnCreate: false,
            position: SEED[id as keyof typeof SEED],
            size: SIZE,
          })),
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-space-presence-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

async function serverVersion(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { version: number }).version;
}

async function openDevice(
  browser: Browser,
  canvasId: string,
  viewport: Viewport,
  /** A touchscreen device in Finger mode instead of a mouse device. */
  touch = false,
): Promise<Device> {
  const context = await browser.newContext(touch ? { hasTouch: true } : {});
  await context.addInitScript(
    ({ canvasId, viewport, touch }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify(viewport),
      );
      if (!localStorage.getItem('huabu-sketch-tools')) {
        localStorage.setItem(
          'huabu-sketch-tools',
          JSON.stringify({
            version: 4,
            state: {
              inputModePreference: touch ? 'finger' : 'mouse',
              mouseToolPreference: 'select',
            },
          }),
        );
      }
    },
    { canvasId, viewport, touch },
  );
  const page = await context.newPage();
  const calls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' || !path.startsWith('/api/canvas/')) return;
    calls.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${X}"]`)).toBeVisible();
  return { context, page, viewport, calls };
}

/** Client position, on `device`, of a point given in canvas (flow) coordinates. */
async function clientPoint(device: Device, flow: { x: number; y: number }) {
  const box = await device.page.locator('.react-flow').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible');
  const { x, y, zoom } = device.viewport;
  return { x: box.x + x + flow.x * zoom, y: box.y + y + flow.y * zoom };
}

async function storeState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      isSaving: state.isSaving,
      selected: state.nodes
        .filter((node) => node.selected)
        .map((node) => node.id),
    };
  });
}

/** Rendered position of a node. */
async function domPosition(page: Page, id: string) {
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

const cursors = (page: Page) => page.locator('[data-presence-cursor]');
const outlines = (page: Page) => page.locator('[data-presence-outline]');

/** A moves its pointer over the canvas and selects X; B is shown both. */
async function showPresence(a: Device, b: Device) {
  // Empty canvas, right of the notes.
  const pointer = { x: 800, y: 420 };
  const from = await clientPoint(a, { x: 760, y: 400 });
  const to = await clientPoint(a, pointer);
  await a.page.mouse.move(from.x, from.y);
  await a.page.mouse.move(to.x, to.y, { steps: 8 });

  const cursor = cursors(b.page);
  await expect(cursor).toHaveCount(1);
  const expected = await clientPoint(b, pointer);
  await expect
    .poll(async () => {
      const box = await cursor.locator('svg').boundingBox();
      return box
        ? Math.hypot(box.x - expected.x, box.y - expected.y)
        : Number.POSITIVE_INFINITY;
    })
    // The arrow's tip sits 1.5px inside its box.
    .toBeLessThan(4);
  await expect(cursor.locator('[data-presence-label]')).toHaveText(/\S/);

  await a.page
    .locator(`.react-flow__node[data-id="${X}"]`)
    .click({ position: { x: 150, y: 12 } });
  const outline = b.page.locator(`[data-presence-outline="${X}"]`);
  await expect(outline).toHaveCount(1);
  await expect(outlines(b.page)).toHaveCount(1);
  await expect(outline).toHaveAttribute('data-presence-activity', 'selected');
  return { cursor, outline };
}

test('B sees A’s cursor and the node A selected, placed under its own viewport, without anything being saved', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  // A different pan and zoom: positions only line up if they travel as
  // canvas coordinates.
  const b = await openDevice(browser, canvasId, { x: 120, y: 60, zoom: 0.5 });
  const version = await serverVersion(request, canvasId);

  const { cursor, outline } = await showPresence(a, b);

  // The outline surrounds B's own rendering of the node A selected.
  const node = await b.page
    .locator(`.react-flow__node[data-id="${X}"]`)
    .boundingBox();
  const ring = await outline.boundingBox();
  if (!node || !ring) throw new Error('Node or outline is not visible');
  expect(Math.abs(ring.x - node.x)).toBeLessThan(3);
  expect(Math.abs(ring.y - node.y)).toBeLessThan(3);
  expect(Math.abs(ring.width - node.width)).toBeLessThan(3);
  expect(Math.abs(ring.height - node.height)).toBeLessThan(3);

  // Cursor and outline share the colour the server gave page A.
  const color = await cursor.getAttribute('data-presence-color');
  expect(color).toMatch(/^[0-5]$/);
  await expect(outline).toHaveAttribute('data-presence-color', color ?? '');

  // Presence is A's, not B's state: B selected nothing and A draws no marker
  // for itself (B's pointer never entered the canvas, B selected nothing).
  expect((await storeState(b.page)).selected).toEqual([]);
  expect((await storeState(a.page)).selected).toEqual([X]);
  await expect(cursors(a.page)).toHaveCount(0);
  await expect(outlines(a.page)).toHaveCount(0);

  // Nothing was written: same Space version everywhere, and the only
  // non-GET requests either page made were presence reports.
  await a.page.waitForTimeout(1_500);
  expect(await serverVersion(request, canvasId)).toBe(version);
  for (const device of [a, b]) {
    const state = await storeState(device.page);
    expect(state.version).toBe(version);
    expect(state.isSaving).toBe(false);
    expect(
      device.calls.filter((call) => call !== 'POST <space>/presence'),
    ).toEqual([]);
  }
  expect(a.calls.length).toBeGreaterThan(0);

  // A closes: its cursor and outline go from B.
  await a.context.close();
  await expect(cursors(b.page)).toHaveCount(0);
  await expect(outlines(b.page)).toHaveCount(0);
  await b.context.close();
});

test('A’s markers go from B when A navigates away from the Space', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  const b = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  await showPresence(a, b);

  await a.page.goto('/');
  await expect(cursors(b.page)).toHaveCount(0);
  await expect(outlines(b.page)).toHaveCount(0);
  await a.context.close();
  await b.context.close();
});

test('B is told that A is moving or editing a node; the moved node’s position arrives on drop', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  const b = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  const activity = (id: string) =>
    b.page.locator(`[data-presence-outline="${id}"]`);

  // A picks Y up and holds it away from where it was.
  const rect = await a.page
    .locator(`.react-flow__node[data-id="${Y}"]`)
    .boundingBox();
  if (!rect) throw new Error('Node Y is not visible');
  const grab = { x: rect.x + rect.width / 2, y: rect.y + 12 };
  await a.page.mouse.move(grab.x, grab.y);
  await a.page.mouse.down();
  await a.page.mouse.move(grab.x + 200, grab.y + 80, { steps: 12 });
  await expect(activity(Y)).toHaveAttribute(
    'data-presence-activity',
    'dragging',
  );
  await expect(
    b.page.locator(`[data-presence-outline-label="${Y}"]`),
  ).toHaveText(/moving$/);
  // The drag itself is not streamed: B's copy has not moved.
  await a.page.waitForTimeout(500);
  expect(await domPosition(b.page, Y)).toEqual(SEED[Y]);
  expect((await domPosition(a.page, Y))?.x).toBeGreaterThan(SEED[Y].x + 100);

  // On drop the position arrives through the ordinary sync, and the outline
  // falls back to a plain selection.
  await a.page.mouse.up();
  const dropped = await domPosition(a.page, Y);
  await expect.poll(() => domPosition(b.page, Y)).toEqual(dropped);
  await expect(activity(Y)).toHaveAttribute(
    'data-presence-activity',
    'selected',
  );

  // A opens X and puts the caret in its body.
  await a.page
    .locator(`.react-flow__node[data-id="${X}"]`)
    .dblclick({ position: { x: 150, y: 100 } });
  await expect(activity(X)).toHaveAttribute(
    'data-presence-activity',
    'editing',
  );
  await expect(
    b.page.locator(`[data-presence-outline-label="${X}"]`),
  ).toHaveText(/editing$/);

  await a.context.close();
  await expect(outlines(b.page)).toHaveCount(0);
  await b.context.close();
});

test('B sees where A’s finger touches the canvas, briefly after it lifts, and nothing while A pinches', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 }, true);
  const b = await openDevice(browser, canvasId, { x: 120, y: 60, zoom: 0.5 });
  const touch = await a.context.newCDPSession(a.page);
  const cursor = cursors(b.page);

  // One finger rests on empty canvas, right of the notes.
  const flow = { x: 820, y: 420 };
  const at = await clientPoint(a, flow);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [at],
  });
  await expect(cursor).toHaveCount(1);
  const expected = await clientPoint(b, flow);
  await expect
    .poll(async () => {
      const box = await cursor.locator('svg').boundingBox();
      return box
        ? Math.hypot(box.x - expected.x, box.y - expected.y)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(4);

  // It lifts: the point stays for a moment, then goes on its own.
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await b.page.waitForTimeout(500);
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveCount(0);

  // Two fingers pinch A's own view: B is shown no cursor at any point.
  const seen: number[] = [];
  const sample = async () => seen.push(await cursor.count());
  const center = await clientPoint(a, { x: 820, y: 420 });
  const fingers = (gap: number) => [
    { x: center.x - gap / 2, y: center.y },
    { x: center.x + gap / 2, y: center.y },
  ];
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: fingers(80),
  });
  for (let step = 1; step <= 8; step++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers(80 + step * 15),
    });
    await b.page.waitForTimeout(80);
    await sample();
  }
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await b.page.waitForTimeout(700);
  await sample();
  expect(seen).toEqual(seen.map(() => 0));
  // The pinch did change A's own view, so it really was a navigation.
  const transform = await a.page
    .locator('.react-flow__viewport')
    .evaluate((element) => (element as HTMLElement).style.transform);
  expect(transform).not.toContain('scale(1)');

  await a.context.close();
  await b.context.close();
});

test('B sees A’s pen while it hovers and while it is in contact', async ({
  browser,
  request,
}) => {
  const canvasId = await seedSpace(request);
  const a = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  const b = await openDevice(browser, canvasId, { x: 0, y: 0, zoom: 1 });
  const pen = await a.context.newCDPSession(a.page);
  const cursor = cursors(b.page);
  const distanceTo = async (flow: { x: number; y: number }) => {
    const expected = await clientPoint(b, flow);
    const box = await cursor.locator('svg').boundingBox();
    return box
      ? Math.hypot(box.x - expected.x, box.y - expected.y)
      : Number.POSITIVE_INFINITY;
  };
  const penEvent = async (
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    flow: { x: number; y: number },
  ) => {
    const at = await clientPoint(a, flow);
    await pen.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      pointerType: 'pen',
      ...(type === 'mouseMoved'
        ? {}
        : { button: 'left' as const, buttons: 1, clickCount: 1 }),
    });
  };
  // What page A actually received, so the check is of pen input.
  await a.page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __penSeen: Set<string> }).__penSeen = seen;
    for (const type of ['pointermove', 'pointerdown'])
      window.addEventListener(
        type,
        (event) => seen.add(`${type}:${(event as PointerEvent).pointerType}`),
        true,
      );
  });

  // Hovering over empty canvas.
  await penEvent('mouseMoved', { x: 800, y: 400 });
  await penEvent('mouseMoved', { x: 820, y: 420 });
  await expect(cursor).toHaveCount(1);
  await expect.poll(() => distanceTo({ x: 820, y: 420 })).toBeLessThan(4);

  // In contact, moving.
  await penEvent('mousePressed', { x: 820, y: 420 });
  await penEvent('mouseMoved', { x: 860, y: 460 });
  await expect.poll(() => distanceTo({ x: 860, y: 460 })).toBeLessThan(4);
  await penEvent('mouseReleased', { x: 860, y: 460 });
  // Lifted but still in range: the cursor stays where the pen is.
  await b.page.waitForTimeout(500);
  await expect(cursor).toHaveCount(1);

  expect(
    await a.page.evaluate(() => [
      ...(window as unknown as { __penSeen: Set<string> }).__penSeen,
    ]),
  ).toEqual(expect.arrayContaining(['pointermove:pen', 'pointerdown:pen']));

  await a.context.close();
  await b.context.close();
});
