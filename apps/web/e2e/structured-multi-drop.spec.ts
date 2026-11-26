// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { openNewCanvas, personEdits, readViewportTransform } from './helpers';

import type {
  CanvasCommand,
  CanvasNodeId,
  GetCanvasResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

type Rect = { x: number; y: number; width: number; height: number };
const sourceIds = ['a', 's1', 'b', 's2'];
const targetIds = ['t1', 't2', 't3', 't4'];

function canvasId(page: Page) {
  return new URL(page.url()).pathname.split('/canvas/')[1];
}

async function savedNodes(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return (record.state as { nodes: Node[] }).nodes;
}

/** Saved top-to-bottom order of a Frame's children, one list per column. */
async function savedOrder(page: Page, frame: string) {
  const nodes = await savedNodes(page);
  return [
    nodes
      .filter((node) => node.parentId === `node-${frame}`)
      .sort((a, b) => a.position.y - b.position.y)
      .map((node) => node.id),
  ];
}

/** Top-to-bottom order of the notes actually rendered inside a Frame. */
async function renderedOrder(page: Page, frame: string) {
  const nodes = await savedNodes(page);
  const ids = nodes
    .filter((node) => node.parentId === `node-${frame}`)
    .map((node) => node.id);
  const tops = await Promise.all(
    ids.map(async (id) => ({
      id,
      y: (await child(page, id).boundingBox())?.y ?? NaN,
    })),
  );
  return tops.sort((a, b) => a.y - b.y).map(({ id }) => id);
}

function child(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function box(page: Page, name: string) {
  const result = await child(page, `node-${name}`).boundingBox();
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    );
  });
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const frame = (name: string, x: number, ids: string[]) => [
    {
      id: `node-${name}` as CanvasNodeId,
      nodeType: 'frame' as const,
      selectOnCreate: false,
      position: { x, y: 100 },
      size: { width: 240, height: 440 },
      data: { layoutMode: 'column', gridCount: 1, sizing: 'hug' },
    },
    ...ids.map((id, index) => ({
      id: `node-${id}` as CanvasNodeId,
      nodeType: 'note' as const,
      selectOnCreate: false,
      parentId: `node-${name}` as CanvasNodeId,
      position: { x: 0, y: index * 100 },
      // Only the dragged pair is wide; see the marquee in `dragPair`.
      size: { width: id === 'a' || id === 'b' ? 160 : 70, height: 80 },
      data: { label: id, content: id, frameColumn: 0 },
    })),
  ];
  const commands: CanvasCommand[] = [
    {
      type: 'CREATE_NODES',
      nodes: [
        ...frame('source', 100, sourceIds),
        ...frame('target', 500, targetIds),
      ],
    },
  ];
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: { edits: personEdits(commands) },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  await page.addInitScript((id) => {
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 80, y: 40, zoom: 1 }),
    );
  }, canvasId(page));
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);
  await expect.poll(() => readViewportTransform(page)).toContain('scale(1)');
  expect(await renderedOrder(page, 'source')).toEqual(
    sourceIds.map((id) => `node-${id}`),
  );
}

/** Select the non-adjacent `a` and `b`, then drag them by `a`. */
async function dragPair(
  page: Page,
  to: (a: { x: number; y: number }) => { x: number; y: number },
) {
  const a = await box(page, 'a');
  const b = await box(page, 'b');
  // The peers between them are narrow, so a marquee over the right-hand part
  // of the column takes `a` and `b` and leaves everything else unselected.
  await page.mouse.move(a.x + a.width + 8, a.y - 6);
  await page.mouse.down();
  await page.mouse.move(a.x + 100, b.y + b.height + 6, { steps: 8 });
  await page.mouse.up();
  await expect(child(page, 'node-a')).toHaveClass(/selected/);
  await expect(child(page, 'node-b')).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const grab = { x: a.x + 50, y: a.y + 8 };
  // `to` names where the top-left of `a` should be released.
  const drop = to({ x: a.x, y: a.y });
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x + 50, drop.y + 8, { steps: 12 });
  // Every dragged node gets its own footprint while the drag is live.
  const footprints = new Map<string, Rect>();
  for (const name of ['a', 'b']) {
    const marker = page.locator(`[data-structured-drop-node="node-${name}"]`);
    await expect(marker).toBeVisible();
    const rect = await marker.boundingBox();
    if (!rect) throw new Error(`Missing footprint for ${name}`);
    footprints.set(name, rect);
  }
  await page.mouse.up();
  return footprints;
}

/** The release lands each node exactly where its live footprint was drawn. */
async function expectLandedOnFootprints(
  page: Page,
  footprints: Map<string, Rect>,
) {
  await expect(async () => {
    for (const [name, footprint] of footprints) {
      const landed = await box(page, name);
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(
          Math.abs(landed[key] - footprint[key]),
          `${name}.${key}: ${JSON.stringify({ landed, footprint })}`,
        ).toBeLessThan(1.5);
      }
    }
  }).toPass();
}

test('nodes dragged together into a column Frame land as one block', async ({
  page,
}, info) => {
  await setup(page);
  const t1 = await box(page, 't1');
  const t2 = await box(page, 't2');
  // `a` lands between t1 and t2; `b` keeps its offset and lands below t3.
  const footprints = await dragPair(page, () => ({
    x: t1.x,
    y: (t1.y + t2.y) / 2,
  }));
  const expected = ['t1', 'a', 'b', 't2', 't3', 't4'].map((id) => `node-${id}`);
  await expect(async () =>
    expect(await savedOrder(page, 'target')).toEqual([expected]),
  ).toPass();
  await expect(async () =>
    expect(await renderedOrder(page, 'target')).toEqual(expected),
  ).toPass();
  await expectLandedOnFootprints(page, footprints);
  await info.attach('cross-frame', { body: await page.screenshot() });
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);
  expect(await renderedOrder(page, 'target')).toEqual(expected);
});

test('nodes dragged together within a column Frame land as one block', async ({
  page,
}, info) => {
  await setup(page);
  const s2 = await box(page, 's2');
  // `a` is released well below the top of s2, so both go past it.
  const footprints = await dragPair(page, (a) => ({ x: a.x, y: s2.y + 60 }));
  const expected = ['s1', 's2', 'a', 'b'].map((id) => `node-${id}`);
  await expect(async () =>
    expect(await savedOrder(page, 'source')).toEqual([expected]),
  ).toPass();
  await expect(async () =>
    expect(await renderedOrder(page, 'source')).toEqual(expected),
  ).toPass();
  await expectLandedOnFootprints(page, footprints);
  await info.attach('same-frame', { body: await page.screenshot() });
});

test('a small nudge of a non-adjacent selection changes nothing', async ({
  page,
}, info) => {
  await setup(page);
  const before = await Promise.all(sourceIds.map((id) => box(page, id)));
  const footprints = await dragPair(page, (a) => ({ x: a.x + 6, y: a.y + 10 }));
  const expected = sourceIds.map((id) => `node-${id}`);
  await page.waitForTimeout(800);
  expect(await savedOrder(page, 'source')).toEqual([expected]);
  expect(await renderedOrder(page, 'source')).toEqual(expected);
  await expect(async () => {
    const after = await Promise.all(sourceIds.map((id) => box(page, id)));
    after.forEach((rect, index) => {
      expect(Math.abs(rect.x - before[index].x)).toBeLessThan(1.5);
      expect(Math.abs(rect.y - before[index].y)).toBeLessThan(1.5);
    });
  }).toPass();
  await expectLandedOnFootprints(page, footprints);
  await info.attach('nudge', { body: await page.screenshot() });
});
