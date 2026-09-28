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

const artifactRoot = '/tmp/huabu-nested-selection-diagnosis';
const names = ['frame', 'first', 'second'] as const;
type Ids = Record<(typeof names)[number], CanvasNodeId>;
type Rect = { x: number; y: number; width: number; height: number };
const axes = ['x', 'y', 'width', 'height'] as const;

function canvasId(page: Page) {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  if (!id) throw new Error('Expected an isolated real Canvas');
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
        originator: { source: 'agent', threadId: 'e2e-nested-selection' },
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

async function toggleFrameInLayers(page: Page) {
  // The persistent native rectangle owns canvas hits after marquee. Use the
  // real layer row, not force-clicking through that rectangle or store writes.
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await page
    .getByText('frame', { exact: true })
    .filter({ visible: true })
    .click({ modifiers: ['Meta'] });
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Show layers panel', exact: true }),
  ).toBeVisible();
}

async function seed(page: Page, zoom: number): Promise<Ids> {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const fixtures: CanvasNodeCreateInput[] = [
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
  await execute(page, [{ type: 'CREATE_NODES', nodes: fixtures }]);
  const created = (await persisted(page)).nodes;
  const ids = Object.fromEntries(
    names.map((name) => {
      const entry = created.find((candidate) => candidate.data.label === name);
      if (!entry) throw new Error(`Missing ${name}`);
      return [name, entry.id];
    }),
  ) as Ids;
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
  // Use the application's persisted viewport contract, not a store mutation.
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
  return ids;
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

async function capture(
  page: Page,
  ids: Ids,
  label: string,
  testInfo: TestInfo,
) {
  const dom = await page.evaluate((ids) => {
    function inspect(element: Element) {
      const { x, y, width, height } = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return {
        rect: { x, y, width, height },
        className: element.getAttribute('class'),
        style: element.getAttribute('style'),
        css: {
          width: css.width,
          height: css.height,
          transform: css.transform,
          background: css.backgroundColor,
          border: css.border,
          boxShadow: css.boxShadow,
          outline: css.outline,
          opacity: css.opacity,
          pointerEvents: css.pointerEvents,
          zIndex: css.zIndex,
        },
      };
    }
    const all = (selector: string) =>
      Array.from(document.querySelectorAll(selector), inspect);
    const nodes = Object.fromEntries(
      Object.entries(ids).map(([name, id]) => {
        const element = document.querySelector(
          `.react-flow__node[data-id="${id}"]`,
        );
        if (!element) throw new Error(`Missing ${name}`);
        // Read-only React props expose the measured dimensions and absolute
        // coordinates XYFlow passes to its real node renderer. Never set state.
        type Fiber = {
          memoizedProps?: Record<string, unknown>;
          child?: Fiber;
          sibling?: Fiber;
        };
        const key = Object.keys(element).find((key) =>
          key.startsWith('__reactFiber$'),
        );
        const fiber = key
          ? (element as unknown as Record<string, Fiber>)[key]
          : undefined;
        function findProps(
          current: Fiber | undefined,
        ): Record<string, unknown> | null {
          if (!current) return null;
          const props = current.memoizedProps;
          if (props?.id === id && 'positionAbsoluteX' in props) {
            return Object.fromEntries(
              [
                'id',
                'type',
                'selected',
                'parentId',
                'width',
                'height',
                'positionAbsoluteX',
                'positionAbsoluteY',
              ].map((key) => [key, props[key]]),
            );
          }
          return findProps(current.child) ?? findProps(current.sibling);
        }
        return [
          name,
          { id, ...inspect(element), rfRendererProps: findProps(fiber?.child) },
        ];
      }),
    );
    return {
      nodes,
      native: all('.react-flow__nodesselection-rect'),
      nativeContainer: all('.react-flow__nodesselection'),
      marquee: all('.react-flow__selection'),
      custom: all('[data-multi-selection]'),
      dashed: all('[data-multi-selection] [data-selection-outline="dashed"]'),
      svg: all('[data-multi-selection] svg'),
      outlines: Object.fromEntries(
        Object.entries(ids).map(([name, id]) => [
          name,
          all(`[data-node-selection-outline="${id}"]`),
        ]),
      ),
      controls: Array.from(
        document.querySelectorAll('[data-multi-resize-control]'),
        (element) => {
          const grip = element.querySelector('[data-resize-grip]');
          const r = element.getBoundingClientRect();
          return {
            corner: element.getAttribute('data-multi-resize-control'),
            ...inspect(element),
            grip: grip ? inspect(grip) : null,
            ownsCenter:
              document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              ) === element,
          };
        },
      ),
      singleControls: all('.react-flow__resize-control'),
      singleGrips: all('[data-node-resize-grip]'),
    };
  }, ids);
  const diagnosis = {
    label,
    ids,
    selected: await selectedIds(page),
    viewport: await readViewportTransform(page),
    persisted: (await persisted(page)).nodes.map(
      ({ id, parentId, position, measured, width, height, style }) => ({
        id,
        parentId,
        position,
        measured,
        width,
        height,
        style,
      }),
    ),
    ...dom,
  };
  console.log(`NESTED_SELECTION ${JSON.stringify(diagnosis)}`);
  await testInfo.attach(label, {
    body: JSON.stringify(diagnosis, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: `${artifactRoot}/${label}.png` });
  return diagnosis;
}

function sameRect(actual: Rect, expected: Rect, label: string) {
  for (const axis of axes) {
    expect
      .soft(Math.abs(actual[axis] - expected[axis]), `${label}.${axis}`)
      .toBeLessThan(0.1);
  }
}

function assertChrome(
  d: Awaited<ReturnType<typeof capture>>,
  includesFrame: boolean,
) {
  const children = union([d.nodes.first.rect, d.nodes.second.rect]);
  const selectedUnion = includesFrame
    ? union([children, d.nodes.frame.rect])
    : children;
  // Native selection is gesture-dependent. If present, it must use the same
  // actual selected-node union, not parent-local coordinates as world space.
  for (const entry of d.native)
    sameRect(entry.rect, selectedUnion, `${d.label}: native`);
  for (const entry of d.native) {
    expect(entry.css.background).toBe('rgba(0, 0, 0, 0)');
    expect(entry.css.border).toContain('0px');
    expect(entry.css.boxShadow).toBe('none');
    expect(entry.css.pointerEvents).toBe('none');
  }
  for (const name of names) {
    expect
      .soft(d.outlines[name].length, `${d.label}: ${name} outline`)
      .toBe(name === 'frame' && !includesFrame ? 0 : 1);
    for (const outline of d.outlines[name])
      sameRect(outline.rect, d.nodes[name].rect, `${d.label}: ${name} outline`);
  }
  expect.soft(d.custom.length, `${d.label}: custom root count`).toBe(1);
  expect.soft(d.controls.length, `${d.label}: controls`).toBe(4);
  expect
    .soft(d.singleControls.length, `${d.label}: single controls suppressed`)
    .toBe(0);
  expect
    .soft(d.singleGrips.length, `${d.label}: single grips suppressed`)
    .toBe(0);
  for (const entry of [...d.custom, ...d.dashed, ...d.svg])
    sameRect(entry.rect, selectedUnion, `${d.label}: selected union`);
  for (const control of d.controls) {
    const corner = control.corner ?? '';
    const x =
      selectedUnion.x + (corner.endsWith('r') ? selectedUnion.width : 0);
    const y =
      selectedUnion.y + (corner.startsWith('b') ? selectedUnion.height : 0);
    expect
      .soft(control.ownsCenter, `${d.label}: ${corner} hit owner`)
      .toBe(true);
    expect
      .soft(control.grip, `${d.label}: ${corner} painted grip`)
      .not.toBeNull();
    for (const [rect, size] of [
      [control.rect, 20],
      [control.grip?.rect, 8],
    ] as const) {
      if (!rect) continue;
      expect
        .soft(
          Math.abs(rect.x + rect.width / 2 - x),
          `${d.label}: ${corner} center x`,
        )
        .toBeLessThan(0.1);
      expect
        .soft(
          Math.abs(rect.y + rect.height / 2 - y),
          `${d.label}: ${corner} center y`,
        )
        .toBeLessThan(0.1);
      expect.soft(rect.width).toBeCloseTo(size, 2);
      expect.soft(rect.height).toBeCloseTo(size, 2);
    }
  }
}

async function pan(page: Page) {
  // Opening/closing Layers may animate the viewport; wait for that layout
  // handoff before measuring a separate pan gesture.
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
  const before = translateOf(await readViewportTransform(page));
  const pane = await page.locator('.react-flow').boundingBox();
  if (!pane) throw new Error('Missing canvas');
  const start = { x: pane.x + pane.width - 100, y: pane.y + pane.height - 150 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(start.x + 37, start.y + 23, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => {
      const after = translateOf(await readViewportTransform(page));
      return Math.max(
        Math.abs(after.x - before.x - 37),
        Math.abs(after.y - before.y - 23),
      );
    })
    .toBeLessThan(0.001);
}

test.use({ viewport: { width: 2000, height: 1100 } });
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
});

for (const zoom of [0.5, 1, 2]) {
  test(`nested selection chrome at ${zoom}: children versus Frame and children`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const ids = await seed(page, zoom);
    const children = [ids.first, ids.second].sort();
    // Deliberately include the Frame using a native marquee, then separately
    // remove it with a modifier click. Never infer the selected set from paint.
    await page.mouse.click(1800, 950);
    await expect.poll(() => selectedIds(page)).toEqual([]);
    const frame = await node(page, ids.frame).boundingBox();
    if (!frame) throw new Error('Missing Frame rectangle');
    await page.mouse.move(frame.x - 24, frame.y - 24);
    await page.mouse.down();
    await page.mouse.move(
      frame.x + frame.width + 24,
      frame.y + frame.height + 24,
      { steps: 12 },
    );
    await page.mouse.up();
    const allSelected = await capture(
      page,
      ids,
      `${zoom}-marquee-frame-and-children`,
      testInfo,
    );
    await expect
      .poll(() => selectedIds(page))
      .toEqual(Object.values(ids).sort());
    assertChrome(allSelected, true);
    await pan(page);
    await expect
      .poll(() => selectedIds(page))
      .toEqual(Object.values(ids).sort());
    assertChrome(
      await capture(
        page,
        ids,
        `${zoom}-marquee-frame-and-children-panned`,
        testInfo,
      ),
      true,
    );
    await toggleFrameInLayers(page);
    const childrenSelected = await capture(
      page,
      ids,
      `${zoom}-marquee-children`,
      testInfo,
    );
    await expect.poll(() => selectedIds(page)).toEqual(children);
    assertChrome(childrenSelected, false);
    await pan(page);
    await expect.poll(() => selectedIds(page)).toEqual(children);
    assertChrome(
      await capture(page, ids, `${zoom}-marquee-children-panned`, testInfo),
      false,
    );
  });
}
