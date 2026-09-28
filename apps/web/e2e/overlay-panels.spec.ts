// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { openNewCanvas, readViewportTransform, oneFingerDrag } from './helpers';

async function settlePanels(page: Page) {
  await page.evaluate(async () => {
    const animations = Array.from(
      document.querySelectorAll('[data-canvas-panel]'),
    ).flatMap((element) => element.getAnimations());
    await Promise.all(
      animations.map((animation) => animation.finished.catch(() => {})),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document
      .querySelector('[data-canvas-root]')!
      .getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>(
      '.react-flow__viewport',
    )!;
    return {
      x: canvas.x,
      y: canvas.y,
      width: canvas.width,
      height: canvas.height,
      transform: viewport.style.transform,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'huabu-panel',
      JSON.stringify({ state: { isRightCollapsed: true }, version: 0 }),
    );
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    );
  });
});

test('overlays never resize or pan Canvas and isolate mouse, wheel, touch and keyboard', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const before = await geometry(page);
  await page.getByRole('button', { name: /open chat panel/i }).click();
  await settlePanels(page);
  expect(await geometry(page)).toEqual(before);
  await page.getByRole('button', { name: /show layers panel/i }).click();
  await settlePanels(page);
  expect(await geometry(page)).toEqual(before);
  const panel = page.locator('[data-canvas-panel="right"]');
  const bounds = (await panel.boundingBox())!;
  const point = {
    x: bounds.x + bounds.width - 30,
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.click(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 700);
  await page.keyboard.press('Space');
  await page.keyboard.press('Delete');
  await page.keyboard.press('p');
  const client = await page.context().newCDPSession(page);
  await oneFingerDrag(client, point, -50, -80);
  await client.detach();
  expect(await geometry(page)).toEqual(before);
  const handle = panel.getByRole('separator');
  const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + 2, handleBox.y + 350);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 100, handleBox.y + 350, { steps: 8 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(bounds.width + 90);
  expect(await geometry(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('overlays-desktop.png') });
  await page.getByTestId('collapse-preview').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-center-editor]')).toBeFocused();
  await page.getByRole('button', { name: /collapse layers panel/i }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-center-editor]')).toBeFocused();
  await settlePanels(page);
  expect(await geometry(page)).toEqual(before);
  await expect(panel).toBeHidden();
  await page.mouse.move(600, 400);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(650, 440, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect
    .poll(() => readViewportTransform(page))
    .not.toBe(before.transform);
});

test('node preview never moves Canvas even when the target is obstructed', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  const id = page.url().split('/canvas/')[1];
  const response = await page.request.post(`/api/canvas/${id}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              data: { label: 'Overlay target', content: 'Overlay target' },
              position: { x: 850, y: 180 },
              size: { width: 280, height: 'auto' },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'overlay-test' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.evaluate(
    (canvasId) =>
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      ),
    id,
  );
  await page.reload();
  const node = page.locator('.react-flow__node-note');
  await expect(node).toBeVisible();
  const initial = await geometry(page);
  await page.evaluate(() => {
    const samples: { moving: boolean; transform: string }[] = [];
    (window as unknown as { overlaySamples: typeof samples }).overlaySamples =
      samples;
    const started = performance.now();
    const sample = () => {
      const panel = document.querySelector('[data-canvas-panel="right"]')!;
      samples.push({
        moving: panel
          .getAnimations()
          .some((animation) => animation.playState === 'running'),
        transform: document.querySelector<HTMLElement>('.react-flow__viewport')!
          .style.transform,
      });
      if (performance.now() - started < 1200) requestAnimationFrame(sample);
      else
        (
          window as unknown as { overlaySamplingDone: boolean }
        ).overlaySamplingDone = true;
    };
    requestAnimationFrame(sample);
  });
  await node.dblclick();
  await settlePanels(page);
  await page.waitForFunction(
    () =>
      (window as unknown as { overlaySamplingDone?: boolean })
        .overlaySamplingDone,
  );
  const panel = page.locator('[data-canvas-panel="right"]');
  await expect(panel).toBeVisible();
  const nodeBounds = await node.boundingBox();
  const panelBounds = await panel.boundingBox();
  if (!nodeBounds || !panelBounds)
    throw new Error('Expected node and panel bounds');
  expect(nodeBounds.x + nodeBounds.width).toBeGreaterThan(panelBounds.x);
  expect(await geometry(page)).toEqual(initial);
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          overlaySamples: { moving: boolean; transform: string }[];
        }
      ).overlaySamples,
  );
  expect(samples.some((sample) => sample.moving)).toBe(true);
  expect(
    samples.every((sample) => sample.transform === initial.transform),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('obstructed-target.png') });
  await page.getByTestId('collapse-preview').click();
  await settlePanels(page);
  expect(await geometry(page)).toEqual(initial);
  await node.dblclick();
  await settlePanels(page);
  expect(await geometry(page)).toEqual(initial);
});

for (const navigation of ['layer', 'deep-link'] as const) {
  test(`first ${navigation} navigation reveals after Preview opens`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await openNewCanvas(page);
    const canvasId = page.url().split('/canvas/')[1];
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'note',
                  data: { label: 'Reveal target', content: 'Reveal target' },
                  position: { x: 900, y: 180 },
                  size: { width: 200, height: 'auto' },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'overlay-reveal-test' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    await page.evaluate((id) => {
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
    }, canvasId);
    await page.reload();
    const node = page.locator('.react-flow__node-note');
    await expect(node).toBeVisible();
    const nodeId = await node.getAttribute('data-id');
    if (!nodeId) throw new Error('Expected target node ID');
    const panel = page.locator('[data-canvas-panel="right"]');
    await expect(panel).toBeHidden();
    if (navigation === 'layer') {
      await page.getByRole('button', { name: /show layers panel/i }).click();
      await settlePanels(page);
      await page.locator(`[data-layer-id="${nodeId}"]`).click();
    } else {
      await page.goto(`/canvas/${canvasId}?node=${encodeURIComponent(nodeId)}`);
    }
    await expect(panel).toBeVisible();
    await settlePanels(page);
    await expect
      .poll(async () => {
        const target = await node.boundingBox();
        const overlay = await panel.boundingBox();
        if (!target || !overlay) return -1;
        return overlay.x - target.x - target.width;
      })
      .toBeGreaterThanOrEqual(23);
    await expect.poll(() => readViewportTransform(page)).toContain('scale(1)');
  });
}

test('toolbar stays visible without overlap and updates while a panel remains focused', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 850 });
  await openNewCanvas(page);
  await page.getByRole('button', { name: /show layers panel/i }).click();
  await page.getByRole('button', { name: /open chat panel/i }).click();
  await settlePanels(page);
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  const host = page.locator('[data-canvas-toolbar-layer]');
  await page.keyboard.press('Tab');
  for (const side of ['left', 'right']) {
    const panel = page.locator(`[data-canvas-panel="${side}"]`);
    await panel.focus();
    await expect(panel).toBeFocused();
    expect(
      await panel.evaluate((element) => element.matches(':focus-visible')),
    ).toBe(true);
    await expect(panel).toHaveCSS('outline-style', 'none');
    await expect(toolbar).toBeVisible();
    await expect(host).not.toHaveAttribute('inert');
  }
  await page.screenshot({
    path: testInfo.outputPath('toolbar-unobstructed.png'),
  });
  await page.setViewportSize({ width: 600, height: 850 });
  await expect(host).toHaveAttribute('inert', '');
  await expect(toolbar).toBeHidden();
  await page.setViewportSize({ width: 1800, height: 850 });
  await expect(host).not.toHaveAttribute('inert');
  await expect(toolbar).toBeVisible();
});

test('narrow layouts keep a full-size Canvas and bounded panels', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 850 });
  await openNewCanvas(page);
  const before = await geometry(page);
  await page.keyboard.press('p');
  await page.getByRole('button', { name: /show layers panel/i }).click();
  await page.getByRole('button', { name: /open chat panel/i }).click();
  await settlePanels(page);
  const left = (await page
    .locator('[data-canvas-panel="left"]')
    .boundingBox())!;
  const right = (await page
    .locator('[data-canvas-panel="right"]')
    .boundingBox())!;
  expect(right.x - left.x - left.width).toBeGreaterThanOrEqual(99);
  expect(await geometry(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('overlays-narrow.png') });
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  const host = page.locator('[data-canvas-toolbar-layer]');
  await expect(host).toHaveAttribute('inert', '');
  await expect(toolbar).toBeHidden();
  await page.mouse.click(left.width + 50, 400);
  await expect(toolbar).toBeVisible();
  await expect(host).not.toHaveAttribute('inert');
  await toolbar.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const toolbarBounds = (await toolbar.boundingBox())!;
  expect(toolbarBounds.x + toolbarBounds.width / 2).toBeCloseTo(
    (left.x + left.width + right.x) / 2,
    0,
  );
  expect(
    await toolbar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.right - 10, rect.top + rect.height / 2),
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('toolbar-above-panels.png'),
  });
  await page.locator('[data-canvas-panel="left"]').focus();
  await expect(toolbar).toBeHidden();
  await page.getByTestId('toggle-preview-fullscreen').click();
  await expect(page.locator('[data-canvas-root]')).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
  await page.getByTestId('toggle-preview-fullscreen').click();
  await expect(page.locator('[data-canvas-root]')).toBeVisible();
  await page.mouse.click(left.width + 50, 400);
  await expect(toolbar).toBeVisible();
});

for (const zoom of [0.5, 1]) {
  test(`panel motion preserves edge paths and node geometry at zoom ${zoom}`, async ({
    page,
  }, testInfo) => {
    await openNewCanvas(page);
    const id = page.url().split('/canvas/')[1];
    const execute = async (commands: unknown[]) => {
      const response = await page.request.post(`/api/canvas/${id}/execute`, {
        data: {
          commands,
          originator: { source: 'agent', threadId: 'overlay-edges' },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await execute([
      {
        type: 'CREATE_NODES',
        nodes: [300, 650].map((positionX) => ({
          nodeType: 'note',
          data: { label: `Node ${positionX}`, content: `Node ${positionX}` },
          position: { x: positionX, y: 220 },
          size: { width: 220, height: 'auto' },
        })),
      },
    ]);
    const response = await page.request.get(`/api/canvas/${id}`);
    const record = (await response.json()) as {
      state: { nodes: { id: string }[] };
    };
    await execute([
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            source: record.state.nodes[0].id,
            target: record.state.nodes[1].id,
          },
        ],
      },
    ]);
    await page.evaluate(
      ({ canvasId, scale }) =>
        localStorage.setItem(
          `huabu.viewport.${canvasId}`,
          JSON.stringify({ x: 0, y: 0, zoom: scale }),
        ),
      { canvasId: id, scale: zoom },
    );
    await page.reload();
    await expect(page.locator('.react-flow__edge-path')).toHaveCount(1);
    await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
    await expect
      .poll(async () =>
        (await readViewportTransform(page)).includes(`scale(${zoom})`),
      )
      .toBe(true);
    const sample = () => {
      const viewport = document.querySelector<HTMLElement>(
        '.react-flow__viewport',
      )!;
      return {
        transform: viewport.style.transform,
        path: document
          .querySelector('.react-flow__edge-path')!
          .getAttribute('d'),
        nodes: Array.from(
          document.querySelectorAll('.react-flow__node-note'),
        ).map((node) => {
          const rect = node.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        }),
      };
    };
    const before = await page.evaluate(sample);
    await page.evaluate(() => {
      const samples: { transform: string; path: string | null }[] = [];
      (window as unknown as { edgeSamples: typeof samples }).edgeSamples =
        samples;
      const started = performance.now();
      const take = () => {
        samples.push({
          transform: document.querySelector<HTMLElement>(
            '.react-flow__viewport',
          )!.style.transform,
          path: document
            .querySelector('.react-flow__edge-path')!
            .getAttribute('d'),
        });
        if (performance.now() - started < 2500) requestAnimationFrame(take);
      };
      requestAnimationFrame(take);
    });
    await page.getByRole('button', { name: /open chat panel/i }).click();
    await page.getByRole('button', { name: /show layers panel/i }).click();
    await settlePanels(page);
    expect(await page.evaluate(sample)).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('edges-open.png') });
    await page.getByTestId('collapse-preview').click();
    await page.getByRole('button', { name: /collapse layers panel/i }).click();
    await settlePanels(page);
    expect(await page.evaluate(sample)).toEqual(before);
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            edgeSamples: { transform: string; path: string | null }[];
          }
        ).edgeSamples,
    );
    expect(samples.length).toBeGreaterThan(3);
    expect(
      samples.every(
        (entry) =>
          entry.path === before.path && entry.transform === before.transform,
      ),
    ).toBe(true);
  });
}
