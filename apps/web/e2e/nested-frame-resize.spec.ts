// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { openNewCanvas, readViewportTransform } from './helpers';

import type {
  CanvasCommand,
  CanvasNodeCreateInput,
  CanvasNodeId,
  FrameLayoutMode,
  GetCanvasResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

const names = ['outer', 'middle', 'inner', 'leaf'] as const;
type Name = (typeof names)[number];
type Ids = Record<Name, CanvasNodeId>;
type Rect = { x: number; y: number; width: number; height: number };
type Scene = Record<Name, Rect>;
const tolerance = 1.5;

function canvasId(page: Page) {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  if (!id) throw new Error('Expected a real isolated Canvas URL');
  return id;
}

async function persisted(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return (record.state as { nodes: Node[] }).nodes;
}

async function execute(page: Page, commands: CanvasCommand[]) {
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands,
        originator: { source: 'agent', threadId: 'e2e-nested-frame-resize' },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function seed(page: Page, modes: readonly FrameLayoutMode[]) {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const fixtures: CanvasNodeCreateInput[] = names.map((name, index) => ({
    nodeType: name === 'leaf' ? 'note' : 'frame',
    data:
      name === 'leaf'
        ? {
            label: name,
            content: 'Fixed-height nested Note.',
            heightMode: 'fixed',
          }
        : {
            label: name,
            layoutMode: modes[index],
            sizing: 'hug',
            gridCount: 1,
          },
    position: { x: 300 + index * 20, y: 240 + index * 64 },
    size:
      name === 'leaf'
        ? { width: 240, height: 160 }
        : { width: 360 - index * 40, height: 412 - index * 84 },
  }));
  await execute(page, [{ type: 'CREATE_NODES', nodes: fixtures }]);
  const created = await persisted(page);
  const ids = Object.fromEntries(
    names.map((name) => {
      const found = created.find((entry) => entry.data.label === name);
      if (!found) throw new Error(`Missing fixture ${name}`);
      return [name, found.id];
    }),
  ) as Ids;

  // Build from the leaf outward through real commands, letting each Hug
  // parent fit its completed child branch before it joins the next parent.
  for (let index = names.length - 1; index > 0; index--) {
    await execute(page, [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: [ids[names[index]]],
        parentId: ids[names[index - 1]],
      },
    ]);
  }
  const saved = await persisted(page);
  assertTopology(saved, ids, modes);
  const outer = saved.find((entry) => entry.id === ids.outer);
  if (!outer) throw new Error('Missing outer Frame');
  await page.addInitScript(
    ({ id, position }) => {
      if (window !== window.top) return;
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({ x: 240 - position.x, y: 240 - position.y, zoom: 1 }),
      );
    },
    { id: canvasId(page), position: outer.position },
  );
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(node(page, ids.leaf)).toContainText('Fixed-height nested Note.');
  await expect.poll(() => readViewportTransform(page)).toContain('scale(1)');
  await expect(async () => {
    const scene = await rendered(page, ids);
    assertContained(scene);
    expect(scene.outer.x).toBeGreaterThan(200);
    expect(scene.outer.y).toBeGreaterThan(200);
    assertRenderedMatchesSaved(scene, await persisted(page), ids);
  }).toPass({ timeout: 5000 });
  return ids;
}

function assertTopology(
  nodes: Node[],
  ids: Ids,
  modes: readonly FrameLayoutMode[],
) {
  expect(nodes).toHaveLength(4);
  names.forEach((name, index) => {
    const entry = nodes.find((candidate) => candidate.id === ids[name]);
    expect(entry, name).toBeDefined();
    expect(entry?.parentId ?? null, `${name} parent`).toBe(
      index ? ids[names[index - 1]] : null,
    );
    expect(entry?.type).toBe(name === 'leaf' ? 'note' : 'frame');
    if (name === 'leaf') {
      expect(entry?.data.heightMode).toBe('fixed');
      expect(entry?.data.content).toBe('Fixed-height nested Note.');
    } else {
      expect(entry?.data.sizing).toBe('hug');
      expect(entry?.data.layoutMode).toBe(modes[index]);
    }
  });
}

async function rendered(page: Page, ids: Ids): Promise<Scene> {
  // One browser read captures a coherent tree, including while the mouse is held.
  return page.locator('.react-flow__node').evaluateAll((elements, ids) => {
    return Object.fromEntries(
      Object.entries(ids).map(([name, id]) => {
        const element = elements.find(
          (entry) => entry.getAttribute('data-id') === id,
        );
        if (!element) throw new Error(`Missing rendered ${name}`);
        const { x, y, width, height } = element.getBoundingClientRect();
        return [name, { x, y, width, height }];
      }),
    ) as Scene;
  }, ids);
}

function assertContained(scene: Scene) {
  for (const [index, name] of names.entries()) {
    const child = scene[name];
    for (const value of Object.values(child))
      expect(Number.isFinite(value)).toBe(true);
    expect(child.width, `${name} width`).toBeGreaterThan(100);
    expect(child.height, `${name} height`).toBeGreaterThan(100);
    if (!index) continue;
    const parent = scene[names[index - 1]];
    const gaps = [
      child.x - parent.x,
      child.y - parent.y,
      parent.x + parent.width - child.x - child.width,
      parent.y + parent.height - child.y - child.height,
    ];
    for (const gap of gaps) {
      expect(
        gap,
        `${name} stays inside its direct parent`,
      ).toBeGreaterThanOrEqual(-tolerance);
      expect(gap, `${name} has bounded parent whitespace`).toBeLessThan(128);
    }
  }
}

function assertSameScene(actual: Scene, expected: Scene) {
  for (const name of names) {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs(actual[name][key] - expected[name][key]),
        `${name}.${key}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  }
}

function assertRenderedMatchesSaved(scene: Scene, nodes: Node[], ids: Ids) {
  // Compare local offsets as well as sizes: an incorrect final local position
  // can look plausible until the next load reconstructs absolute positions.
  names.forEach((name, index) => {
    const entry = nodes.find((candidate) => candidate.id === ids[name]);
    if (!entry) throw new Error(`Missing saved ${name}`);
    expect(
      Math.abs(Number(entry.style?.width) - scene[name].width),
      `${name} saved width`,
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(Number(entry.style?.height) - scene[name].height),
      `${name} saved height`,
    ).toBeLessThanOrEqual(tolerance);
    if (!index) return;
    const parent = scene[names[index - 1]];
    expect(
      Math.abs(entry.position.x - (scene[name].x - parent.x)),
      `${name} saved local x`,
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(entry.position.y - (scene[name].y - parent.y)),
      `${name} saved local y`,
    ).toBeLessThanOrEqual(tolerance);
  });
}

test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeEach(async ({ page, baseURL }) => {
  expect(new URL(baseURL ?? '').port).not.toBe('5173');
  // Disable Vite HMR during native gestures; real canvas SSE remains enabled.
  await page.routeWebSocket('**/*', (socket) => socket.close());
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.url().includes('/canvas/')) return;
  await testInfo.attach('persisted-canvas', {
    body: JSON.stringify(await persisted(page), null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('canvas', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

for (const modes of [
  ['free', 'free', 'free'],
  ['free', 'column', 'grid'],
] as const) {
  for (const layer of ['outer', 'middle', 'inner'] as const) {
    for (const corner of ['bottom.right', 'top.left'] as const) {
      test(`${modes.join('/')} ${layer} ${corner}: nested resize, Hug fit, undo and reload`, async ({
        page,
      }, testInfo) => {
        test.setTimeout(60_000);
        const ids = await seed(page, modes);
        const selected = node(page, ids[layer]);
        // The exposed header selects this Frame, not its nested child or label editor.
        await selected.click({ position: { x: 8, y: 32 } });
        await expect(selected).toHaveClass(/selected/);
        const handle = selected.locator(
          `.react-flow__resize-control.node-resize-corner.${corner}`,
        );
        await expect(handle).toBeVisible();
        expect(
          await handle.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ) === element
            );
          }),
          'The native handle must own the hit target',
        ).toBe(true);
        const start = await handle.boundingBox();
        if (!start) throw new Error('Missing native resize handle');
        const before = await rendered(page, ids);
        const viewport = await readViewportTransform(page);
        const direction = corner === 'bottom.right' ? 1 : -1;
        const point = {
          x: start.x + start.width / 2,
          y: start.y + start.height / 2,
        };
        const structuredAncestor = modes
          .slice(0, names.indexOf(layer))
          .some((mode) => mode !== 'free');
        const samples: Scene[] = [];
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try {
          // A reversal within one gesture detects cumulative scaling/anchor drift.
          for (const fraction of [1, 0.5, 1]) {
            await page.mouse.move(
              point.x + direction * 96 * fraction,
              point.y + direction * 72 * fraction,
              { steps: 8 },
            );
            await expect
              .soft(async () => {
                const live = await rendered(page, ids);
                expect(
                  Math.abs(
                    live[layer].width - before[layer].width - 96 * fraction,
                  ),
                  `${layer} tracks pointer width`,
                ).toBeLessThanOrEqual(tolerance);
                expect(
                  Math.abs(
                    live[layer].height - before[layer].height - 72 * fraction,
                  ),
                  `${layer} tracks pointer height`,
                ).toBeLessThanOrEqual(tolerance);
                // Structured ancestors own child placement; free ancestors must
                // preserve the opposite canvas-space corner even when Hug moves them.
                const opposite = (rect: Rect) =>
                  corner === 'top.left' && !structuredAncestor
                    ? { x: rect.x + rect.width, y: rect.y + rect.height }
                    : { x: rect.x, y: rect.y };
                expect(
                  Math.abs(opposite(live[layer]).x - opposite(before[layer]).x),
                  `${layer} canvas-space anchor x`,
                ).toBeLessThanOrEqual(tolerance);
                expect(
                  Math.abs(opposite(live[layer]).y - opposite(before[layer]).y),
                  `${layer} canvas-space anchor y`,
                ).toBeLessThanOrEqual(tolerance);
                assertContained(live);
                for (const name of names) {
                  // Every ancestor must hug the expanded branch; every descendant,
                  // including the fixed-height Note, must scale rather than overflow.
                  expect(
                    live[name].width,
                    `${name} expands horizontally`,
                  ).toBeGreaterThan(before[name].width + 1);
                  expect(
                    live[name].height,
                    `${name} expands vertically`,
                  ).toBeGreaterThan(before[name].height + 1);
                  expect(live[name].width).toBeLessThan(before[name].width * 3);
                  expect(live[name].height).toBeLessThan(
                    before[name].height * 3,
                  );
                }
              })
              .toPass({ timeout: 5000 });
            samples.push(await rendered(page, ids));
          }
          assertSameScene(samples[2], samples[0]);
        } finally {
          await page.mouse.up();
          await testInfo.attach('gesture-geometry', {
            body: JSON.stringify(
              {
                layer,
                corner,
                modes,
                before,
                samples,
                released: await rendered(page, ids),
              },
              null,
              2,
            ),
            contentType: 'application/json',
          });
        }
        await expect(page.locator('body')).not.toHaveClass(
          /node-resize-active/,
        );
        const released = samples[2];
        assertSameScene(await rendered(page, ids), released);
        expect(await readViewportTransform(page)).toBe(viewport);

        const settled = async (stage: string, expected: Scene) => {
          // Keep failures visible while still exercising redo and hydration.
          await expect
            .soft(async () => {
              const live = await rendered(page, ids);
              assertSameScene(live, expected);
              assertContained(live);
              const saved = await persisted(page);
              assertTopology(saved, ids, modes);
              assertRenderedMatchesSaved(live, saved, ids);
            })
            .toPass({ timeout: 10_000 });
          await testInfo.attach(stage, {
            body: JSON.stringify(
              {
                expected,
                rendered: await rendered(page, ids),
                saved: await persisted(page),
              },
              null,
              2,
            ),
            contentType: 'application/json',
          });
        };
        await settled('release-persisted', released);
        await testInfo.attach('resized', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        // One undo must restore the complete branch, not merely the selected box.
        await page.keyboard.press('ControlOrMeta+z');
        await settled('undo', before);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await settled('redo', released);
        await page.reload();
        await expect(page.locator('.react-flow__node')).toHaveCount(4);
        await settled('reload', released);
      });
    }
  }
}
