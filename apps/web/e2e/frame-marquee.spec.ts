// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { openNewCanvas, readViewportTransform, translateOf } from './helpers';

import type {
  CanvasCommand,
  CanvasNodeCreateInput,
  CanvasNodeId,
  GetCanvasResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

const names = ['frame', 'first', 'second'] as const;
type Ids = Record<(typeof names)[number], CanvasNodeId>;
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
const fixtures = new WeakMap<Page, Ids>();

function canvasId(page: Page) {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  if (!id) throw new Error('Expected an isolated production Canvas');
  return id;
}

async function persisted(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as GetCanvasResponse).state as {
    nodes: Node[];
  };
}

async function execute(page: Page, commands: CanvasCommand[]) {
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands,
        originator: { source: 'agent', threadId: 'e2e-frame-marquee' },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function selectedIds(page: Page) {
  return page
    .locator('.react-flow__node.selected')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-id')).sort(),
    );
}

async function selection(page: Page, ids: string[]) {
  await expect.poll(() => selectedIds(page)).toEqual([...ids].sort());
}

async function rects(page: Page, ids: Ids) {
  const result = {} as Record<keyof Ids, Rect>;
  for (const name of names) {
    const rect = await node(page, ids[name]).boundingBox();
    if (!rect) throw new Error(`Missing ${name} rectangle`);
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

async function stableViewport(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        let previous = '';
        let stable = 0;
        const tick = () => {
          const current = (
            document.querySelector('.react-flow__viewport') as HTMLElement
          )?.style.transform;
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 12) resolve(true);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function seed(page: Page, zoom: number) {
  // Match nested-selection-chrome's real API + persisted viewport fixture.
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const inputs: CanvasNodeCreateInput[] = [
    {
      nodeType: 'frame',
      data: { label: 'frame', sizing: 'manual', layoutMode: 'free' },
      position: { x: 300, y: 240 },
      size: { width: 520, height: 340 },
    },
    ...(['first', 'second'] as const).map((label, index) => ({
      nodeType: 'note' as const,
      data: { label, content: `${label} child`, heightMode: 'fixed' as const },
      position: { x: 340 + index * 240, y: 340 + index * 50 },
      size: { width: 180, height: 120 },
    })),
  ];
  await execute(page, [{ type: 'CREATE_NODES', nodes: inputs }]);
  const created = (await persisted(page)).nodes;
  const ids = Object.fromEntries(
    names.map((name) => {
      const entry = created.find((candidate) => candidate.data.label === name);
      if (!entry) throw new Error(`Missing ${name}`);
      return [name, entry.id];
    }),
  ) as Ids;
  fixtures.set(page, ids);
  await execute(page, [
    {
      type: 'SET_NODE_PARENT',
      nodeIds: [ids.first, ids.second],
      parentId: ids.frame,
    },
  ]);
  const saved = (await persisted(page)).nodes;
  for (const id of [ids.first, ids.second]) {
    expect(saved.find((entry) => entry.id === id)?.parentId).toBe(ids.frame);
  }
  const frame = saved.find((entry) => entry.id === ids.frame);
  if (!frame) throw new Error('Missing Frame');
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
    { id: canvasId(page), position: frame.position, zoom },
  );
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(node(page, ids.first)).toContainText('first child');
  await expect(node(page, ids.second)).toContainText('second child');
  await expect
    .poll(() => readViewportTransform(page))
    .toContain(`scale(${zoom})`);
  await stableViewport(page);
  await page.mouse.click(1800, 950);
  await selection(page, []);
  return ids;
}

async function capture(page: Page, testInfo: TestInfo, label: string) {
  // Read only public DOM geometry and the persisted API; never inject a store.
  const evidence = await page.evaluate(() => {
    const inspect = (selector: string) =>
      Array.from(document.querySelectorAll(selector), (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return {
          id: element.getAttribute('data-id'),
          className: element.getAttribute('class'),
          rect: { x, y, width, height },
          style: element.getAttribute('style'),
        };
      });
    return {
      nodes: inspect('.react-flow__node'),
      marquee: inspect('.react-flow__selection'),
      retained: inspect('.react-flow__nodesselection-rect'),
      hud: inspect('[data-multi-selection]'),
      canvas: inspect('[data-canvas-root]'),
      activeElement: document.activeElement?.outerHTML.slice(0, 1000),
      captured: Array.from(document.querySelectorAll('*'))
        .filter((element) => element.hasPointerCapture(1))
        .map((element) => ({
          tag: element.tagName,
          className: element.getAttribute('class'),
        })),
    };
  });
  const data = {
    label,
    ids: fixtures.get(page),
    viewport: await readViewportTransform(page),
    selected: await selectedIds(page),
    persisted: await persisted(page),
    ...evidence,
  };
  await testInfo.attach(`${label}-rects`, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  });
  const path = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path });
  await testInfo.attach(label, { path, contentType: 'image/png' });
}

function blank(r: Record<keyof Ids, Rect>, zoom: number): Point {
  // Parent assignment fits the Frame to its children. Stay in the header/body
  // gap, not the newly exposed left resize edge after selecting the Frame.
  return { x: r.first.x + r.first.width / 2, y: r.first.y - 12 * zoom };
}

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

async function press(page: Page, at: Point, owner?: string) {
  if (owner) {
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id'),
        at,
      ),
    ).toBe(owner);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest(
              '.react-flow__resize-control, .react-flow__handle, input, button, [contenteditable="true"]',
            ) !== null,
        at,
      ),
      'Body gesture must not hit a title, resize control, or connection port',
    ).toBe(false);
  }
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
}

async function move(page: Page, at: Point) {
  await page.mouse.move(at.x, at.y, { steps: 12 });
}

async function sameRects(
  page: Page,
  ids: Ids,
  expected: Record<keyof Ids, Rect>,
) {
  await expect
    .poll(async () => {
      const actual = await rects(page, ids);
      return Math.max(
        ...names.flatMap((name) =>
          (['x', 'y', 'width', 'height'] as const).map((axis) =>
            Math.abs(actual[name][axis] - expected[name][axis]),
          ),
        ),
      );
    })
    .toBeLessThan(0.1);
}

async function undo(
  page: Page,
  ids: Ids,
  before: Record<keyof Ids, Rect>,
  saved: Node[],
) {
  await page.keyboard.press('ControlOrMeta+z');
  await sameRects(page, ids, before);
  await expect
    .poll(async () => geometry((await persisted(page)).nodes))
    .toEqual(geometry(saved));
}

test.use({ viewport: { width: 2000, height: 1100 }, hasTouch: false });
test.beforeEach(async ({ page }) => {
  // Freeze this page's module graph against concurrent editor HMR; SSE stays real.
  await page.routeWebSocket('**/*', (socket) => socket.close());
});
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && fixtures.has(page)) {
    await capture(page, testInfo, 'failure');
  }
});

for (const tool of ['s', 'l']) {
  test(`shared area policy and cancellation with ${tool === 's' ? 'rectangle' : 'lasso'}`, async ({
    page,
  }) => {
    const ids = await seed(page, 1);
    const before = await rects(page, ids);
    await page.keyboard.press(tool);
    const draw = async (start: Point, end: Point) => {
      await press(page, start);
      if (tool === 'l') {
        await move(page, { x: end.x, y: start.y });
        await move(page, end);
        await move(page, { x: start.x, y: end.y });
        await move(page, start);
      } else {
        await move(page, end);
      }
    };

    await draw(blank(before, 1), center(before.second));
    await selection(page, [ids.first, ids.second]);
    await page.mouse.up();
    await selection(page, [ids.first, ids.second]);

    await draw(
      { x: before.frame.x - 20, y: before.frame.y - 20 },
      {
        x: before.frame.x + before.frame.width + 20,
        y: before.frame.y + before.frame.height + 20,
      },
    );
    await selection(page, [ids.frame, ids.first, ids.second]);
    await page.mouse.up();
    await selection(page, [ids.frame, ids.first, ids.second]);

    await draw({ x: 1500, y: 500 }, { x: 1600, y: 600 });
    await selection(page, []);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await selection(page, [ids.frame, ids.first, ids.second]);
    await sameRects(page, ids, before);
  });
}

for (const zoom of [0.5, 1, 2]) {
  test(`Frame blank live partial selection at ${zoom}`, async ({
    page,
  }, testInfo) => {
    const ids = await seed(page, zoom);
    const before = await rects(page, ids);
    const saved = (await persisted(page)).nodes;
    const start = blank(before, zoom);
    await press(page, start, ids.frame);
    await selection(page, []);
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    // A two-screen-pixel move must already cross the shared mouse threshold.
    await page.mouse.move(start.x + 2, start.y + 2);
    await expect(page.locator('.react-flow__selection')).toBeVisible();
    await move(page, center(before.second));
    await selection(page, [ids.first, ids.second]);
    await expect(node(page, ids.frame)).not.toHaveClass(/\bselected\b/);
    await sameRects(page, ids, before);
    await capture(page, testInfo, 'frame-partial-before-up');
    await page.mouse.up();
    await selection(page, [ids.first, ids.second]);
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await expect(
      page.locator('.react-flow__nodesselection-rect'),
    ).toBeVisible();
    expect(geometry((await persisted(page)).nodes)).toEqual(geometry(saved));
    await capture(page, testInfo, 'frame-partial-released');
  });

  test(`Frame blank click then native subtree drag persists and undoes at ${zoom}`, async ({
    page,
  }, testInfo) => {
    const ids = await seed(page, zoom);
    const before = await rects(page, ids);
    const saved = (await persisted(page)).nodes;
    const start = blank(before, zoom);
    await press(page, start, ids.frame);
    await selection(page, []);
    await page.mouse.up();
    await selection(page, [ids.frame]);
    await expect(page.locator('.react-flow__nodesselection-rect')).toHaveCount(
      0,
    );
    await press(page, start, ids.frame);
    await move(page, { x: start.x + 63, y: start.y + 43 });
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    const moving = await rects(page, ids);
    const delta = {
      x: moving.frame.x - before.frame.x,
      y: moving.frame.y - before.frame.y,
    };
    expect(delta.x).toBeGreaterThan(20);
    expect(delta.y).toBeGreaterThan(15);
    for (const name of names) {
      expect(moving[name].x - before[name].x).toBeCloseTo(delta.x, 1);
      expect(moving[name].y - before[name].y).toBeCloseTo(delta.y, 1);
    }
    await capture(page, testInfo, 'native-frame-drag-before-up');
    await page.mouse.up();
    await sameRects(page, ids, moving);
    await expect
      .poll(async () => {
        const actual = (await persisted(page)).nodes;
        return names.every((name) => {
          const original = saved.find((entry) => entry.id === ids[name]);
          const current = actual.find((entry) => entry.id === ids[name]);
          if (!original || !current || original.parentId !== current.parentId)
            return false;
          return (
            Math.abs(
              current.position.x -
                original.position.x -
                (name === 'frame' ? delta.x / zoom : 0),
            ) < 0.1 &&
            Math.abs(
              current.position.y -
                original.position.y -
                (name === 'frame' ? delta.y / zoom : 0),
            ) < 0.1
          );
        });
      })
      .toBe(true);
    await undo(page, ids, before, saved);
    await capture(page, testInfo, 'native-frame-drag-undone');
  });

  test(`Child body retains native drag inside unselected Frame at ${zoom}`, async ({
    page,
  }, testInfo) => {
    const ids = await seed(page, zoom);
    const before = await rects(page, ids);
    const saved = (await persisted(page)).nodes;
    const start = center(before.first);
    await press(page, start, ids.first);
    await move(page, { x: start.x + 24 * zoom, y: start.y + 18 * zoom });
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await selection(page, [ids.first]);
    await capture(page, testInfo, 'child-drag-before-up');
    await page.mouse.up();
    const after = await rects(page, ids);
    const dx = (after.first.x - before.first.x) / zoom;
    const dy = (after.first.y - before.first.y) / zoom;
    expect(dx).toBeGreaterThan(10);
    expect(dy).toBeGreaterThan(5);
    await sameRects(page, ids, { ...before, first: after.first });
    await expect
      .poll(async () => {
        const actual = (await persisted(page)).nodes;
        return names.every((name) => {
          const original = saved.find((entry) => entry.id === ids[name]);
          const current = actual.find((entry) => entry.id === ids[name]);
          if (!original || !current || original.parentId !== current.parentId)
            return false;
          return (
            Math.abs(
              current.position.x -
                original.position.x -
                (name === 'first' ? dx : 0),
            ) < 0.1 &&
            Math.abs(
              current.position.y -
                original.position.y -
                (name === 'first' ? dy : 0),
            ) < 0.1
          );
        });
      })
      .toBe(true);
    await undo(page, ids, before, saved);
    await capture(page, testInfo, 'child-drag-undone');
  });

  test(`Pane full enclosure shrinks live; Escape restores and recovers at ${zoom}`, async ({
    page,
  }, testInfo) => {
    const ids = await seed(page, zoom);
    const before = await rects(page, ids);
    const saved = (await persisted(page)).nodes;
    const start = { x: before.frame.x - 24, y: before.frame.y - 24 };
    const full = {
      x: before.frame.x + before.frame.width + 24,
      y: before.frame.y + before.frame.height + 24,
    };
    await press(page, start);
    await move(page, full);
    await selection(page, Object.values(ids));
    await capture(page, testInfo, 'pane-full-before-up');
    await move(page, center(before.second));
    await selection(page, [ids.first, ids.second]);
    await capture(page, testInfo, 'pane-shrink-before-up');
    await page.mouse.up();
    await selection(page, [ids.first, ids.second]);
    await press(page, start);
    await move(page, full);
    await selection(page, Object.values(ids));
    await page.keyboard.press('Escape');
    await selection(page, [ids.first, ids.second]);
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await page.mouse.up();
    await selection(page, [ids.first, ids.second]);
    await capture(page, testInfo, 'escape-restored-after-up');
    await press(page, start);
    await move(page, full);
    await selection(page, Object.values(ids));
    await page.mouse.up();
    await selection(page, Object.values(ids));
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await expect(
      page.locator('.react-flow__nodesselection-rect'),
    ).toBeVisible();
    await expect(page.locator('[data-multi-resize-control]')).toHaveCount(4);
    await sameRects(page, ids, before);
    expect(geometry((await persisted(page)).nodes)).toEqual(geometry(saved));
    await capture(page, testInfo, 'recovery-frame-and-children');
  });
}

test('Captured marquee auto-pans; Escape cancels and Select recovers', async ({
  page,
}, testInfo) => {
  const ids = await seed(page, 1);
  const initial = await rects(page, ids);
  const saved = (await persisted(page)).nodes;
  const start = blank(initial, 1);
  const flow = await page.locator('.react-flow').boundingBox();
  if (!flow) throw new Error('Missing Canvas');
  const viewport = translateOf(await readViewportTransform(page));
  await press(page, start, ids.frame);
  // Hold the real captured pointer at the edge, without synthetic event replay.
  await move(page, {
    x: flow.x + flow.width - 8,
    y: initial.second.y + initial.second.height / 2,
  });
  await expect
    .poll(async () => translateOf(await readViewportTransform(page)).x)
    .toBeLessThan(viewport.x - 20);
  await expect(page.locator('.react-flow__selection')).toBeVisible();
  // Stop at a safe point before artifact IO so screenshot latency cannot pan
  // the fixture entirely offscreen and invalidate the recovery hit target.
  await move(page, {
    x: flow.x + flow.width - 150,
    y: initial.second.y + initial.second.height / 2,
  });
  await stableViewport(page);
  await capture(page, testInfo, 'autopan-before-cancel');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await selection(page, []);
  await expect(page.locator('.react-flow__selection')).toHaveCount(0);
  await stableViewport(page);
  const panned = translateOf(await readViewportTransform(page));
  expect(panned.x).toBeLessThan(viewport.x - 20);
  const r = await rects(page, ids);
  await press(page, blank(r, 1), ids.frame);
  await move(page, center(r.second));
  await selection(page, [ids.first, ids.second]);
  await page.mouse.up();
  await selection(page, [ids.first, ids.second]);
  expect(geometry((await persisted(page)).nodes)).toEqual(geometry(saved));
  await capture(page, testInfo, 'autopan-select-recovered');
});

test('Space owns native navigation on a fresh Canvas and Select recovers', async ({
  page,
}, testInfo) => {
  const ids = await seed(page, 1);
  const saved = (await persisted(page)).nodes;
  const flow = await page.locator('.react-flow').boundingBox();
  if (!flow) throw new Error('Missing Canvas');
  const panned = translateOf(await readViewportTransform(page));
  const panStart = {
    x: flow.x + flow.width - 250,
    y: flow.y + flow.height - 200,
  };
  await page.keyboard.down('Space');
  // Keep the failed tool-state assertion, but still exercise the actual native
  // drag so evidence distinguishes stale toolbar paint from broken navigation.
  await expect
    .soft(page.getByRole('button', { name: /^Pan \(/ }))
    .toBeVisible();
  await press(page, panStart);
  await move(page, { x: panStart.x + 41, y: panStart.y + 29 });
  await capture(page, testInfo, 'space-drag-before-up');
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect
    .poll(async () => {
      const now = translateOf(await readViewportTransform(page));
      return Math.max(
        Math.abs(now.x - panned.x - 41),
        Math.abs(now.y - panned.y - 29),
      );
    })
    .toBeLessThan(0.1);
  await selection(page, []);
  await expect(page.locator('.react-flow__selection')).toHaveCount(0);
  const r = await rects(page, ids);
  await press(page, blank(r, 1), ids.frame);
  await move(page, center(r.second));
  await selection(page, [ids.first, ids.second]);
  await page.mouse.up();
  await selection(page, [ids.first, ids.second]);
  expect(geometry((await persisted(page)).nodes)).toEqual(geometry(saved));
  await capture(page, testInfo, 'space-select-recovered');
});
