// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { openNewCanvas, readViewportTransform, oneFingerDrag } from './helpers';

import type * as ToolModule from '../src/store/toolStore';

async function createChatPreview(page: Page) {
  await page
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await expect(
    page.locator('[data-canvas-panel="right"]').getByRole('tab'),
  ).toBeVisible();
}

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

async function resizeFeedbackColors(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const readColor = (opacity: number) => {
      probe.style.backgroundColor = `color-mix(in oklab, var(--color-info) ${opacity}%, transparent)`;
      return getComputedStyle(probe).backgroundColor;
    };
    const colors = { hover: readColor(30), drag: readColor(50) };
    probe.remove();
    return colors;
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
  await createChatPreview(page);
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

for (const pointerType of ['touch', 'pen', 'mouse'] as const) {
  test(`preview resize targets are 8px with persistent ${pointerType} drag feedback`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    await page.evaluate(async (pointerType) => {
      const path = '/src/store/toolStore.ts';
      const { useToolStore } = (await import(path)) as typeof ToolModule;
      useToolStore
        .getState()
        .setInputModePreference(
          pointerType === 'touch' ? 'finger' : pointerType,
        );
    }, pointerType);
    await createChatPreview(page);
    await page
      .getByRole('button', {
        name: 'Split: create an empty group on the right',
        exact: true,
      })
      .click();
    await settlePanels(page);
    await page.mouse.move(10, 10);
    const before = await geometry(page);
    const panel = page.locator('[data-canvas-panel="right"]');
    const outer = panel.locator(':scope > [role="separator"]');
    const inner = panel.getByRole('separator', {
      name: 'Resize preview groups',
    });
    const { drag: blue } = await resizeFeedbackColors(page);
    const client = await page.context().newCDPSession(page);
    const pointer = async (
      phase: 'start' | 'move' | 'end',
      x: number,
      y: number,
    ) => {
      if (pointerType === 'touch') {
        await client.send('Input.dispatchTouchEvent', {
          type:
            phase === 'start'
              ? 'touchStart'
              : phase === 'move'
                ? 'touchMove'
                : 'touchEnd',
          touchPoints: phase === 'end' ? [] : [{ x, y }],
        });
      } else {
        await client.send('Input.dispatchMouseEvent', {
          type:
            phase === 'start'
              ? 'mousePressed'
              : phase === 'move'
                ? 'mouseMoved'
                : 'mouseReleased',
          pointerType,
          button: 'left',
          buttons: phase === 'end' ? 0 : 1,
          clickCount: 1,
          x,
          y,
        });
      }
    };

    for (const handle of [outer, inner]) {
      const rule = handle.locator(':scope > div');
      await expect(handle).toHaveCSS('width', '8px');
      await expect(rule).toHaveCSS('width', '1px');
      expect(
        await handle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [-5, -3, 3, 5].map((offset) => {
            const hit = document.elementFromPoint(
              box.x + box.width / 2 + offset,
              box.y + box.height / 2,
            );
            return hit !== null && element.contains(hit);
          });
        }),
      ).toEqual([false, true, true, false]);

      for (const offset of [-3, 3]) {
        const box = await handle.boundingBox();
        const panelBox = await panel.boundingBox();
        if (!box || !panelBox)
          throw new Error('Resize controls must be visible');
        if (handle === outer) expect(box.x).toBeCloseTo(panelBox.x - 4, 1);
        const previousRatio = await inner.getAttribute('aria-valuenow');
        if (previousRatio === null) throw new Error('Split ratio is missing');
        const x = box.x + box.width / 2 + offset;
        const y = box.y + box.height / 2;
        await pointer('start', x, y);
        await expect(handle).toHaveAttribute('data-resizing', 'true');
        await expect(rule).toHaveCSS('width', '4px');
        await expect(rule).toHaveCSS('background-color', blue);
        const dx = handle === outer ? -50 : 30;
        await pointer('move', x + dx, y);
        if (handle === outer) {
          await expect
            .poll(async () => (await panel.boundingBox())?.width)
            .toBeCloseTo(panelBox.width + 50, 1);
        } else {
          await expect(inner).not.toHaveAttribute(
            'aria-valuenow',
            previousRatio,
          );
        }
        await expect(rule).toHaveCSS('background-color', blue);
        // At the width/ratio limit, capture keeps feedback alive off the handle.
        await pointer('move', 10, y);
        await expect(handle).toHaveAttribute('data-resizing', 'true');
        await expect(rule).toHaveCSS('background-color', blue);
        await pointer('move', x + dx, y);
        await pointer('end', x + dx, y);
        await expect(handle).not.toHaveAttribute('data-resizing');
        await page.mouse.move(10, 10);
        await expect(rule).toHaveCSS('width', '1px');
        await expect(rule).not.toHaveCSS('background-color', blue);
        expect(await geometry(page)).toEqual(before);
      }
    }
    await client.detach();
  });
}

test.describe('desktop resize feedback', () => {
  test.use({ hasTouch: false });

  test('both rules use 4px translucent hover and active feedback', async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    await createChatPreview(page);
    await page
      .getByRole('button', {
        name: 'Split: create an empty group on the right',
        exact: true,
      })
      .click();
    await settlePanels(page);
    const panel = page.locator('[data-canvas-panel="right"]');
    const colors = await resizeFeedbackColors(page);
    for (const handle of [
      panel.locator(':scope > [role="separator"]'),
      panel.getByRole('separator', { name: 'Resize preview groups' }),
    ]) {
      const rule = handle.locator(':scope > div');
      await page.mouse.move(10, 10);
      await expect(rule).toHaveCSS('width', '1px');
      await handle.hover({ position: { x: 4, y: 300 } });
      await expect(handle).toHaveCSS('width', '8px');
      await expect(rule).toHaveCSS('width', '4px');
      await expect(rule).toHaveCSS('background-color', colors.hover);
      await page.mouse.down();
      await expect(handle).toHaveAttribute('data-resizing', 'true');
      await expect(rule).toHaveCSS('background-color', colors.drag);
      await page.mouse.move(10, 300);
      await expect(rule).toHaveCSS('width', '4px');
      await expect(rule).toHaveCSS('background-color', colors.drag);
      await page.mouse.up();
      await page.mouse.move(10, 10);
      await expect(handle).not.toHaveAttribute('data-resizing');
      await expect(rule).toHaveCSS('width', '1px');
    }
  });
});

test('panel descendants chain vertical wheel to their outer scroller', async ({
  page,
}) => {
  await openNewCanvas(page);
  await createChatPreview(page);
  await settlePanels(page);
  const before = await geometry(page);
  const panel = page.locator('[data-canvas-panel="right"]');
  const fixture = await panel.evaluateHandle((element) => {
    const outer = document.createElement('div');
    outer.dataset.testid = 'nested-scroll-outer';
    Object.assign(outer.style, {
      position: 'absolute',
      inset: '80px 24px auto 24px',
      zIndex: '100',
      height: '120px',
      overflowY: 'auto',
    });
    const target = document.createElement('div');
    target.dataset.testid = 'nested-scroll-target';
    Object.assign(target.style, {
      height: '40px',
      overflow: 'hidden',
    });
    target.textContent = 'Wheel target';
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    outer.append(target, spacer);
    element.append(outer);
    return outer;
  });

  const target = page.getByTestId('nested-scroll-target');
  await target.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() =>
      fixture.evaluate((element) => (element as HTMLElement).scrollTop),
    )
    .toBeGreaterThan(0);
  expect(await geometry(page)).toEqual(before);

  await fixture.dispose();
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
  await createChatPreview(page);
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

test('fullscreen rail aligns its layer control with Preview header controls', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await createChatPreview(page);
  await settlePanels(page);
  const fullscreen = page.getByTestId('toggle-preview-fullscreen');
  await fullscreen.click();
  const rail = page.locator('[data-fullscreen-header-rail]');
  const toggle = rail.getByRole('button', {
    name: 'Show layers panel',
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await expect(page.locator('[data-canvas-root]')).toHaveCount(0);
  const left = await toggle.boundingBox();
  const right = await fullscreen.boundingBox();
  if (!left || !right)
    throw new Error('Fullscreen header controls are missing');
  expect(left.height).toBe(28);
  expect(left.height).toBe(right.height);
  expect(left.y).toBeCloseTo(right.y, 1);
  const railBounds = await rail.boundingBox();
  if (!railBounds) throw new Error('Fullscreen rail is missing');
  expect(left.y + left.height / 2 - railBounds.y).toBe(22);
  await toggle.click();
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(toggle).toBeVisible();
  await fullscreen.click();
  await expect(rail).toHaveCount(0);
  await expect(page.locator('[data-canvas-root]')).toBeVisible();
});

test('narrow layouts keep a full-size Canvas and bounded panels', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 850 });
  await openNewCanvas(page);
  const before = await geometry(page);
  await page.keyboard.press('p');
  await page.getByRole('button', { name: /show layers panel/i }).click();
  await createChatPreview(page);
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
    await createChatPreview(page);
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
