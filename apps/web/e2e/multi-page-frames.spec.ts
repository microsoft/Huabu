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
 * Nodes and Frames between two pages.
 *
 * Two real browser contexts open the same Space against the real server and
 * Canvas Sync stream. Page A edits with real input (mouse drags, keyboard
 * shortcuts, toolbar clicks); page B only receives. The store is read for
 * evidence and never written.
 *
 * "B sees" (`expectSeenByB`) means all of:
 *  - B's store, A's store and the server record agree on every node's parent,
 *    parent-local position, size, Frame layout mode, cell, reading order and
 *    sibling order;
 *  - each page's rendered DOM is where its store says;
 *  - B never loaded the Space again (`GET /api/canvas/:id`), was not
 *    reloaded, kept its selection and viewport, and has no undo entry for an
 *    edit it did not make;
 *  - neither page shows a toast.
 *
 * Scenarios 1-8 end with the reverse check: B drags a bystander note and A
 * sees it, which proves B was left in a working state.
 *
 * Scenarios 9 to 14 are two pages editing at once. One page's `POST
 * /execute` is held in the network, the other page's edit is committed, and
 * the held request is then released, in both orders. Scenario 15 is one page
 * making several edits of one note before its first request is answered.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });
test.describe.configure({ timeout: 90_000 });

const TOLERANCE = 1.5;

/** A note A never touches; B selects it, and drags it for the reverse check. */
const BYSTANDER = 'node-mpf-bystander';
const BYSTANDER_AT = { x: 380, y: 600 };

interface Point {
  x: number;
  y: number;
}

interface Rect extends Point {
  width: number;
  height: number;
}

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  /** `GET /api/canvas/:id` requests: loads of the whole Space. */
  spaceLoads: () => number;
  /** Bodies of every `POST …/execute` this page sent. */
  executes: unknown[];
  /** Per answered `POST …/execute`: each command's outcome, in order. */
  outcomes: string[][];
  /** Hold this page's `POST …/execute` requests until `release()`. */
  hold: () => Promise<{ held: () => number; release: () => void }>;
}

/** What one node is, in the terms the three parties must agree on. */
interface SceneNode {
  type: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  layoutMode: string | null;
  column: number | null;
  row: number | null;
  layoutOrder: string[][] | null;
  accent: string | null;
  label: string | null;
  content: string | null;
}

interface Scene {
  nodes: Record<string, SceneNode>;
  /** Direct-child ids per parent (`''` is the canvas), in sibling order. */
  children: Record<string, string[]>;
}

interface RawNode {
  id: string;
  type?: string;
  parentId?: string | null;
  position: Point;
  width?: number;
  height?: number;
  style?: { width?: unknown; height?: unknown };
  data?: Record<string, unknown>;
}

function note(
  id: string,
  x: number,
  y: number,
  extra: {
    parentId?: string;
    data?: Record<string, unknown>;
    size?: { width: number; height: number };
  } = {},
) {
  return {
    id,
    nodeType: 'note',
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    data: {
      type: 'note',
      label: `Label ${id}`,
      // A title the user gave: preprocessing leaves it alone.
      labelSource: 'user',
      content: `Body of ${id}`,
      heightMode: 'fixed',
      ...extra.data,
    },
    selectOnCreate: false,
    position: { x, y },
    size: extra.size ?? { width: 160, height: 90 },
  };
}

function frame(
  id: string,
  x: number,
  y: number,
  size: { width: number; height: number },
  data: Record<string, unknown> = {},
) {
  return {
    id,
    nodeType: 'frame',
    data: {
      type: 'frame',
      label: `Frame ${id}`,
      labelSource: 'user',
      ...data,
    },
    selectOnCreate: false,
    position: { x, y },
    size,
  };
}

async function seedSpace(
  request: APIRequestContext,
  title: string,
  commands: unknown[],
) {
  const created = await request.post('/api/canvas', { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [note(BYSTANDER, BYSTANDER_AT.x, BYSTANDER_AT.y)],
        },
        ...commands,
      ],
      originator: { source: 'ui', tabId: 'e2e-multi-page-frames-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const body = (await seeded.json()) as {
    results?: { applied?: boolean; reason?: string }[];
  };
  expect(
    (body.results ?? []).filter((result) => result.applied === false),
    'every seed command applied',
  ).toEqual([]);
  return canvasId;
}

function sceneOf(raw: RawNode[]): Scene {
  const number = (value: unknown) => (typeof value === 'number' ? value : null);
  const string = (value: unknown) => (typeof value === 'string' ? value : null);
  const nodes: Scene['nodes'] = {};
  const children: Scene['children'] = {};
  for (const node of raw) {
    const data = node.data ?? {};
    const parentId = node.parentId ?? null;
    (children[parentId ?? ''] ??= []).push(node.id);
    nodes[node.id] = {
      type: node.type ?? 'unknown',
      parentId,
      x: node.position.x,
      y: node.position.y,
      width: number(node.style?.width) ?? number(node.width),
      height: number(node.style?.height) ?? number(node.height),
      layoutMode: string(data.layoutMode),
      column: number(data.frameColumn),
      row: number(data.frameRow),
      layoutOrder: Array.isArray(data.layoutOrder)
        ? (data.layoutOrder as string[][])
        : null,
      accent: string((data.style as { accent?: unknown } | undefined)?.accent),
      label: string(data.label),
      content: string(data.content)?.trim() ?? null,
    };
  }
  return { nodes, children };
}

async function serverScene(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    version: number;
    state: { nodes: RawNode[] };
  };
  return { version: record.version, scene: sceneOf(record.state.nodes) };
}

/** What the page's store shows, read only. */
async function pageState(page: Page) {
  const state = await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store, hasUnsavedCanvasEdits } = (await import(
      path
    )) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      unsaved: hasUnsavedCanvasEdits(),
      reloaded:
        (window as unknown as { __mpfLoaded?: boolean }).__mpfLoaded !== true,
      selected: state.nodes
        .filter((node) => node.selected)
        .map((node) => node.id)
        .sort(),
      nodes: state.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        parentId: node.parentId ?? null,
        position: node.position,
        width: node.width,
        height: node.height,
        style: node.style as { width?: unknown; height?: unknown } | undefined,
        data: node.data as Record<string, unknown>,
      })),
    };
  });
  return { ...state, scene: sceneOf(state.nodes as RawNode[]) };
}

/** Rendered rectangle of every node, in canvas coordinates. */
async function domRects(page: Page): Promise<Record<string, Rect>> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(
      '.react-flow__viewport',
    );
    if (!viewport) throw new Error('Missing React Flow viewport');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const origin = (viewport.parentElement ?? viewport).getBoundingClientRect();
    const result: Record<string, Rect> = {};
    for (const element of document.querySelectorAll<HTMLElement>(
      '.react-flow__node',
    )) {
      const id = element.getAttribute('data-id');
      if (!id) continue;
      const rect = element.getBoundingClientRect();
      result[id] = {
        x: (rect.x - origin.x - matrix.e) / matrix.a,
        y: (rect.y - origin.y - matrix.f) / matrix.d,
        width: rect.width / matrix.a,
        height: rect.height / matrix.d,
      };
    }
    return result;
  });
}

async function viewportOf(page: Page) {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>('.react-flow__viewport')?.style
        .transform ?? '',
  );
}

async function toasts(page: Page) {
  return page
    .locator('body > div.fixed [role="status"]')
    .allTextContents()
    .then((texts) => texts.map((text) => text.trim()));
}

function absolute(scene: Scene, id: string): Point {
  let x = 0;
  let y = 0;
  for (
    let current: string | null = id;
    current;
    current = scene.nodes[current]?.parentId ?? null
  ) {
    const node = scene.nodes[current];
    if (!node) throw new Error(`Missing ancestor ${current} of ${id}`);
    x += node.x;
    y += node.y;
  }
  return { x, y };
}

function near(actual: number | null, expected: number | null) {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) <= TOLERANCE;
}

/** Fail with one readable list of every difference between two scenes. */
function expectSameScene(
  actual: Scene,
  expected: Scene,
  actualName: string,
  expectedName: string,
) {
  const differences: string[] = [];
  const ids = new Set([
    ...Object.keys(actual.nodes),
    ...Object.keys(expected.nodes),
  ]);
  for (const id of ids) {
    const mine = actual.nodes[id];
    const theirs = expected.nodes[id];
    if (!mine || !theirs) {
      differences.push(`${id}: only on ${mine ? actualName : expectedName}`);
      continue;
    }
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (!near(mine[key], theirs[key]))
        differences.push(`${id}.${key}: ${mine[key]} vs ${theirs[key]}`);
    }
    for (const key of [
      'type',
      'parentId',
      'layoutMode',
      'column',
      'row',
      'layoutOrder',
      'accent',
      'label',
      'content',
    ] as const) {
      if (JSON.stringify(mine[key]) !== JSON.stringify(theirs[key]))
        differences.push(
          `${id}.${key}: ${JSON.stringify(mine[key])} vs ${JSON.stringify(theirs[key])}`,
        );
    }
  }
  if (JSON.stringify(actual.children) !== JSON.stringify(expected.children))
    differences.push(
      `sibling order: ${JSON.stringify(actual.children)} vs ${JSON.stringify(expected.children)}`,
    );
  expect(differences, `${actualName} vs ${expectedName}`).toEqual([]);
}

/** The page renders every node where, and as large as, its store says. */
async function expectDomMatchesStore(device: Device, scene: Scene) {
  const rects = await domRects(device.page);
  const differences: string[] = [];
  for (const id of new Set([
    ...Object.keys(rects),
    ...Object.keys(scene.nodes),
  ])) {
    const rect = rects[id];
    const node = scene.nodes[id];
    if (!rect || !node) {
      differences.push(`${id}: only in ${rect ? 'DOM' : 'store'}`);
      continue;
    }
    const at = absolute(scene, id);
    if (!near(rect.x, at.x) || !near(rect.y, at.y))
      differences.push(
        `${id} at ${rect.x},${rect.y}, store says ${at.x},${at.y}`,
      );
    if (node.width !== null && !near(rect.width, node.width))
      differences.push(`${id} width ${rect.width}, store ${node.width}`);
    if (node.height !== null && !near(rect.height, node.height))
      differences.push(`${id} height ${rect.height}, store ${node.height}`);
  }
  expect(differences, `${device.name} DOM vs its store`).toEqual([]);
}

/**
 * Both pages and the server hold the same Space and both pages render it.
 * Polled, because an edit takes a round trip to arrive. Returns the scene.
 */
async function expectConverged(
  request: APIRequestContext,
  canvasId: string,
  devices: Device[],
) {
  let scene: Scene | undefined;
  await expect(async () => {
    const server = await serverScene(request, canvasId);
    for (const device of devices) {
      const state = await pageState(device.page);
      expect(state.unsaved, `${device.name} has nothing unsent`).toBe(false);
      expect(state.version, `${device.name} version`).toBe(server.version);
      expectSameScene(state.scene, server.scene, device.name, 'server');
      await expectDomMatchesStore(device, state.scene);
    }
    // The server did not move on while the pages were read.
    expect((await serverScene(request, canvasId)).version).toBe(server.version);
    scene = server.scene;
  }).toPass({ timeout: 15_000 });
  if (!scene) throw new Error('unreachable');
  return scene;
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
  let spaceLoads = 0;
  const executes: unknown[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === `/api/canvas/${canvasId}`)
      spaceLoads += 1;
    if (request.method() === 'POST' && path.endsWith('/execute')) {
      try {
        executes.push(JSON.parse(request.postData() ?? 'null'));
      } catch {
        executes.push(request.postData());
      }
    }
  });
  const outcomes: string[][] = [];
  page.on('response', (response) => {
    const sent = response.request();
    if (
      sent.method() !== 'POST' ||
      !new URL(sent.url()).pathname.endsWith('/execute')
    )
      return;
    void response
      .json()
      .then((body: { results?: { applied?: boolean; reason?: string }[] }) => {
        if (!Array.isArray(body.results)) return;
        outcomes.push(
          body.results.map((result) =>
            result.applied ? 'applied' : (result.reason ?? 'refused'),
          ),
        );
      })
      .catch(() => {});
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(nodeOn(page, BYSTANDER)).toBeVisible();
  // A reload replaces the document; this marker proves one did not happen.
  await page.evaluate(() => {
    (window as unknown as { __mpfLoaded: boolean }).__mpfLoaded = true;
  });
  const hold: Device['hold'] = async () => {
    let held = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const pattern = `**/api/canvas/${canvasId}/execute`;
    await page.route(pattern, async (route) => {
      held += 1;
      await gate;
      // The context may have been closed while the request was held.
      await route.continue().catch(() => {});
    });
    return {
      held: () => held,
      release: () => {
        // The route stays; once the gate is open it passes requests through.
        open();
      },
    };
  };
  return {
    name,
    context,
    page,
    spaceLoads: () => spaceLoads,
    executes,
    outcomes,
    hold,
  };
}

function nodeOn(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function rectOf(page: Page, id: string): Promise<Rect> {
  const rect = await nodeOn(page, id).boundingBox();
  if (!rect) throw new Error(`Node ${id} is not rendered`);
  return rect;
}

interface Session {
  canvasId: string;
  a: Device;
  b: Device;
  /** What B looked like before A did anything. */
  baseline: {
    spaceLoads: number;
    viewport: string;
    selected: string[];
  };
}

async function openBoth(
  browser: Browser,
  request: APIRequestContext,
  title: string,
  commands: unknown[],
): Promise<Session> {
  const canvasId = await seedSpace(request, title, commands);
  const a = await openDevice(browser, canvasId, 'A');
  const b = await openDevice(browser, canvasId, 'B');
  await expectConverged(request, canvasId, [a, b]);
  // B holds a selection of its own; nothing A does may change it.
  await nodeOn(b.page, BYSTANDER).click({ position: { x: 80, y: 10 } });
  await expect(nodeOn(b.page, BYSTANDER)).toHaveClass(/selected/);
  await b.page.mouse.move(1200, 780);
  await expectConverged(request, canvasId, [a, b]);
  const state = await pageState(b.page);
  expect(state.canUndo, 'B starts with no undo entry').toBe(false);
  return {
    canvasId,
    a,
    b,
    baseline: {
      spaceLoads: b.spaceLoads(),
      viewport: await viewportOf(b.page),
      selected: state.selected,
    },
  };
}

async function closeBoth(session: Session) {
  await session.a.context.close();
  await session.b.context.close();
}

/**
 * B shows what A did, exactly, and was otherwise left alone. Returns the
 * scene all three parties agree on.
 */
async function expectSeenByB(request: APIRequestContext, session: Session) {
  const { canvasId, a, b, baseline } = session;
  const scene = await expectConverged(request, canvasId, [a, b]);
  const state = await pageState(b.page);
  expect(b.spaceLoads(), 'B did not load the Space again').toBe(
    baseline.spaceLoads,
  );
  expect(state.reloaded, 'B was not reloaded').toBe(false);
  expect(await viewportOf(b.page), 'B kept its viewport').toBe(
    baseline.viewport,
  );
  expect(state.selected, 'B kept its selection').toEqual(baseline.selected);
  expect(
    { canUndo: state.canUndo, canRedo: state.canRedo },
    "B has no undo entry for A's edit",
  ).toEqual({ canUndo: false, canRedo: false });
  expect(await toasts(a.page), 'A shows no toast').toEqual([]);
  expect(await toasts(b.page), 'B shows no toast').toEqual([]);
  return scene;
}

/** Press on a node's top edge and drag it by real mouse input. */
async function dragBy(
  page: Page,
  id: string,
  dx: number,
  dy: number,
  grab: Point = { x: 80, y: 10 },
) {
  const rect = await rectOf(page, id);
  const start = { x: rect.x + grab.x, y: rect.y + grab.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx / 3, start.y + dy / 3, { steps: 4 });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 10 });
  await page.mouse.up();
}

/** Drag a node so that its top-left lands on a point of the page. */
async function dragTo(page: Page, id: string, to: Point) {
  const rect = await rectOf(page, id);
  await dragBy(page, id, to.x - rect.x, to.y - rect.y);
}

/**
 * The reverse check: B drags the bystander note and A sees it. B was left
 * with a working send queue, stream and store.
 */
async function expectBCanStillEdit(
  request: APIRequestContext,
  session: Session,
) {
  const { canvasId, a, b } = session;
  const before = (await pageState(a.page)).scene.nodes[BYSTANDER];
  await dragBy(b.page, BYSTANDER, 60, 40);
  await expect
    .poll(async () => (await pageState(b.page)).scene.nodes[BYSTANDER].x)
    .toBeGreaterThan(before.x + 30);
  const scene = await expectConverged(request, canvasId, [a, b]);
  expect(scene.nodes[BYSTANDER].x).toBeGreaterThan(before.x + 30);
  expect(scene.nodes[BYSTANDER].y).toBeGreaterThan(before.y + 20);
  expect(scene.nodes[BYSTANDER].parentId).toBeNull();
  expect(b.spaceLoads(), 'B did not load the Space again').toBe(
    session.baseline.spaceLoads,
  );
  expect(await toasts(a.page), 'A shows no toast').toEqual([]);
  expect(await toasts(b.page), 'B shows no toast').toEqual([]);
}

// ─── Gestures ───────────────────────────────────────────────────────────────

/** Where a Frame is pressed to select or drag it: its top-left padding. */
const FRAME_GRIP = { x: 10, y: 10 };

async function selectFrame(page: Page, id: string) {
  await nodeOn(page, id).click({ position: FRAME_GRIP });
  await expect(nodeOn(page, id)).toHaveClass(/selected/);
}

/** Rubber-band select: drag over empty canvas around the named nodes. */
async function marquee(page: Page, ids: string[]) {
  const rects = await Promise.all(ids.map((id) => rectOf(page, id)));
  await page.mouse.move(
    Math.min(...rects.map((rect) => rect.x)) - 12,
    Math.min(...rects.map((rect) => rect.y)) - 12,
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(...rects.map((rect) => rect.x + rect.width)) + 12,
    Math.max(...rects.map((rect) => rect.y + rect.height)) + 12,
    { steps: 8 },
  );
  await page.mouse.up();
  for (const id of ids) await expect(nodeOn(page, id)).toHaveClass(/selected/);
}

/** Pick a layout mode in the selected Frame's toolbar. */
async function chooseLayout(
  page: Page,
  mode: 'Free' | 'Column' | 'Row' | 'Grid',
) {
  const panel = page.locator('.node-toolbar-layout');
  if ((await panel.count()) === 0)
    await page
      .locator('.node-floating-toolbar')
      .getByRole('button', { name: 'Layout', exact: true })
      .click();
  await panel.getByRole('button', { name: mode, exact: true }).click();
}

/** Recolour the node from its toolbar; returns the accent the store holds. */
async function recolour(page: Page, id: string) {
  const before = (await pageState(page)).scene.nodes[id].accent;
  await nodeOn(page, id).click({ position: { x: 80, y: 10 } });
  await expect(nodeOn(page, id)).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Accent color', exact: true }).click();
  await page.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect
    .poll(async () => (await pageState(page)).scene.nodes[id].accent)
    .not.toBe(before);
  await page.keyboard.press('Escape');
  const accent = (await pageState(page)).scene.nodes[id].accent;
  if (!accent) throw new Error('No accent was applied');
  return accent;
}

// ─── Seeds ──────────────────────────────────────────────────────────────────

const FRAME = 'node-mpf-frame';
const N = 'node-mpf-n';
const INSIDE = 'node-mpf-inside';

/** A free Frame holding one note, and one note beside it on the canvas. */
const freeFrameSeed = [
  {
    type: 'CREATE_NODES',
    nodes: [
      frame(FRAME, 640, 120, { width: 460, height: 380 }),
      note(N, 380, 150),
    ],
  },
  {
    type: 'CREATE_NODES',
    nodes: [note(INSIDE, 40, 80, { parentId: FRAME })],
  },
];

const C = ['node-mpf-c0', 'node-mpf-c1', 'node-mpf-c2', 'node-mpf-c3'];

/** A free Frame holding two notes. */
const filledFrameSeed = [
  {
    type: 'CREATE_NODES',
    nodes: [frame(FRAME, 640, 120, { width: 460, height: 380 })],
  },
  {
    type: 'CREATE_NODES',
    nodes: [
      note(C[0], 40, 80, { parentId: FRAME }),
      note(C[1], 240, 200, { parentId: FRAME }),
    ],
  },
];

const SMALL = { width: 120, height: 70 };

/** A structured Frame whose children's cells are given explicitly. */
function structuredSeed(
  frameId: string,
  at: Point,
  mode: 'column' | 'row' | 'grid',
  gridCount: number,
  ids: string[],
  cell: (index: number) => { column?: number; row?: number },
) {
  return [
    {
      type: 'CREATE_NODES',
      nodes: [frame(frameId, at.x, at.y, { width: 400, height: 300 })],
    },
    {
      type: 'CREATE_NODES',
      nodes: ids.map((id, index) =>
        note(id, 30 + index * 20, 70 + index * 20, {
          parentId: frameId,
          size: SMALL,
        }),
      ),
    },
    {
      type: 'SET_FRAME_LAYOUT',
      frameId,
      mode,
      gridCount,
      cells: ids.map((nodeId, index) => ({ nodeId, ...cell(index) })),
    },
  ];
}

function sizeOf(scene: Scene, id: string) {
  const { width, height } = scene.nodes[id];
  if (width === null || height === null)
    throw new Error(`${id} has no stored size`);
  return { width, height };
}

function cellsOf(scene: Scene, ids: string[]) {
  return ids.map((id) => [scene.nodes[id].column, scene.nodes[id].row]);
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

test('1. a note A drags into a free Frame shows inside that Frame on B', async ({
  browser,
  request,
}) => {
  const session = await openBoth(browser, request, 'Into Frame', freeFrameSeed);
  const { a } = session;
  const frameRect = await rectOf(a.page, FRAME);
  // Onto the Frame's lower half, below the note it already holds.
  await dragTo(a.page, N, {
    x: frameRect.x + 30,
    y: frameRect.y + frameRect.height - 50,
  });
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[N].parentId)
    .toBe(FRAME);

  const scene = await expectSeenByB(request, session);
  expect(scene.nodes[N].parentId).toBe(FRAME);
  expect([...scene.children[FRAME]].sort()).toEqual([INSIDE, N].sort());
  // Parent-local: where it was dropped, relative to the Frame.
  const frameNow = await rectOf(session.b.page, FRAME);
  const noteNow = await rectOf(session.b.page, N);
  expect(noteNow.x - frameNow.x).toBeCloseTo(scene.nodes[N].x, 0);
  expect(noteNow.y - frameNow.y).toBeCloseTo(scene.nodes[N].y, 0);

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

test('2. a note A drags out of a Frame shows back on the canvas on B', async ({
  browser,
  request,
}) => {
  const session = await openBoth(
    browser,
    request,
    'Out of Frame',
    filledFrameSeed,
  );
  const { a, b } = session;
  // Well clear of the Frame, on empty canvas to its left.
  await dragTo(a.page, C[0], { x: 400, y: 330 });
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[C[0]].parentId)
    .toBeNull();
  const dropped = (await domRects(a.page))[C[0]];

  const scene = await expectSeenByB(request, session);
  expect(scene.nodes[C[0]].parentId).toBeNull();
  expect(scene.children[FRAME]).toEqual([C[1]]);
  // Canvas coordinates: where A dropped it.
  const onB = (await domRects(b.page))[C[0]];
  expect(Math.abs(onB.x - dropped.x)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(onB.y - dropped.y)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(scene.nodes[C[0]].x - dropped.x)).toBeLessThanOrEqual(
    TOLERANCE,
  );
  expect(Math.abs(scene.nodes[C[0]].y - dropped.y)).toBeLessThanOrEqual(
    TOLERANCE,
  );

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

test('3. a Frame A moves takes its children along on B', async ({
  browser,
  request,
}) => {
  const session = await openBoth(
    browser,
    request,
    'Move Frame',
    filledFrameSeed,
  );
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);
  const domBefore = await domRects(b.page);
  // A press on an unselected Frame's blank area rubber-bands; a selected
  // Frame drags.
  await selectFrame(a.page, FRAME);
  await dragBy(a.page, FRAME, 150, 90, FRAME_GRIP);
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[FRAME].x)
    .toBeGreaterThan(before.nodes[FRAME].x + 100);

  const scene = await expectSeenByB(request, session);
  // The drag may snap, so the distance is read back rather than assumed.
  const moved = {
    x: scene.nodes[FRAME].x - before.nodes[FRAME].x,
    y: scene.nodes[FRAME].y - before.nodes[FRAME].y,
  };
  expect(moved.x).toBeGreaterThan(100);
  expect(moved.y).toBeGreaterThan(50);
  const domAfter = await domRects(b.page);
  for (const id of [C[0], C[1]]) {
    // Children keep their place inside the Frame …
    expect(scene.nodes[id].parentId).toBe(FRAME);
    expect(scene.nodes[id].x).toBeCloseTo(before.nodes[id].x, 0);
    expect(scene.nodes[id].y).toBeCloseTo(before.nodes[id].y, 0);
    // … and so moved with it on B's screen.
    expect(domAfter[id].x - domBefore[id].x).toBeCloseTo(moved.x, 0);
    expect(domAfter[id].y - domBefore[id].y).toBeCloseTo(moved.y, 0);
  }

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

test("4. a card A drags to another cell of a Grid Frame leaves B's cells the same as A's", async ({
  browser,
  request,
}) => {
  const session = await openBoth(
    browser,
    request,
    'Grid cells',
    structuredSeed(FRAME, { x: 640, y: 120 }, 'grid', 2, C, (index) => ({
      column: index % 2,
      row: Math.floor(index / 2),
    })),
  );
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);
  expect(cellsOf(before, C)).toEqual([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]);
  // Onto the occupied cell diagonally opposite: the two cards swap.
  const from = await rectOf(a.page, C[0]);
  const target = await rectOf(a.page, C[3]);
  await a.page.mouse.move(from.x + 50, from.y + 8);
  await a.page.mouse.down();
  await a.page.mouse.move(target.x + 30, target.y + 25, { steps: 10 });
  await expect(
    a.page.locator(`[data-structured-drop-node="${C[0]}"]`),
  ).toBeVisible();
  await a.page.mouse.up();
  await expect
    .poll(async () => cellsOf((await pageState(a.page)).scene, C))
    .toEqual([
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ]);

  const scene = await expectSeenByB(request, session);
  expect(cellsOf(scene, C)).toEqual([
    [1, 1],
    [1, 0],
    [0, 1],
    [0, 0],
  ]);
  expect(cellsOf((await pageState(b.page)).scene, C)).toEqual(
    cellsOf((await pageState(a.page)).scene, C),
  );
  // The swap is visible on B: the two cards traded places.
  const onB = await domRects(b.page);
  const frameAbs = absolute(before, FRAME);
  expect(onB[C[0]].x - frameAbs.x).toBeCloseTo(before.nodes[C[3]].x, 0);
  expect(onB[C[0]].y - frameAbs.y).toBeCloseTo(before.nodes[C[3]].y, 0);
  expect(onB[C[3]].x - frameAbs.x).toBeCloseTo(before.nodes[C[0]].x, 0);
  expect(onB[C[3]].y - frameAbs.y).toBeCloseTo(before.nodes[C[0]].y, 0);

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

const COLUMN = 'node-mpf-column';
const ROW = 'node-mpf-row';
const K = ['node-mpf-k0', 'node-mpf-k1', 'node-mpf-k2'];
const R = ['node-mpf-r0', 'node-mpf-r1', 'node-mpf-r2'];

test('5. a reorder A makes inside a Column and inside a Row Frame gives B the same reading order', async ({
  browser,
  request,
}) => {
  const session = await openBoth(browser, request, 'Reading order', [
    ...structuredSeed(COLUMN, { x: 640, y: 90 }, 'column', 1, K, () => ({
      column: 0,
    })),
    ...structuredSeed(ROW, { x: 640, y: 520 }, 'row', 1, R, () => ({ row: 0 })),
  ]);
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);
  expect(before.nodes[COLUMN].layoutOrder).toEqual([K]);
  expect(before.nodes[ROW].layoutOrder).toEqual([R]);

  // Column: the first card goes below the last.
  let from = await rectOf(a.page, K[0]);
  let last = await rectOf(a.page, K[2]);
  await a.page.mouse.move(from.x + 50, from.y + 8);
  await a.page.mouse.down();
  await a.page.mouse.move(from.x + 50, last.y + last.height - 4, { steps: 12 });
  await a.page.mouse.up();
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[COLUMN].layoutOrder)
    .toEqual([[K[1], K[2], K[0]]]);
  let scene = await expectSeenByB(request, session);
  expect(scene.nodes[COLUMN].layoutOrder).toEqual([[K[1], K[2], K[0]]]);
  // Reading order is what B renders, top to bottom.
  let onB = await domRects(b.page);
  expect([...K].sort((p, q) => onB[p].y - onB[q].y)).toEqual([
    K[1],
    K[2],
    K[0],
  ]);

  // Row: the first card goes right of the last.
  from = await rectOf(a.page, R[0]);
  last = await rectOf(a.page, R[2]);
  await a.page.mouse.move(from.x + 50, from.y + 8);
  await a.page.mouse.down();
  await a.page.mouse.move(last.x + last.width + 46, from.y + 8, { steps: 12 });
  await a.page.mouse.up();
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[ROW].layoutOrder)
    .toEqual([[R[1], R[2], R[0]]]);
  scene = await expectSeenByB(request, session);
  expect(scene.nodes[ROW].layoutOrder).toEqual([[R[1], R[2], R[0]]]);
  expect(scene.nodes[COLUMN].layoutOrder).toEqual([[K[1], K[2], K[0]]]);
  onB = await domRects(b.page);
  expect([...R].sort((p, q) => onB[p].x - onB[q].x)).toEqual([
    R[1],
    R[2],
    R[0],
  ]);

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

const G = ['node-mpf-g0', 'node-mpf-g1', 'node-mpf-g2'];

test('6. a Frame A groups nodes into shows on B with the nodes inside, and is gone on B when A dissolves it', async ({
  browser,
  request,
}) => {
  const session = await openBoth(browser, request, 'Group', [
    {
      type: 'CREATE_NODES',
      nodes: [note(G[0], 640, 140), note(G[1], 860, 180), note(G[2], 700, 300)],
    },
  ]);
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);
  const domBefore = await domRects(b.page);

  // Group: rubber-band the three notes, then the product shortcut.
  await marquee(a.page, G);
  await a.page.keyboard.press('ControlOrMeta+g');
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[G[0]].parentId)
    .not.toBeNull();
  let scene = await expectSeenByB(request, session);
  const groupId = scene.nodes[G[0]].parentId;
  if (!groupId) throw new Error('unreachable');
  expect(scene.nodes[groupId].type).toBe('frame');
  expect(scene.nodes[groupId].parentId).toBeNull();
  expect([...scene.children[groupId]].sort()).toEqual([...G].sort());
  await expect(nodeOn(b.page, groupId)).toBeVisible();
  // Grouping does not move the notes on B's screen.
  let onB = await domRects(b.page);
  for (const id of G) {
    expect(Math.abs(onB[id].x - domBefore[id].x)).toBeLessThanOrEqual(
      TOLERANCE,
    );
    expect(Math.abs(onB[id].y - domBefore[id].y)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  }

  // Dissolve: the Frame's own menu.
  await selectFrame(a.page, groupId);
  await a.page
    .locator('.node-floating-toolbar')
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await a.page.getByRole('menuitem', { name: 'Unframe', exact: true }).click();
  await expect(nodeOn(a.page, groupId)).toHaveCount(0);
  scene = await expectSeenByB(request, session);
  expect(scene.nodes[groupId]).toBeUndefined();
  await expect(nodeOn(b.page, groupId)).toHaveCount(0);
  onB = await domRects(b.page);
  for (const id of G) {
    expect(scene.nodes[id].parentId).toBeNull();
    expect(scene.nodes[id].x).toBeCloseTo(before.nodes[id].x, 0);
    expect(scene.nodes[id].y).toBeCloseTo(before.nodes[id].y, 0);
    expect(Math.abs(onB[id].x - domBefore[id].x)).toBeLessThanOrEqual(
      TOLERANCE,
    );
    expect(Math.abs(onB[id].y - domBefore[id].y)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  }

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

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

test('7. a Frame A deletes vanishes on B with its children, and A’s undo brings all of them back on B with their content', async ({
  browser,
  request,
}) => {
  const session = await openBoth(
    browser,
    request,
    'Delete Frame',
    filledFrameSeed,
  );
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);

  await selectFrame(a.page, FRAME);
  await a.page.keyboard.press('Backspace');
  await expect(nodeOn(a.page, FRAME)).toHaveCount(0);
  let scene = await expectSeenByB(request, session);
  expect(Object.keys(scene.nodes)).toEqual([BYSTANDER]);
  for (const id of [FRAME, C[0], C[1]])
    await expect(nodeOn(b.page, id)).toHaveCount(0);

  await a.page.keyboard.press('ControlOrMeta+z');
  await expect(nodeOn(a.page, FRAME)).toBeVisible();
  scene = await expectSeenByB(request, session);
  // Everything is back as it was: tree, geometry, titles and bodies.
  expectSameScene(scene, before, 'after undo', 'before delete');
  for (const id of [C[0], C[1]]) {
    await expect(nodeOn(b.page, id)).toBeVisible();
    expect(scene.nodes[id].content).toBe(`Body of ${id}`);
    await expect.poll(() => domBody(b.page, id)).toBe(`Body of ${id}`);
    await expect.poll(() => domBody(a.page, id)).toBe(`Body of ${id}`);
  }
  await expect(nodeOn(b.page, FRAME).locator('input')).toHaveValue(
    `Frame ${FRAME}`,
  );

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

test('8. a Frame A resizes and switches between layout modes is followed by B, children included', async ({
  browser,
  request,
}) => {
  const session = await openBoth(browser, request, 'Resize and layout', [
    {
      type: 'CREATE_NODES',
      nodes: [frame(FRAME, 640, 120, { width: 460, height: 380 })],
    },
    {
      type: 'CREATE_NODES',
      nodes: [
        note(C[0], 30, 70, { parentId: FRAME, size: SMALL }),
        note(C[1], 190, 70, { parentId: FRAME, size: SMALL }),
        note(C[2], 30, 180, { parentId: FRAME, size: SMALL }),
        note(C[3], 190, 180, { parentId: FRAME, size: SMALL }),
      ],
    },
  ]);
  const { a, b } = session;
  const before = await expectConverged(request, session.canvasId, [a, b]);
  expect(before.nodes[FRAME].layoutMode ?? 'free').toBe('free');

  // Resize from the bottom-right corner.
  await selectFrame(a.page, FRAME);
  const handle = nodeOn(a.page, FRAME).locator(
    '.react-flow__resize-control.node-resize-corner.bottom.right',
  );
  const grip = await handle.boundingBox();
  if (!grip) throw new Error('Missing resize handle');
  const point = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await a.page.mouse.move(point.x, point.y);
  await a.page.mouse.down();
  await a.page.mouse.move(point.x + 40, point.y + 30, { steps: 6 });
  await a.page.mouse.move(point.x + 96, point.y + 72, { steps: 8 });
  await a.page.mouse.up();
  await expect(a.page.locator('body')).not.toHaveClass(/node-resize-active/);
  let scene = await expectSeenByB(request, session);
  expect(sizeOf(scene, FRAME).width).toBeGreaterThan(
    sizeOf(before, FRAME).width + 50,
  );
  expect(sizeOf(scene, FRAME).height).toBeGreaterThan(
    sizeOf(before, FRAME).height + 40,
  );
  // The children scaled with the Frame, on B as on A.
  for (const id of C)
    expect(sizeOf(scene, id).width).toBeGreaterThan(
      sizeOf(before, id).width + 5,
    );

  // Free → Column: the 2 x 2 arrangement becomes two columns of two.
  await chooseLayout(a.page, 'Column');
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[FRAME].layoutMode)
    .toBe('column');
  scene = await expectSeenByB(request, session);
  expect(scene.nodes[FRAME].layoutMode).toBe('column');
  expect(scene.nodes[FRAME].layoutOrder).toEqual([
    [C[0], C[2]],
    [C[1], C[3]],
  ]);
  expect(C.map((id) => scene.nodes[id].column)).toEqual([0, 1, 0, 1]);

  // Column → Grid.
  await chooseLayout(a.page, 'Grid');
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[FRAME].layoutMode)
    .toBe('grid');
  scene = await expectSeenByB(request, session);
  expect(cellsOf(scene, C)).toEqual([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]);

  // Grid → Row.
  await chooseLayout(a.page, 'Row');
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[FRAME].layoutMode)
    .toBe('row');
  scene = await expectSeenByB(request, session);
  expect(scene.nodes[FRAME].layoutOrder).toEqual([
    [C[0], C[1]],
    [C[2], C[3]],
  ]);

  // Row → Free: positions stay, cells go.
  await chooseLayout(a.page, 'Free');
  await expect
    .poll(
      async () =>
        (await pageState(a.page)).scene.nodes[FRAME].layoutMode ?? 'free',
    )
    .toBe('free');
  scene = await expectSeenByB(request, session);
  await a.page.keyboard.press('Escape');

  await expectBCanStillEdit(request, session);
  await closeBoth(session);
});

// ─── Two pages at once ──────────────────────────────────────────────────────

interface RaceResult {
  scene: Scene;
  loads: { a: number; b: number };
}

/** Both pages converge, and neither loaded the Space again or was told off. */
async function expectRaceSettled(
  request: APIRequestContext,
  session: Session,
  loadsBefore: { a: number; b: number },
): Promise<RaceResult> {
  const { canvasId, a, b } = session;
  const scene = await expectConverged(request, canvasId, [a, b]);
  // No reload loop: nothing more happens once the pages agree.
  await a.page.waitForTimeout(1_500);
  const again = await expectConverged(request, canvasId, [a, b]);
  expectSameScene(again, scene, 'later', 'at convergence');
  const loads = { a: a.spaceLoads(), b: b.spaceLoads() };
  for (const device of [a, b])
    expect((await pageState(device.page)).reloaded).toBe(false);
  expect(loads, 'neither page loaded the Space again').toEqual(loadsBefore);
  expect(await toasts(a.page), 'A shows no toast').toEqual([]);
  expect(await toasts(b.page), 'B shows no toast').toEqual([]);
  return { scene, loads };
}

for (const heldPage of ['A', 'B'] as const) {
  test(`9. A drags a note into a Frame while B recolours it (${heldPage}'s request arrives last): both changes are kept`, async ({
    browser,
    request,
  }) => {
    const session = await openBoth(
      browser,
      request,
      'Race colour',
      freeFrameSeed,
    );
    const { a, b } = session;
    const loads = { a: a.spaceLoads(), b: b.spaceLoads() };
    const frameRect = await rectOf(a.page, FRAME);
    const intoFrame = () =>
      dragTo(a.page, N, {
        x: frameRect.x + 30,
        y: frameRect.y + frameRect.height - 50,
      });
    const inFrameOn = async (device: Device) =>
      (await pageState(device.page)).scene.nodes[N].parentId;
    const accentOn = async (device: Device) =>
      (await pageState(device.page)).scene.nodes[N].accent;
    let accent: string;

    if (heldPage === 'A') {
      const held = await a.hold();
      await intoFrame();
      await expect.poll(() => inFrameOn(a)).toBe(FRAME);
      await expect.poll(held.held).toBeGreaterThan(0);
      // B has not heard of the move; it recolours the note on the canvas.
      expect(await inFrameOn(b)).toBeNull();
      accent = await recolour(b.page, N);
      // A takes the colour and keeps its own, unanswered, move.
      await expect.poll(() => accentOn(a)).toBe(accent);
      expect(await inFrameOn(a)).toBe(FRAME);
      held.release();
    } else {
      const held = await b.hold();
      accent = await recolour(b.page, N);
      await expect.poll(held.held).toBeGreaterThan(0);
      expect(await accentOn(a)).not.toBe(accent);
      await intoFrame();
      await expect.poll(() => inFrameOn(a)).toBe(FRAME);
      // B takes the move and keeps its own, unanswered, colour.
      await expect.poll(() => inFrameOn(b)).toBe(FRAME);
      expect(await accentOn(b)).toBe(accent);
      held.release();
    }

    const { scene } = await expectRaceSettled(request, session, loads);
    expect(scene.nodes[N].parentId).toBe(FRAME);
    expect(scene.nodes[N].accent).toBe(accent);
    expect([...scene.children[FRAME]].sort()).toEqual([INSIDE, N].sort());
    // The note is inside the Frame's box on both screens.
    for (const device of [a, b]) {
      const rects = await domRects(device.page);
      expect(rects[N].x).toBeGreaterThanOrEqual(rects[FRAME].x);
      expect(rects[N].y).toBeGreaterThanOrEqual(rects[FRAME].y);
      expect(rects[N].x + rects[N].width).toBeLessThanOrEqual(
        rects[FRAME].x + rects[FRAME].width + TOLERANCE,
      );
      expect(rects[N].y + rects[N].height).toBeLessThanOrEqual(
        rects[FRAME].y + rects[FRAME].height + TOLERANCE,
      );
    }
    await closeBoth(session);
  });
}

/**
 * Scenarios 10-14: two pages edit the same note at once, and one of them
 * changes the note's container or deletes it.
 *
 * Every edit states the read version it was made on. The edit committed
 * first stands. The later one is applied when nobody else has deleted its
 * note or changed the note's container since that version, and refused as a
 * whole when somebody has: the server never reads one page's coordinates
 * inside the other page's container. The refused page is told once and shows
 * the server's Space.
 */

const REFUSED_NOTICE =
  'A change could not be applied because the item was changed elsewhere. This Space now shows the latest version.';

/**
 * Record every toast the page shows from now on (a notice dismisses itself
 * after three seconds, so reading the DOM later would miss it).
 */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __mpfToasts: string[] }).__mpfToasts = seen;
    const known = new WeakSet<Element>();
    const collect = () => {
      for (const element of document.querySelectorAll(
        'body > div.fixed [role="status"]',
      )) {
        if (known.has(element)) continue;
        known.add(element);
        seen.push((element.textContent ?? '').trim());
      }
    };
    collect();
    new MutationObserver(collect).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __mpfToasts: string[] }).__mpfToasts,
    );
}

interface Race {
  session: Session;
  loads: { a: number; b: number };
  shown: { a: () => Promise<string[]>; b: () => Promise<string[]> };
}

async function startRace(
  browser: Browser,
  request: APIRequestContext,
  title: string,
  seed: unknown[],
): Promise<Race> {
  const session = await openBoth(browser, request, title, seed);
  const { a, b } = session;
  return {
    session,
    loads: { a: a.spaceLoads(), b: b.spaceLoads() },
    shown: { a: await recordToasts(a.page), b: await recordToasts(b.page) },
  };
}

/**
 * Both edits were taken: the pages converge, and neither loaded the Space
 * again or was told anything.
 */
async function expectBothTaken(request: APIRequestContext, race: Race) {
  const { scene } = await expectRaceSettled(request, race.session, race.loads);
  expect(await race.shown.a(), 'A was shown no toast').toEqual([]);
  expect(await race.shown.b(), 'B was shown no toast').toEqual([]);
  return scene;
}

/**
 * `refused`'s edit was refused: it was told once and loaded the server's
 * Space once; the other page was left alone; and it ends there.
 */
async function expectRefused(
  request: APIRequestContext,
  race: Race,
  refused: 'a' | 'b',
) {
  const { session, loads } = race;
  const { canvasId, a, b } = session;
  const other = refused === 'a' ? 'b' : 'a';
  await expect
    .poll(() => race.shown[refused](), { timeout: 15_000 })
    .toEqual([REFUSED_NOTICE]);
  const scene = await expectConverged(request, canvasId, [a, b]);
  // No reload loop and no second notice: nothing more happens.
  await a.page.waitForTimeout(2_500);
  const again = await expectConverged(request, canvasId, [a, b]);
  expectSameScene(again, scene, 'later', 'at convergence');
  for (const device of [a, b])
    expect(
      (await pageState(device.page)).reloaded,
      `${device.name}'s document was not reloaded`,
    ).toBe(false);
  expect(
    { a: a.spaceLoads(), b: b.spaceLoads() },
    'only the refused page loaded the Space again, once',
  ).toEqual({ ...loads, [refused]: loads[refused] + 1 });
  expect(await race.shown[refused](), 'told once').toEqual([REFUSED_NOTICE]);
  expect(await race.shown[other](), 'the other page was told nothing').toEqual(
    [],
  );
  // The refused edit is not left in the page's history to be replayed.
  const state = await pageState(session[refused].page);
  expect({ canUndo: state.canUndo, canRedo: state.canRedo }).toEqual({
    canUndo: false,
    canRedo: false,
  });
  return scene;
}

/** The server holds `expected` for these nodes, to the pixel. */
function expectUnchanged(scene: Scene, expected: Scene, ids: string[]) {
  for (const id of ids)
    expect(scene.nodes[id], `${id} is as the first edit left it`).toEqual(
      expected.nodes[id],
    );
}

/** The Space version a read version (`b1.<lineage>.<version>`) names. */
function readVersionOf(basis: string | undefined): number {
  const version = Number(basis?.split('.').pop());
  if (!Number.isInteger(version)) throw new Error(`Not a basis: ${basis}`);
  return version;
}

function isAt(point: Point, rect: Rect) {
  return near(point.x, rect.x) && near(point.y, rect.y);
}

for (const heldPage of ['A', 'B'] as const) {
  test(`10. A drags a note into a Frame while B moves it on the canvas (${heldPage}'s request arrives last): ${
    heldPage === 'A'
      ? "A's drag is applied whole"
      : "A's drag stands and B's move is refused"
  }`, async ({ browser, request }, testInfo) => {
    const race = await startRace(browser, request, 'Race move', freeFrameSeed);
    const { session } = race;
    const { a, b, canvasId } = session;
    const frameRect = await rectOf(a.page, FRAME);
    const noteOn = async (device: Device) =>
      (await pageState(device.page)).scene.nodes[N];
    /** A's edit; returns where it left the note, in canvas coordinates. */
    const intoFrame = async () => {
      await dragTo(a.page, N, {
        x: frameRect.x + 30,
        y: frameRect.y + frameRect.height - 50,
      });
      await expect.poll(async () => (await noteOn(a)).parentId).toBe(FRAME);
      return (await domRects(a.page))[N];
    };
    /** B's edit; returns where it left the note, in canvas coordinates. */
    const onCanvas = async () => {
      const start = await noteOn(b);
      await dragBy(b.page, N, 20, 220);
      await expect
        .poll(async () => (await noteOn(b)).y)
        .toBeGreaterThan(start.y + 150);
      return (await domRects(b.page))[N];
    };

    const holder = heldPage === 'A' ? a : b;
    const held = await holder.hold();
    let wantedByA: Rect;
    let wantedByB: Rect;
    if (heldPage === 'A') {
      wantedByA = await intoFrame();
      await expect.poll(held.held).toBeGreaterThan(0);
      wantedByB = await onCanvas();
    } else {
      wantedByB = await onCanvas();
      await expect.poll(held.held).toBeGreaterThan(0);
      wantedByA = await intoFrame();
    }
    // The other page's edit is committed and has reached the page whose own
    // request is still held.
    let committed: Scene | undefined;
    let committedVersion = 0;
    await expect(async () => {
      const server = await serverScene(request, canvasId);
      expect((await pageState(holder.page)).version).toBe(server.version);
      if (heldPage === 'A') expect(server.scene.nodes[N].parentId).toBeNull();
      else expect(server.scene.nodes[N].parentId).toBe(FRAME);
      committed = server.scene;
      committedVersion = server.version;
    }).toPass({ timeout: 10_000 });
    if (!committed) throw new Error('unreachable');
    const whileHeld = {
      a: await noteOn(a),
      b: await noteOn(b),
      aDom: (await domRects(a.page))[N],
      bDom: (await domRects(b.page))[N],
    };
    // The page that waits shows its own edit, whole: its own container with
    // its own coordinates, never the other page's container with them.
    const own = heldPage === 'A' ? wantedByA : wantedByB;
    const shown = heldPage === 'A' ? whileHeld.aDom : whileHeld.bDom;
    expect(
      isAt(shown, own),
      `${heldPage} kept showing its own edit while its request was unanswered: ${JSON.stringify({ shown, own })}`,
    ).toBe(true);
    expect((heldPage === 'A' ? whileHeld.a : whileHeld.b).parentId).toBe(
      heldPage === 'A' ? FRAME : null,
    );
    held.release();

    const scene =
      heldPage === 'A'
        ? await expectBothTaken(request, race)
        : await expectRefused(request, race, 'b');
    const at = absolute(scene, N);
    const evidence = JSON.stringify(
      {
        wantedByA,
        wantedByB,
        whileHeld,
        final: { note: scene.nodes[N], at, frame: scene.nodes[FRAME] },
        aExecutes: a.executes,
        bExecutes: b.executes,
      },
      null,
      2,
    );
    await testInfo.attach('evidence', {
      body: evidence,
      contentType: 'application/json',
    });
    if (process.env.E2E_SYNC_EVIDENCE) console.log(`EVIDENCE\n${evidence}`);

    // Nothing is lost.
    expect(Object.keys(scene.nodes).sort()).toEqual(
      [BYSTANDER, FRAME, INSIDE, N].sort(),
    );
    // Either way the note ends in the Frame where A dropped it: B's move did
    // not change the container A read the note in.
    expect(scene.nodes[N].parentId).toBe(FRAME);
    expect(
      isAt(at, wantedByA),
      `the note is where A dropped it: ${JSON.stringify({ at, wantedByA })}`,
    ).toBe(true);
    expect([...scene.children[FRAME]].sort()).toEqual([INSIDE, N].sort());
    if (heldPage === 'B') {
      // B's refused move changed nothing: the note and the Frame are exactly
      // as A's drag left them, and the hug Frame did not grow.
      expectUnchanged(scene, committed, [N, FRAME, INSIDE]);
      // B's request said what the move was made on: the Space before A's
      // drag, although B had received that drag by the time it was sent.
      const sent = (
        b.executes as {
          commands?: { type?: string }[];
          runs?: { start: number; count: number; basis: string }[];
        }[]
      ).find((body) =>
        body.commands?.some((command) => command.type === 'SET_NODE_GEOMETRY'),
      );
      expect(sent?.runs).toHaveLength(1);
      expect(readVersionOf(sent?.runs?.[0]?.basis)).toBeLessThan(
        committedVersion,
      );
      expect(b.outcomes.flat()).toContain('stale-parent');
    }
    await closeBoth(session);
  });
}

for (const heldPage of ['A', 'B'] as const) {
  test(`11. A drags a note out of a Frame while B moves it inside the Frame (${heldPage}'s request arrives last): ${
    heldPage === 'A'
      ? "A's drag is applied whole"
      : "A's drag stands and B's move is refused"
  }`, async ({ browser, request }) => {
    const race = await startRace(
      browser,
      request,
      'Race move inside',
      filledFrameSeed,
    );
    const { session } = race;
    const { a, b, canvasId } = session;
    const noteOn = async (device: Device) =>
      (await pageState(device.page)).scene.nodes[C[0]];
    /** A's edit: onto empty canvas left of the Frame. */
    const outOfFrame = async () => {
      await dragTo(a.page, C[0], { x: 400, y: 330 });
      await expect.poll(async () => (await noteOn(a)).parentId).toBeNull();
      return (await domRects(a.page))[C[0]];
    };
    /** B's edit: a short move that stays inside the Frame. */
    const insideFrame = async () => {
      const start = (await domRects(b.page))[C[0]];
      await dragBy(b.page, C[0], 30, 150);
      await expect
        .poll(async () => (await domRects(b.page))[C[0]].y)
        .toBeGreaterThan(start.y + 100);
      expect((await noteOn(b)).parentId).toBe(FRAME);
      return (await domRects(b.page))[C[0]];
    };

    const holder = heldPage === 'A' ? a : b;
    const held = await holder.hold();
    let wantedByA: Rect;
    let wantedByB: Rect;
    if (heldPage === 'A') {
      wantedByA = await outOfFrame();
      await expect.poll(held.held).toBeGreaterThan(0);
      wantedByB = await insideFrame();
    } else {
      wantedByB = await insideFrame();
      await expect.poll(held.held).toBeGreaterThan(0);
      wantedByA = await outOfFrame();
    }
    let committed: Scene | undefined;
    await expect(async () => {
      const server = await serverScene(request, canvasId);
      expect((await pageState(holder.page)).version).toBe(server.version);
      if (heldPage === 'A') {
        expect(server.scene.nodes[C[0]].parentId).toBe(FRAME);
        expect(isAt(absolute(server.scene, C[0]), wantedByB)).toBe(true);
      } else expect(server.scene.nodes[C[0]].parentId).toBeNull();
      committed = server.scene;
    }).toPass({ timeout: 10_000 });
    if (!committed) throw new Error('unreachable');
    // The waiting page shows its own edit, whole.
    const own = heldPage === 'A' ? wantedByA : wantedByB;
    const shown = (await domRects(holder.page))[C[0]];
    expect(
      isAt(shown, own),
      `${heldPage} kept showing its own edit while its request was unanswered: ${JSON.stringify({ shown, own })}`,
    ).toBe(true);
    expect((await noteOn(holder)).parentId).toBe(
      heldPage === 'A' ? null : FRAME,
    );
    held.release();

    const scene =
      heldPage === 'A'
        ? await expectBothTaken(request, race)
        : await expectRefused(request, race, 'b');
    expect(Object.keys(scene.nodes).sort()).toEqual(
      [BYSTANDER, FRAME, C[0], C[1]].sort(),
    );
    // Either way the note ends on the canvas where A dropped it.
    expect(scene.nodes[C[0]].parentId).toBeNull();
    const at = absolute(scene, C[0]);
    expect(
      isAt(at, wantedByA),
      `the note is where A dropped it: ${JSON.stringify({ at, wantedByA })}`,
    ).toBe(true);
    expect(scene.children[FRAME]).toEqual([C[1]]);
    if (heldPage === 'B')
      expectUnchanged(scene, committed, [C[0], C[1], FRAME]);
    await closeBoth(session);
  });
}

const FRAME_2 = 'node-mpf-frame2';

/** Two free Frames, each holding a note, and one note above them. */
const twoFramesSeed = [
  {
    type: 'CREATE_NODES',
    nodes: [
      frame(FRAME, 640, 220, { width: 300, height: 300 }),
      frame(FRAME_2, 1000, 220, { width: 300, height: 300 }),
      note(N, 380, 100),
    ],
  },
  {
    type: 'CREATE_NODES',
    nodes: [
      note(INSIDE, 40, 60, { parentId: FRAME }),
      note(C[1], 40, 60, { parentId: FRAME_2 }),
    ],
  },
];

for (const heldPage of ['A', 'B'] as const) {
  const other = heldPage === 'A' ? 'B' : 'A';
  test(`12. A and B drag the same note into different Frames (${heldPage}'s request arrives last): ${other}'s drag stands and ${heldPage}'s is refused`, async ({
    browser,
    request,
  }) => {
    const race = await startRace(
      browser,
      request,
      'Race two Frames',
      twoFramesSeed,
    );
    const { session } = race;
    const { a, b, canvasId } = session;
    const targetOf = { A: FRAME, B: FRAME_2 } as const;
    const deviceOf = { A: a, B: b } as const;
    const noteOn = async (device: Device) =>
      (await pageState(device.page)).scene.nodes[N];
    /** Drag the note into the page's own Frame, below the note it holds. */
    const into = async (name: 'A' | 'B') => {
      const { page } = deviceOf[name];
      const target = await rectOf(page, targetOf[name]);
      await dragTo(page, N, {
        x: target.x + 30,
        y: target.y + target.height - 50,
      });
      await expect
        .poll(async () => (await noteOn(deviceOf[name])).parentId)
        .toBe(targetOf[name]);
      return (await domRects(page))[N];
    };

    const holder = deviceOf[heldPage];
    const held = await holder.hold();
    const wantedByHeld = await into(heldPage);
    await expect.poll(held.held).toBeGreaterThan(0);
    const wantedByOther = await into(other);
    let committed: Scene | undefined;
    await expect(async () => {
      const server = await serverScene(request, canvasId);
      expect((await pageState(holder.page)).version).toBe(server.version);
      expect(server.scene.nodes[N].parentId).toBe(targetOf[other]);
      committed = server.scene;
    }).toPass({ timeout: 10_000 });
    if (!committed) throw new Error('unreachable');
    // The waiting page shows the note in its own Frame where it dropped it.
    expect((await noteOn(holder)).parentId).toBe(targetOf[heldPage]);
    const shown = (await domRects(holder.page))[N];
    expect(
      isAt(shown, wantedByHeld),
      `${heldPage} kept showing its own edit while its request was unanswered: ${JSON.stringify({ shown, wantedByHeld })}`,
    ).toBe(true);
    held.release();

    const scene = await expectRefused(
      request,
      race,
      heldPage === 'A' ? 'a' : 'b',
    );
    expect(Object.keys(scene.nodes).sort()).toEqual(
      [BYSTANDER, FRAME, FRAME_2, INSIDE, C[1], N].sort(),
    );
    // The first drag stands, whole; the refused one moved nothing.
    expect(scene.nodes[N].parentId).toBe(targetOf[other]);
    const at = absolute(scene, N);
    expect(
      isAt(at, wantedByOther),
      `the note is where ${other} dropped it: ${JSON.stringify({ at, wantedByOther })}`,
    ).toBe(true);
    expectUnchanged(scene, committed, [N, FRAME, FRAME_2, INSIDE, C[1]]);
    expect(scene.children[targetOf[heldPage]]).toEqual([
      heldPage === 'A' ? INSIDE : C[1],
    ]);
    await closeBoth(session);
  });
}

test("13. B moves a note inside a Frame while A drags it out of the Frame and back in: the note is in the Frame again, but not as B read it, so B's move is refused", async ({
  browser,
  request,
}) => {
  const race = await startRace(
    browser,
    request,
    'Race out and back',
    filledFrameSeed,
  );
  const { session } = race;
  const { a, b, canvasId } = session;
  const noteOn = async (device: Device) =>
    (await pageState(device.page)).scene.nodes[C[0]];
  const before = await serverScene(request, canvasId);

  const held = await b.hold();
  const start = (await domRects(b.page))[C[0]];
  await dragBy(b.page, C[0], 30, 150);
  await expect
    .poll(async () => (await domRects(b.page))[C[0]].y)
    .toBeGreaterThan(start.y + 100);
  const wantedByB = (await domRects(b.page))[C[0]];
  await expect.poll(held.held).toBeGreaterThan(0);

  // A: out of the Frame …
  await dragTo(a.page, C[0], { x: 400, y: 330 });
  await expect.poll(async () => (await noteOn(a)).parentId).toBeNull();
  await expect
    .poll(async () => (await serverScene(request, canvasId)).version)
    .toBeGreaterThan(before.version);
  // … and back in.
  const frameRect = await rectOf(a.page, FRAME);
  await dragTo(a.page, C[0], {
    x: frameRect.x + 30,
    y: frameRect.y + frameRect.height - 50,
  });
  await expect.poll(async () => (await noteOn(a)).parentId).toBe(FRAME);
  const wantedByA = (await domRects(a.page))[C[0]];

  // Both of A's edits are committed and have reached B.
  let committed: Scene | undefined;
  await expect(async () => {
    const server = await serverScene(request, canvasId);
    expect(server.version).toBeGreaterThanOrEqual(before.version + 2);
    expect((await pageState(b.page)).version).toBe(server.version);
    expect(server.scene.nodes[C[0]].parentId).toBe(FRAME);
    expect(isAt(absolute(server.scene, C[0]), wantedByA)).toBe(true);
    committed = server.scene;
  }).toPass({ timeout: 10_000 });
  if (!committed) throw new Error('unreachable');
  // B still shows its own move, whole.
  expect((await noteOn(b)).parentId).toBe(FRAME);
  expect(isAt((await domRects(b.page))[C[0]], wantedByB)).toBe(true);
  held.release();

  const scene = await expectRefused(request, race, 'b');
  expect(b.outcomes.flat()).toContain('stale-parent');
  expect(b.outcomes.flat()).not.toContain('applied');
  expect(Object.keys(scene.nodes).sort()).toEqual(
    [BYSTANDER, FRAME, C[0], C[1]].sort(),
  );
  // The note is where A dropped it the second time; B's move changed nothing.
  expect(scene.nodes[C[0]].parentId).toBe(FRAME);
  const at = absolute(scene, C[0]);
  expect(
    isAt(at, wantedByA),
    `the note is where A dropped it: ${JSON.stringify({ at, wantedByA })}`,
  ).toBe(true);
  expectUnchanged(scene, committed, [C[0], C[1], FRAME]);
  await closeBoth(session);
});

for (const heldPage of ['A', 'B'] as const) {
  test(`14. A deletes a note while B moves it (${heldPage}'s request arrives last): ${
    heldPage === 'A'
      ? 'both are taken and the note is gone'
      : "the note is gone and B's move is refused"
  }`, async ({ browser, request }) => {
    const race = await startRace(
      browser,
      request,
      'Race delete',
      freeFrameSeed,
    );
    const { session } = race;
    const { a, b, canvasId } = session;
    /** A's edit. */
    const remove = async () => {
      await nodeOn(a.page, N).click({ position: { x: 80, y: 10 } });
      await expect(nodeOn(a.page, N)).toHaveClass(/selected/);
      await a.page.keyboard.press('Backspace');
      await expect(nodeOn(a.page, N)).toHaveCount(0);
    };
    /** B's edit. */
    const move = async () => {
      const start = (await pageState(b.page)).scene.nodes[N];
      await dragBy(b.page, N, 20, 220);
      await expect
        .poll(async () => (await pageState(b.page)).scene.nodes[N]?.y)
        .toBeGreaterThan(start.y + 150);
    };

    const holder = heldPage === 'A' ? a : b;
    const held = await holder.hold();
    if (heldPage === 'A') {
      await remove();
      await expect.poll(held.held).toBeGreaterThan(0);
      await move();
    } else {
      await move();
      await expect.poll(held.held).toBeGreaterThan(0);
      await remove();
    }
    // The other page's edit is committed and has reached the waiting page.
    const before = await serverScene(request, canvasId);
    await expect(async () => {
      const server = await serverScene(request, canvasId);
      expect((await pageState(holder.page)).version).toBe(server.version);
      if (heldPage === 'A') expect(server.scene.nodes[N]).toBeDefined();
      else expect(server.scene.nodes[N]).toBeUndefined();
    }).toPass({ timeout: 10_000 });
    expect(before.version).toBeGreaterThan(0);
    held.release();

    const scene =
      heldPage === 'A'
        ? await expectBothTaken(request, race)
        : await expectRefused(request, race, 'b');
    // Either way the note is gone, everywhere, and nothing else is.
    expect(Object.keys(scene.nodes).sort()).toEqual(
      [BYSTANDER, FRAME, INSIDE].sort(),
    );
    for (const device of [a, b])
      await expect(nodeOn(device.page, N)).toHaveCount(0);
    if (heldPage === 'B') {
      expect(b.outcomes.flat()).toContain('stale-target');
      expect(b.outcomes.flat()).not.toContain('applied');
    } else {
      expect(a.outcomes.flat()).toContain('applied');
      expect(a.outcomes.flat()).not.toContain('stale-target');
    }
    await closeBoth(session);
  });
}

test('15. A drags a note into a Frame, inside it and out again before its first request is answered: every drag is taken, and nobody is told anything', async ({
  browser,
  request,
}) => {
  const race = await startRace(
    browser,
    request,
    'Consecutive drags',
    freeFrameSeed,
  );
  const { session } = race;
  const { a, canvasId } = session;
  const noteOn = async () => (await pageState(a.page)).scene.nodes[N];
  const before = await serverScene(request, canvasId);

  const held = await a.hold();
  const frameRect = await rectOf(a.page, FRAME);
  await dragTo(a.page, N, {
    x: frameRect.x + 30,
    y: frameRect.y + frameRect.height - 50,
  });
  await expect.poll(async () => (await noteOn()).parentId).toBe(FRAME);
  await expect.poll(held.held).toBeGreaterThan(0);
  const inside = (await domRects(a.page))[N];
  await dragBy(a.page, N, 150, -30);
  await expect
    .poll(async () => (await domRects(a.page))[N].x)
    .toBeGreaterThan(inside.x + 100);
  expect((await noteOn()).parentId).toBe(FRAME);
  await dragTo(a.page, N, { x: 400, y: 330 });
  await expect.poll(async () => (await noteOn()).parentId).toBeNull();
  const wanted = (await domRects(a.page))[N];
  // Nothing has reached the server yet.
  expect((await serverScene(request, canvasId)).version).toBe(before.version);
  held.release();

  const scene = await expectBothTaken(request, race);
  expect(scene.nodes[N].parentId).toBeNull();
  const at = absolute(scene, N);
  expect(
    isAt(at, wanted),
    `the note is where A dropped it last: ${JSON.stringify({ at, wanted })}`,
  ).toBe(true);
  expect(scene.children[FRAME]).toEqual([INSIDE]);
  // The later drags were sent quoting the version from before the first,
  // and the first — this page's own — was not held against them.
  const outcomes = a.outcomes.flat();
  expect(outcomes.length).toBeGreaterThan(1);
  expect(
    outcomes.filter((outcome) => outcome !== 'applied' && outcome !== 'no-op'),
  ).toEqual([]);
  const quoted = (a.executes as { runs?: { basis: string }[] }[]).flatMap(
    (body) => (body.runs ?? []).map((run) => readVersionOf(run.basis)),
  );
  expect(quoted.length).toBeGreaterThan(1);
  expect(new Set(quoted)).toEqual(new Set([before.version]));
  await closeBoth(session);
});
