// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { openNewCanvas, readViewportTransform } from './helpers';

import type {
  CanvasCommand,
  CanvasNodeCreateInput,
  CanvasNodeId,
  GetCanvasResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

const names = ['A', 'first', 'second', 'B', 'third'] as const;
type Ids = Record<(typeof names)[number], CanvasNodeId>;
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
const fixtures = new WeakMap<Page, Ids>();

function canvasId(page: Page) {
  return new URL(page.url()).pathname.split('/canvas/')[1];
}
async function persisted(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as GetCanvasResponse).state.nodes as Node[];
}
async function execute(page: Page, commands: CanvasCommand[]) {
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands,
        originator: { source: 'agent', threadId: 'e2e-cross-frame-marquee' },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}
function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}
async function selection(page: Page, ids: string[]) {
  await expect
    .poll(() =>
      page
        .locator('.react-flow__node.selected')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-id')).sort(),
        ),
    )
    .toEqual([...ids].sort());
}
async function rects(page: Page, ids: Ids) {
  const result = {} as Record<keyof Ids, Rect>;
  for (const name of names) {
    const rect = await node(page, ids[name]).boundingBox();
    if (!rect) throw new Error(`Missing ${name}`);
    result[name] = rect;
  }
  return result;
}
function geometry(nodes: Node[]) {
  return nodes
    .map(({ id, parentId, position, width, height }) => ({
      id,
      parentId,
      position,
      width,
      height,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
function blank(r: Rect, zoom: number): Point {
  return { x: r.x + r.width / 2, y: r.y - 12 * zoom };
}
async function press(page: Page, p: Point) {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
}
async function move(page: Page, p: Point) {
  await page.mouse.move(p.x, p.y, { steps: 12 });
}
async function selectA(
  page: Page,
  ids: Ids,
  r: Record<keyof Ids, Rect>,
  zoom: number,
) {
  // At 50%, B's sole-child toolbar overlaps A's header gap. Start on
  // exposed pane instead; controls must keep priority rather than be bypassed.
  await press(page, { x: r.first.x - 30 * zoom, y: r.first.y - 60 * zoom });
  await move(page, center(r.second));
  await selection(page, [ids.first, ids.second]);
  await page.mouse.up();
  await expect(page.locator('.react-flow__nodesselection-rect')).toBeVisible();
}
async function sameRects(
  page: Page,
  ids: Ids,
  before: Record<keyof Ids, Rect>,
) {
  await expect
    .poll(async () => {
      const after = await rects(page, ids);
      return Math.max(
        ...names.flatMap((name) =>
          (['x', 'y', 'width', 'height'] as const).map((axis) =>
            Math.abs(after[name][axis] - before[name][axis]),
          ),
        ),
      );
    })
    .toBeLessThan(0.1);
}
async function capture(page: Page, info: TestInfo, label: string) {
  await info.attach(label, {
    body: JSON.stringify(
      await page.evaluate(() => ({
        selected: [
          ...document.querySelectorAll('.react-flow__node.selected'),
        ].map((n) => n.getAttribute('data-id')),
        elements: [
          ...document.querySelectorAll(
            '.react-flow__node, .react-flow__nodesselection-rect, .react-flow__selection',
          ),
        ].map((n) => ({
          id: n.getAttribute('data-id'),
          className: n.className,
          rect: n.getBoundingClientRect().toJSON(),
          pointerEvents: getComputedStyle(n).pointerEvents,
        })),
        focus: document.activeElement?.className,
      })),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath(`${label}.png`) });
}
async function seed(page: Page, zoom: number, overlapping = true) {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  // B is a distinct root Frame. In the overlap fixture its blank header lies
  // inside the A children's retained union, but its child is below the initial marquee.
  const inputs: CanvasNodeCreateInput[] = [
    {
      nodeType: 'frame',
      data: { label: 'A', sizing: 'manual', layoutMode: 'free' },
      position: { x: 300, y: 240 },
      size: { width: 900, height: 300 },
    },
    ...(['first', 'second'] as const).map((label, i) => ({
      nodeType: 'note' as const,
      data: { label, content: `${label} child`, heightMode: 'fixed' as const },
      position: { x: 340 + i * 660, y: 340 },
      size: { width: 180, height: 120 },
    })),
    {
      nodeType: 'frame',
      data: { label: 'B', sizing: 'manual', layoutMode: 'free' },
      position: { x: 650, y: 400 },
      size: { width: 240, height: 220 },
    },
    {
      nodeType: 'note',
      data: { label: 'third', content: 'third child', heightMode: 'fixed' },
      position: { x: 690, y: overlapping ? 430 : 650 },
      size: { width: 180, height: 120 },
    },
  ];
  await execute(page, [{ type: 'CREATE_NODES', nodes: inputs }]);
  const created = await persisted(page);
  const ids = Object.fromEntries(
    names.map((name) => {
      const entry = created.find((n) => n.data.label === name);
      if (!entry) throw new Error(`Missing ${name}`);
      return [name, entry.id];
    }),
  ) as Ids;
  fixtures.set(page, ids);
  await execute(page, [
    {
      type: 'SET_NODE_PARENT',
      nodeIds: [ids.first, ids.second],
      parentId: ids.A,
    },
    { type: 'SET_NODE_PARENT', nodeIds: [ids.third], parentId: ids.B },
  ]);
  const saved = await persisted(page);
  expect(saved.find((n) => n.id === ids.B)?.parentId).toBeUndefined();
  const a = saved.find((n) => n.id === ids.A);
  if (!a) throw new Error('Missing A');
  await page.addInitScript(
    ({ id, position, zoom }) => {
      if (window !== window.top) return;
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({
          x: 200 - position.x * zoom,
          y: 170 - position.y * zoom,
          zoom,
        }),
      );
    },
    { id: canvasId(page), position: a.position, zoom },
  );
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  for (const name of ['first', 'second', 'third'] as const)
    await expect(node(page, ids[name])).toContainText(`${name} child`);
  await expect
    .poll(() => readViewportTransform(page))
    .toContain(`scale(${zoom})`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.mouse.click(2200, 1250);
  await selection(page, []);
  return ids;
}

test.use({ viewport: { width: 2400, height: 1400 }, hasTouch: false });
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && fixtures.has(page))
    await capture(page, info, 'failure');
});

for (const zoom of [0.5, 1, 2]) {
  test(`cross Frame replacement is live and Escape restores at ${zoom}`, async ({
    page,
  }, info) => {
    const ids = await seed(page, zoom);
    const before = await rects(page, ids);
    const saved = geometry(await persisted(page));
    await selectA(page, ids, before, zoom);
    const start = blank(before.third, zoom);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id'),
        start,
      ),
    ).toBe(ids.B);
    const retained = await page
      .locator('.react-flow__nodesselection-rect')
      .boundingBox();
    if (!retained) throw new Error('Missing retained selection');
    expect(start.x).toBeGreaterThan(retained.x);
    expect(start.x).toBeLessThan(retained.x + retained.width);
    expect(start.y).toBeGreaterThan(retained.y);
    expect(start.y).toBeLessThan(retained.y + retained.height);
    await capture(page, info, 'before-replacement');
    for (const cancel of [false, true, false]) {
      await press(page, start);
      await selection(page, [ids.first, ids.second]);
      await expect(page.locator('.react-flow__selection')).toHaveCount(0);
      await page.mouse.move(start.x + 2, start.y + 2);
      await expect(page.locator('.react-flow__selection')).toBeVisible();
      await selection(page, []);
      await move(page, center(before.third));
      await selection(page, [ids.third]);
      await expect(node(page, ids.B)).not.toHaveClass(/\bselected\b/);
      await sameRects(page, ids, before);
      if (cancel) {
        await page.keyboard.press('Escape');
        await selection(page, [ids.first, ids.second]);
      }
      await page.mouse.up();
      await selection(page, cancel ? [ids.first, ids.second] : [ids.third]);
      await expect(page.locator('.react-flow__selection')).toHaveCount(0);
      if (!cancel) await selectA(page, ids, before, zoom);
    }
    await sameRects(page, ids, before);
    expect(geometry(await persisted(page))).toEqual(saved);
    await capture(page, info, 'replacement-and-cancel-verified');
  });

  test(`pane union gap replaces; selected Frames and children keep native group drag at ${zoom}`, async ({
    page,
  }, info) => {
    const ids = await seed(page, zoom, false);
    const r = await rects(page, ids);
    const saved = geometry(await persisted(page));
    const all = Object.values(ids);
    const start = { x: r.A.x - 25, y: r.A.y - 25 };
    const end = { x: r.A.x + r.A.width + 25, y: r.B.y + r.B.height + 25 };
    async function selectAll() {
      await press(page, start);
      await move(page, end);
      await selection(page, all);
      await page.mouse.up();
    }
    await selectAll();
    await expect(page.locator('.react-flow__nodesselection-rect')).toHaveCSS(
      'pointer-events',
      'none',
    );
    // Exposed pane, not a Frame body, inside the retained selection union.
    const gap = { x: r.B.x - 50, y: r.B.y + 25 };
    await press(page, gap);
    await selection(page, all);
    await page.mouse.move(gap.x + 2, gap.y + 2);
    await expect(page.locator('.react-flow__selection')).toBeVisible();
    await selection(page, []);
    await move(page, center(r.third));
    await selection(page, [ids.third]);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await selection(page, all);
    await sameRects(page, ids, r);
    // The retained overlay remains focused and supports native group keyboard movement.
    const retained = page.locator('.react-flow__nodesselection-rect');
    await retained.focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => (await rects(page, ids)).A.x - r.A.x)
      .toBeCloseTo(5 * zoom, 1);
    await page.keyboard.press('ArrowLeft');
    await sameRects(page, ids, r);
    // Dragging either actual Frame body or selected child preserves every selected root.
    for (const point of [blank(r.first, zoom), center(r.first)]) {
      await press(page, point);
      await move(page, { x: point.x + 33 * zoom, y: point.y + 21 * zoom });
      await expect(page.locator('.react-flow__selection')).toHaveCount(0);
      await selection(page, all);
      const moving = await rects(page, ids);
      const dx = moving.A.x - r.A.x;
      const dy = moving.A.y - r.A.y;
      expect(dx).toBeGreaterThan(10 * zoom);
      expect(dy).toBeGreaterThan(5 * zoom);
      for (const name of names) {
        expect(moving[name].x - r[name].x).toBeCloseTo(dx, 1);
        expect(moving[name].y - r[name].y).toBeCloseTo(dy, 1);
      }
      await page.mouse.up();
      await expect
        .poll(async () => geometry(await persisted(page)))
        .not.toEqual(saved);
      await page.keyboard.press('ControlOrMeta+z');
      await sameRects(page, ids, r);
      await expect
        .poll(async () => geometry(await persisted(page)))
        .toEqual(saved);
      await selectAll();
    }
    await capture(page, info, 'native-frame-and-child-group-verified');

    // Native Frame title input remains reachable even inside retained chrome.
    const title = node(page, ids.B).locator('input').first();
    await title.click();
    await expect(title).toBeEditable();
    await title.fill('B renamed');
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await title.press('Enter');
    await expect
      .poll(
        async () =>
          (await persisted(page)).find((n) => n.id === ids.B)?.data.label,
      )
      .toBe('B renamed');
    await sameRects(page, ids, r);
  });
}

test.describe('retained overlay input scope', () => {
  test.use({ hasTouch: true });

  test('touch, pen, and temporary Pan retain native overlay hit-testing', async ({
    page,
  }) => {
    const ids = await seed(page, 1);
    const r = await rects(page, ids);
    await selectA(page, ids, r, 1);
    const retained = page.locator('.react-flow__nodesselection-rect');
    await expect(retained).toHaveCSS('pointer-events', 'none');

    // An idempotent toolbar action avoids layout changes during input-mode switches.
    const select = page.getByRole('button', { name: /^Select(?: \(|$)/ });
    await select.tap();
    await selection(page, [ids.first, ids.second]);
    await expect(retained).toHaveCSS('pointer-events', 'all');
    await select.click();
    await expect(retained).toHaveCSS('pointer-events', 'none');

    const show = await select.boundingBox();
    if (!show) throw new Error('Missing Select tool');
    const point = center(show);
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'pen',
    });
    await expect(retained).toHaveCSS('pointer-events', 'all');
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen',
    });
    await select.click();
    await expect(retained).toHaveCSS('pointer-events', 'none');
    await selection(page, [ids.first, ids.second]);

    await page.locator('[data-canvas-root]').focus();
    await page.keyboard.down('Space');
    await expect(retained).toHaveCSS('pointer-events', 'all');
    await page.keyboard.up('Space');
    await expect(retained).toHaveCSS('pointer-events', 'none');
    await selection(page, [ids.first, ids.second]);
    await client.detach();
  });
});
