// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import type {
  CreateCanvasResponse,
  GetCanvasResponse,
  NodeData,
  PostCanvasExecuteRequest,
} from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

test.use({ hasTouch: false, viewport: { width: 1280, height: 900 } });
test.setTimeout(90_000);

async function createSpace(page: Page, title: string) {
  const response = await page.request.post('/api/canvas', { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const { canvasId } = (await response.json()) as CreateCanvasResponse;
  await page.addInitScript((id) => {
    if (window !== window.top) return;
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 60, y: 30, zoom: 1 }),
    );
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    );
  }, canvasId);
  return canvasId;
}

async function execute(
  page: Page,
  canvasId: string,
  commands: PostCanvasExecuteRequest['commands'],
  source: 'ui' | 'agent',
) {
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: { commands, originator: { source } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  for (const outcome of result.results) expect(outcome.applied).toBe(true);
}

async function readState(page: Page, canvasId: string) {
  const response = await page.request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return record.state as { nodes: Node<NodeData>[]; edges: Edge[] };
}

async function visibleBounds(node: Locator) {
  const bounds = await node.boundingBox();
  if (!bounds) throw new Error('Expected a visible Canvas node');
  return bounds;
}

async function pathGeometry(edge: Locator, obstacleId: string) {
  return edge.evaluate((element, id) => {
    const path = element as SVGPathElement;
    const transform = path.getScreenCTM();
    const obstacle = document.querySelector(
      `.react-flow__node[data-id="${id}"]`,
    );
    if (!transform || !obstacle) throw new Error('Missing route geometry');
    const bounds = obstacle.getBoundingClientRect();
    const length = path.getTotalLength();
    let insideObstacle = 0;
    const samples = Math.max(1, Math.ceil(length / 2));
    for (let index = 0; index <= samples; index++) {
      const point = path.getPointAtLength((length * index) / samples);
      const screen = point.matrixTransform(transform);
      if (
        screen.x > bounds.left + 2 &&
        screen.x < bounds.right - 2 &&
        screen.y > bounds.top + 2 &&
        screen.y < bounds.bottom - 2
      )
        insideObstacle++;
    }
    const start = path.getPointAtLength(0).matrixTransform(transform);
    const end = path.getPointAtLength(length).matrixTransform(transform);
    return {
      d: path.getAttribute('d'),
      length,
      insideObstacle,
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
    };
  }, obstacleId);
}

function expectOnBoundary(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
) {
  expect(point.x).toBeGreaterThanOrEqual(bounds.x - 2);
  expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width + 2);
  expect(point.y).toBeGreaterThanOrEqual(bounds.y - 2);
  expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height + 2);
  expect(
    Math.min(
      Math.abs(point.x - bounds.x),
      Math.abs(point.x - bounds.x - bounds.width),
      Math.abs(point.y - bounds.y),
      Math.abs(point.y - bounds.y - bounds.height),
    ),
  ).toBeLessThanOrEqual(2);
}

test('default connectors route around an unrelated obstacle and recompute during dragging while explicit Straight stays straight', async ({
  page,
}, testInfo) => {
  const canvasId = await createSpace(page, 'Live obstacle-aware connectors');
  const obstacleId = 'node-routing-obstacle';
  await execute(
    page,
    canvasId,
    [
      {
        type: 'CREATE_NODES',
        nodes: [
          ...(
            [
              ['node-routing-source', 80, 300],
              ['node-routing-target', 820, 300],
              ['node-straight-source', 80, 700],
              ['node-straight-target', 820, 720],
            ] as const
          ).map(([id, x, y]) => ({
            id,
            nodeType: 'image',
            position: { x, y },
            size: { width: 160, height: 100 },
            data: { label: id },
          })),
          {
            id: obstacleId,
            nodeType: 'image',
            position: { x: 420, y: 120 },
            size: { width: 160, height: 520 },
            data: { label: 'Drag this unrelated obstacle' },
          },
        ],
      },
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            id: 'edge-routing-auto',
            source: 'node-routing-source',
            target: 'node-routing-target',
          },
          {
            id: 'edge-routing-straight',
            source: 'node-straight-source',
            target: 'node-straight-target',
            style: { lineType: 'straight' },
          },
        ],
      },
    ],
    'ui',
  );
  await page.goto(`/canvas/${canvasId}`, { waitUntil: 'domcontentloaded' });
  await page.keyboard.press('Escape');
  const auto = page.locator(
    '.react-flow__edge[data-id="edge-routing-auto"] .react-flow__edge-path',
  );
  const straight = page.locator(
    '.react-flow__edge[data-id="edge-routing-straight"] .react-flow__edge-path',
  );
  const obstacle = page.locator(`.react-flow__node[data-id="${obstacleId}"]`);
  await expect(auto).toBeVisible({ timeout: 45_000 });
  await expect(straight).toBeVisible();
  await expect(obstacle).toBeVisible();
  await page.mouse.click(1120, 500);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect
    .poll(async () => (await pathGeometry(auto, obstacleId)).insideObstacle)
    .toBe(0);
  const initial = await pathGeometry(auto, obstacleId);
  const initialStraight = await pathGeometry(straight, obstacleId);
  expect(initialStraight.d?.match(/[A-Za-z]/g)).toEqual(['M', 'L']);
  expect(initial.length).toBeGreaterThan(initialStraight.length);
  await page.screenshot({
    path: testInfo.outputPath('routes-before-drag.png'),
  });

  const before = await visibleBounds(obstacle);
  const source = page.locator(
    '.react-flow__node[data-id="node-routing-source"]',
  );
  const target = page.locator(
    '.react-flow__node[data-id="node-routing-target"]',
  );
  const sourceAtStart = await visibleBounds(source);
  const targetAtStart = await visibleBounds(target);
  const start = {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x, start.y + 180, { steps: 12 });
    await expect
      .poll(async () => (await visibleBounds(obstacle)).y)
      .toBeGreaterThan(before.y + 100);
    expect(await visibleBounds(source)).toEqual(sourceAtStart);
    expect(await visibleBounds(target)).toEqual(targetAtStart);
    // Assert while the pointer is still held: a drag-stop-only update fails.
    await expect
      .poll(async () => (await pathGeometry(auto, obstacleId)).d)
      .not.toBe(initial.d);
    await expect
      .poll(async () => (await pathGeometry(auto, obstacleId)).insideObstacle)
      .toBe(0);
    expect(
      (await pathGeometry(straight, obstacleId)).d?.match(/[A-Za-z]/g),
    ).toEqual(['M', 'L']);
    expect(
      (await pathGeometry(straight, obstacleId)).insideObstacle,
    ).toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath('routes-during-drag.png'),
    });
  } finally {
    await page.mouse.up();
  }
  await expect
    .poll(
      async () =>
        (await readState(page, canvasId)).nodes.find(
          (node) => node.id === obstacleId,
        )?.position.y,
    )
    .toBeGreaterThan(220);

  const sourceBefore = await visibleBounds(source);
  const routeBefore = (await pathGeometry(auto, obstacleId)).d;
  const sourceCenter = {
    x: sourceBefore.x + sourceBefore.width / 2,
    y: sourceBefore.y + sourceBefore.height / 2,
  };
  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  try {
    await page.mouse.move(sourceCenter.x, sourceCenter.y - 90, { steps: 12 });
    await expect
      .poll(async () => (await visibleBounds(source)).y)
      .toBeLessThan(sourceBefore.y - 60);
    await expect
      .poll(async () => (await pathGeometry(auto, obstacleId)).d)
      .not.toBe(routeBefore);
    await expect(async () => {
      const geometry = await pathGeometry(auto, obstacleId);
      expect(geometry.insideObstacle).toBe(0);
      expectOnBoundary(geometry.start, await visibleBounds(source));
      expectOnBoundary(geometry.end, await visibleBounds(target));
    }).toPass();
    await page.screenshot({
      path: testInfo.outputPath('routes-during-endpoint-drag.png'),
    });
  } finally {
    await page.mouse.up();
  }
  await expect
    .poll(
      async () =>
        (await readState(page, canvasId)).nodes.find(
          (node) => node.id === 'node-routing-source',
        )?.position.y,
    )
    .toBeLessThan(260);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(auto).toBeVisible();
  await expect
    .poll(async () => (await pathGeometry(auto, obstacleId)).insideObstacle)
    .toBe(0);
  expect(
    (await pathGeometry(straight, obstacleId)).d?.match(/[A-Za-z]/g),
  ).toEqual(['M', 'L']);
  const persisted = (await readState(page, canvasId)).edges.find(
    (edge) => edge.id === 'edge-routing-straight',
  );
  expect((persisted?.data?.edgeStyle as { lineType?: string })?.lineType).toBe(
    'straight',
  );
});
