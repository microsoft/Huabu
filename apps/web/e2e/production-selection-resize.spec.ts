// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  oneFingerDrag,
  openNewCanvas,
  readViewportTransform,
  touchTap,
} from './helpers';

import type { GetCanvasResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

// Real Canvas, real execute/storage endpoints, and native mouse/CDP gestures.
// No store injection, playground renderer, production mocks, or live 5173 data.
interface FixtureNode {
  nodeType: 'note' | 'text' | 'question' | 'image' | 'video';
  data: {
    label: string;
    content?: string;
    src?: string;
    style?: { fontSize: number };
  };
  position: { x: number; y: number };
  size: { width: number; height: number };
}

function canvasId(page: Page) {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  if (!id) throw new Error('Expected a real Canvas URL');
  return id;
}

async function persisted(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return record.state as {
    nodes: Node[];
    edges: { source: string; target: string }[];
  };
}

function fixture(
  nodeType: FixtureNode['nodeType'],
  label: string = nodeType,
): FixtureNode {
  return {
    nodeType,
    data: {
      label,
      ...(nodeType === 'text'
        ? {
            content:
              'Resize this text without losing its typography.\nSecond line stays readable.',
            style: { fontSize: 24 },
          }
        : {}),
      ...(nodeType === 'note'
        ? { content: `# ${label}\n\nA real Canvas Note document.` }
        : {}),
      ...(nodeType === 'question'
        ? { content: label, style: { fontSize: 28 } }
        : {}),
      ...(nodeType === 'image'
        ? {
            src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="360" height="240"%3E%3Crect width="360" height="240" fill="teal"/%3E%3C/svg%3E',
          }
        : {}),
    },
    position: { x: 180, y: 200 },
    size: { width: 360, height: 240 },
  };
}

async function seed(page: Page, nodes: FixtureNode[]) {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands: [{ type: 'CREATE_NODES', nodes }],
        originator: {
          source: 'agent',
          threadId: 'e2e-production-selection-resize',
        },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node')).toHaveCount(nodes.length);
  const state = await persisted(page);
  return nodes.map(({ data }) => {
    const node = state.nodes.find(
      (candidate) => candidate.data.label === data.label,
    );
    if (!node) throw new Error(`Missing persisted fixture ${data.label}`);
    return page.locator(`.react-flow__node[data-id="${node.id}"]`);
  });
}

async function box(node: Locator) {
  const rect = await node.boundingBox();
  if (!rect) throw new Error('Expected a visible production node/control');
  return rect;
}

async function center(node: Locator) {
  const rect = await box(node);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function restoreTestViewport(page: Page, item: FixtureNode, zoom = 1) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(
    ({ id, position, zoom }) => {
      if (window !== window.top) return;
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({
          x: 200 - position.x * zoom,
          y: 180 - position.y * zoom,
          zoom,
        }),
      );
    },
    { id: canvasId(page), position: item.position, zoom },
  );
  await page.reload();
}

function widthEdge(node: Locator, side: string) {
  return node.locator(
    `.react-flow__resize-control.line.node-resize-edge.${side}`,
  );
}

async function expectTransparentWidthEdges(node: Locator) {
  await expect(
    node.locator('.node-text-width-handle, .node-text-width-grip'),
  ).toHaveCount(0);
  await expect(node.locator('.node-resize-edge')).toHaveCount(2);
  await expect(node.locator('.node-resize-corner')).toHaveCount(4);
  await expect(
    node.locator('.node-resize-edge.top, .node-resize-edge.bottom'),
  ).toHaveCount(0);
  const bounds = await box(node);
  for (const side of ['left', 'right']) {
    const edge = widthEdge(node, side);
    await expect(edge).toHaveCSS('cursor', 'ew-resize');
    await expect(edge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(edge).toHaveCSS('background-image', 'none');
    await expect(edge).toHaveCSS('box-shadow', 'none');
    await expect(edge).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
    await expect(edge).toHaveCSS(`border-${side}-width`, '1px');
    await expect(edge.locator('*')).toHaveCount(0);
    const hit = await box(edge);
    expect(hit.y).toBeCloseTo(bounds.y, 1);
    expect(hit.height).toBeCloseTo(bounds.height, 1);
    expect(hit.x + hit.width / 2).toBeCloseTo(
      side === 'left' ? bounds.x : bounds.x + bounds.width,
      1,
    );
    // Sample the full native line, not a replacement midpoint handle.
    for (const fraction of [0.25, 0.5, 0.75]) {
      expect(
        await edge.evaluate((el, fraction) => {
          const rect = el.getBoundingClientRect();
          return (
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height * fraction,
            ) === el
          );
        }, fraction),
      ).toBe(true);
    }
    expect(
      await port(node, side)
        .getByRole('button')
        .evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return (
            document
              .elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              )
              ?.closest('[role="button"]') === el
          );
        }),
    ).toBe(true);
  }
}

async function select(page: Page, node: Locator) {
  const point = await center(node);
  await page.mouse.click(point.x, point.y);
  await expect(node).toHaveClass(/selected/);
  await expect(node.locator('.node-resize-corner')).toHaveCount(4);
}

function corner(node: Locator) {
  return node.locator('.node-resize-corner.bottom.right');
}

function port(node: Locator, side = 'right') {
  return node.locator(
    `.react-flow__handle.source[data-handleid="${side}-source"]`,
  );
}

async function geometry(node: Locator) {
  return node.evaluate((element) => {
    const text = element.querySelector('textarea');
    return {
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
      font: text ? Number.parseFloat(getComputedStyle(text).fontSize) : null,
    };
  });
}

async function drag(
  page: Page,
  control: Locator,
  dx: number,
  dy: number,
  during?: () => Promise<void>,
) {
  const point = await center(control);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x + dx, point.y + dy, { steps: 12 });
    await during?.();
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator('body')).not.toHaveClass(/node-resize-active/);
}

async function savedWidth(page: Page, node: Locator, width: number) {
  const id = await node.getAttribute('data-id');
  await expect
    .poll(async () => {
      const current = (await persisted(page)).nodes.find(
        (entry) => entry.id === id,
      );
      return Math.abs(Number(current?.style?.width) - width);
    })
    .toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ baseURL, page }) => {
  expect(
    new URL(baseURL ?? '').port,
    'Use only the dedicated isolated Playwright stack',
  ).toBe(process.env.E2E_WEB_PORT ?? '5273');
  // Prevent concurrent source edits from replacing an active native gesture.
  // Canvas realtime updates use SSE and remain connected.
  await page.routeWebSocket('**/*', (socket) => socket.close());
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.url().includes('/canvas/')) return;
  await testInfo.attach('persisted-canvas', {
    body: JSON.stringify(await persisted(page), null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('rendered-controls', {
    body: JSON.stringify(
      await page.locator('.react-flow__node').evaluateAll((nodes) =>
        nodes.map((node) => ({
          id: node.getAttribute('data-id'),
          className: node.className,
          style: node.getAttribute('style'),
          font: node.querySelector('textarea')?.style.fontSize,
          controls: Array.from(
            node.querySelectorAll('.react-flow__resize-control'),
            (control) => control.className,
          ),
        })),
      ),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  if (testInfo.status !== testInfo.expectedStatus)
    await testInfo.attach('canvas-failure', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
});

for (const side of ['left', 'right']) {
  test(`Text ${side} edge changes width without changing font; undo/redo restores width`, async ({
    page,
  }) => {
    const item = fixture('text');
    const [node] = await seed(page, [item]);
    await restoreTestViewport(page, item);
    await expect(node.locator('textarea')).toHaveCSS('font-size', '24px');
    await select(page, node);
    await expectTransparentWidthEdges(node);
    const widthHandle = widthEdge(node, side);
    const before = await geometry(node);
    await drag(page, widthHandle, side === 'right' ? 100 : -100, 35);
    await expect
      .poll(async () => (await geometry(node)).width)
      .toBeGreaterThan(before.width + 50);
    await expect(node.locator('textarea')).toHaveCSS('font-size', '24px');
    const after = await geometry(node);
    await savedWidth(page, node, after.width);
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await geometry(node)).width)
      .toBe(before.width);
    await expect(node.locator('textarea')).toHaveCSS('font-size', '24px');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect
      .poll(async () => (await geometry(node)).width)
      .toBe(after.width);
    await expect(node.locator('textarea')).toHaveCSS('font-size', '24px');
  });
}

test('Text has two width edges and four scale corners and retains toolbar font sizing after reload', async ({
  page,
}) => {
  const item = fixture('text');
  const [node] = await seed(page, [item]);
  await restoreTestViewport(page, item);
  await expect(node.locator('textarea')).toHaveCSS('font-size', '24px');
  await select(page, node);
  await expect(node.locator('.react-flow__resize-control')).toHaveCount(6);
  await expectTransparentWidthEdges(node);
  const fontSize = page.getByRole('spinbutton', { name: 'Font size' });
  await fontSize.fill('32');
  await fontSize.press('Enter');
  await expect(node.locator('textarea')).toHaveCSS('font-size', '32px');
  await expect
    .poll(async () => {
      const current = (await persisted(page)).nodes.find(
        (entry) => entry.type === 'text',
      );
      return (current?.data.style as { fontSize?: number } | undefined)
        ?.fontSize;
    })
    .toBe(32);
  await page.reload();
  await expect(node.locator('textarea')).toHaveCSS('font-size', '32px');
  await select(page, node);
  await expect(node.locator('.react-flow__resize-control')).toHaveCount(6);
});

async function contentMetrics(node: Locator) {
  return node.evaluate((element) => {
    const title = element.querySelector<HTMLElement>(
      'textarea, .question-conversation-question',
    );
    const body =
      element.querySelector<HTMLElement>('.question-conversation-card') ??
      title?.parentElement;
    if (!title || !body) throw new Error('Missing proportional content');
    const css = getComputedStyle(title);
    const bodyCss = getComputedStyle(body);
    const metric = (
      selector: string,
      property: 'fontSize' | 'height' | 'width' | 'marginBottom',
    ) => {
      const target = element.querySelector(selector);
      return target
        ? Number.parseFloat(getComputedStyle(target)[property])
        : null;
    };
    return {
      width: Number.parseFloat(getComputedStyle(element).width),
      height: Number.parseFloat(getComputedStyle(element).height),
      font: Number.parseFloat(css.fontSize),
      insetX:
        Number.parseFloat(bodyCss.paddingLeft) +
        (body.matches('.question-conversation-card') ? 0 : 3),
      insetY: Number.parseFloat(bodyCss.paddingTop),
      lineHeight: Number.parseFloat(css.lineHeight),
      lines: Math.round(title.clientHeight / Number.parseFloat(css.lineHeight)),
      overflow: title.scrollHeight - title.clientHeight,
      header: metric('.question-conversation-header', 'height'),
      headerGap: metric('.question-conversation-header', 'marginBottom'),
      avatar: metric('.question-conversation-agent > :first-child', 'width'),
      agentFont: metric('.question-conversation-agent', 'fontSize'),
      statusFont: metric('.question-conversation-status', 'fontSize'),
      statusIcon: metric('.question-conversation-status svg', 'width'),
    };
  });
}

for (const type of ['text', 'question'] as const) {
  for (const zoom of [0.5, 1, 2]) {
    for (const pointer of ['mouse', 'touch'] as const) {
      test(`${type} transparent native width edges hit and resize at ${zoom} zoom with ${pointer}; no painted side bars`, async ({
        page,
      }) => {
        const item = fixture(type, 'Resize this content');
        item.position = { x: 60, y: 60 };
        const [node] = await seed(page, [item]);
        await restoreTestViewport(page, item, zoom);
        await select(page, node);
        const client = await page.context().newCDPSession(page);
        try {
          if (pointer === 'touch') await touchTap(client, await center(node));
          expect((await box(node)).width).toBeCloseTo(
            item.size.width * zoom,
            1,
          );
          const viewport = await readViewportTransform(page);
          for (const side of ['left', 'right']) {
            await expectTransparentWidthEdges(node);
            const edge = widthEdge(node, side);
            const rect = await box(edge);
            // Resize away from the midpoint to exercise the full native edge.
            const point = {
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height * (side === 'left' ? 0.25 : 0.75),
            };
            const before = await contentMetrics(node);
            const bounds = await box(node);
            const dx = side === 'left' ? -40 : 40;
            if (pointer === 'touch') {
              await oneFingerDrag(client, point, dx, 20);
            } else {
              await page.mouse.move(point.x, point.y);
              await page.mouse.down();
              try {
                await page.mouse.move(point.x + dx, point.y + 20, {
                  steps: 12,
                });
              } finally {
                await page.mouse.up();
              }
            }
            await expect(page.locator('body')).not.toHaveClass(
              /node-resize-active/,
            );
            await expect
              .poll(async () => (await contentMetrics(node)).width)
              .toBeGreaterThan(before.width + 20 / zoom);
            const after = await contentMetrics(node);
            expect(after.font).toBe(before.font);
            expect(after.insetX).toBe(before.insetX);
            expect(after.insetY).toBe(before.insetY);
            expect(after.overflow).toBeLessThanOrEqual(1);
            const resized = await box(node);
            expect(resized.y).toBeCloseTo(bounds.y, 1);
            expect(
              side === 'left' ? resized.x + resized.width : resized.x,
            ).toBeCloseTo(
              side === 'left' ? bounds.x + bounds.width : bounds.x,
              1,
            );
            expect(await readViewportTransform(page)).toBe(viewport);
            await savedWidth(page, node, after.width);
          }
          await expectTransparentWidthEdges(node);
        } finally {
          await client.detach();
        }
      });
    }
  }

  test(`${type} reflows its node and selection outline while a width resize remains active`, async ({
    page,
  }) => {
    const item = fixture(
      type,
      'Compare these approaches and explain their important differences clearly',
    );
    const [node] = await seed(page, [item]);
    await restoreTestViewport(page, item);
    await select(page, node);
    const id = await node.getAttribute('data-id');
    if (!id) throw new Error('Missing node id');
    const outline = page.locator(`[data-node-selection-outline="${id}"]`);
    const before = await box(node);
    const handle = widthEdge(node, 'right');
    const point = await center(handle);

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    try {
      await page.mouse.move(point.x - 180, point.y, { steps: 12 });
      await expect(async () => {
        const liveNode = await box(node);
        const liveOutline = await box(outline);
        expect(liveNode.height).toBeGreaterThan(before.height + 10);
        expect(liveOutline.x).toBeCloseTo(liveNode.x, 1);
        expect(liveOutline.y).toBeCloseTo(liveNode.y, 1);
        expect(liveOutline.width).toBeCloseTo(liveNode.width, 1);
        expect(liveOutline.height).toBeCloseTo(liveNode.height, 1);
        const shellRadius = await node
          .locator('[data-node-surface]')
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
          );
        const outlineRadius = await outline.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
        );
        expect(outlineRadius).toBeCloseTo(shellRadius, 1);
        const tangent = outlineRadius - (outlineRadius + 1.5) / Math.sqrt(2);
        for (const position of [
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
        ]) {
          const grip = await box(
            page.locator(`[data-node-resize-grip="${id}:${position}"]`),
          );
          const gripSize = grip.width;
          const inwardX = position.endsWith('right')
            ? grip.x
            : grip.x + gripSize;
          const inwardY = position.startsWith('bottom')
            ? grip.y
            : grip.y + gripSize;
          expect(inwardX).toBeCloseTo(
            liveNode.x +
              (position.endsWith('right') ? liveNode.width - tangent : tangent),
            1,
          );
          expect(inwardY).toBeCloseTo(
            liveNode.y +
              (position.startsWith('bottom')
                ? liveNode.height - tangent
                : tangent),
            1,
          );
        }
      }).toPass({ timeout: 5000 });
    } finally {
      await page.mouse.up();
    }
    const settledNode = await box(node);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const dot = page.locator(`[data-connection-port-dot="${id}:${side}"]`);
      await expect(dot).toBeVisible();
      const centerPoint = await center(dot);
      const expected = {
        x:
          side === 'left'
            ? settledNode.x
            : side === 'right'
              ? settledNode.x + settledNode.width
              : settledNode.x + settledNode.width / 2,
        y:
          side === 'top'
            ? settledNode.y
            : side === 'bottom'
              ? settledNode.y + settledNode.height
              : settledNode.y + settledNode.height / 2,
      };
      const outward = Math.hypot(
        centerPoint.x - expected.x,
        centerPoint.y - expected.y,
      );
      expect(outward).toBeGreaterThan(0);
      if (side === 'top' || side === 'bottom')
        expect(centerPoint.x).toBeCloseTo(expected.x, 1);
      else expect(centerPoint.y).toBeCloseTo(expected.y, 1);
    }
  });

  test(`${type} native corner scales content proportionally; edge reflows; persistence and undo/redo restore both`, async ({
    page,
  }, testInfo) => {
    const item = fixture(
      type,
      'Compare these approaches and their differences',
    );
    const [node] = await seed(page, [item]);
    // Start from hydrated server state, after initial Question preprocessing.
    await restoreTestViewport(page, item);
    await select(page, node);
    const before = await contentMetrics(node);
    expect(before.font).toBe(type === 'text' ? 24 : 28);
    const verifyScale = async () => {
      const live = await contentMetrics(node);
      const ratio = live.width / before.width;
      expect(ratio).toBeGreaterThan(1.2);
      for (const key of [
        'font',
        'insetX',
        'insetY',
        'lineHeight',
        'header',
        'headerGap',
        'avatar',
        'agentFont',
        'statusFont',
        'statusIcon',
      ] as const) {
        const original = before[key];
        if (original !== null)
          expect(
            Math.abs((live[key] ?? 0) - original * ratio),
            key,
          ).toBeLessThan(0.15);
      }
      expect(live.lines).toBe(before.lines);
      expect(
        live.overflow,
        JSON.stringify({ before, live }),
      ).toBeLessThanOrEqual(1);
      expect(live.height).toBeGreaterThan(before.height);
      return live;
    };
    await drag(page, corner(node), 110, 90, async () => {
      await expect
        .poll(async () => (await contentMetrics(node)).width)
        .toBeGreaterThan(before.width + 70);
      const id = await node.getAttribute('data-id');
      if (!id) throw new Error('Missing node id');
      await expect(async () => {
        const liveNode = await box(node);
        const liveSurface = await box(node.locator('[data-node-surface]'));
        const liveOutline = await box(
          page.locator(`[data-node-selection-outline="${id}"]`),
        );
        expect(liveSurface.x).toBeCloseTo(liveNode.x, 1);
        expect(liveSurface.y).toBeCloseTo(liveNode.y, 1);
        expect(liveSurface.width).toBeCloseTo(liveNode.width, 1);
        expect(liveSurface.height).toBeCloseTo(liveNode.height, 1);
        const liveBody = await box(
          node.locator(
            type === 'question'
              ? '.question-conversation-card'
              : 'textarea >> xpath=..',
          ),
        );
        expect(liveBody.height).toBeCloseTo(
          liveSurface.height - (type === 'question' ? 0 : 6),
          1,
        );
        expect(liveOutline.x).toBeCloseTo(liveSurface.x, 1);
        expect(liveOutline.y).toBeCloseTo(liveSurface.y, 1);
        expect(liveOutline.width).toBeCloseTo(liveSurface.width, 1);
        const outlineStyle = await page
          .locator(`[data-node-selection-outline="${id}"]`)
          .getAttribute('style');
        const bodyClass = await page.locator('body').getAttribute('class');
        if (Math.abs(liveOutline.height - liveSurface.height) >= 0.05) {
          throw new Error(
            JSON.stringify({
              liveSurface,
              liveOutline,
              outlineStyle,
              bodyClass,
            }),
          );
        }
      }).toPass({ timeout: 5000 });
      // Width/font updates and the content-driven height settle separately.
      // Keep every proportionality assertion, including while the pointer is down.
      await expect(async () => {
        await verifyScale();
      }).toPass({ timeout: 5000 });
    });
    await expect(async () => {
      await verifyScale();
    }).toPass({ timeout: 5000 });
    const scaled = await verifyScale();
    await testInfo.attach('corner-scale-metrics', {
      body: JSON.stringify({ before, scaled }, null, 2),
      contentType: 'application/json',
    });
    const saved = async (expected: typeof before) => {
      const id = await node.getAttribute('data-id');
      await expect
        .poll(async () => {
          const stored = (await persisted(page)).nodes.find(
            (entry) => entry.id === id,
          );
          return {
            widthMatches:
              Math.abs(Number(stored?.style?.width) - expected.width) < 0.1,
            fontMatches:
              Math.abs(
                Number(
                  (stored?.data.style as { fontSize?: number } | undefined)
                    ?.fontSize,
                ) - expected.font,
              ) < 0.01,
            height: stored?.style?.height,
          };
        })
        .toEqual({ widthMatches: true, fontMatches: true, height: undefined });
    };
    const restored = async (expected: typeof before) => {
      await expect
        .poll(async () => {
          const current = await contentMetrics(node);
          return Math.max(
            Math.abs(current.width - expected.width),
            Math.abs(current.font - expected.font),
            Math.abs(current.height - expected.height),
          );
        })
        .toBeLessThan(0.1);
      await saved(expected);
    };
    await saved(scaled);
    await drag(page, widthEdge(node, 'right'), -180, 35);
    await expect(async () => {
      const live = await contentMetrics(node);
      expect(live.lines).toBeGreaterThan(scaled.lines);
      expect(live.height).toBeGreaterThan(scaled.height);
    }).toPass({ timeout: 5000 });
    const reflowed = await contentMetrics(node);
    expect(reflowed.width).toBeLessThan(scaled.width - 100);
    expect(reflowed.font).toBe(scaled.font);
    expect(reflowed.insetX).toBe(scaled.insetX);
    expect(reflowed.insetY).toBe(scaled.insetY);
    expect(reflowed.lines).toBeGreaterThan(scaled.lines);
    expect(reflowed.height).toBeGreaterThan(scaled.height);
    expect(reflowed.overflow).toBeLessThanOrEqual(1);
    await saved(reflowed);
    await page.keyboard.press('ControlOrMeta+z');
    await restored(scaled);
    await page.keyboard.press('ControlOrMeta+z');
    await restored(before);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await restored(scaled);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await restored(reflowed);
    await page.reload();
    await restored(reflowed);
    await testInfo.attach('proportional-content-metrics', {
      body: JSON.stringify({ before, scaled, reflowed }, null, 2),
      contentType: 'application/json',
    });
  });
}

test.describe('Fractional selection chrome', () => {
  for (const { zoom, fontSize } of [
    { zoom: 0.5, fontSize: 240 },
    { zoom: 1, fontSize: 240 },
    { zoom: 2, fontSize: 120 },
  ]) {
    test(`Question custom-radius grips hit and resize at ${zoom} zoom`, async ({
      page,
    }) => {
      const item = fixture('question', 'Q');
      item.data.style = { fontSize };
      item.size.width = 600;
      const [node] = await seed(page, [item]);
      await restoreTestViewport(page, item, zoom);
      await page.setViewportSize({ width: 1800, height: 1800 });
      await select(page, node);
      const id = await node.getAttribute('data-id');
      for (const position of [
        'top-left',
        'top-right',
        'bottom-left',
        'bottom-right',
      ]) {
        const grip = page.locator(
          `[data-node-resize-grip="${id}:${position}"]`,
        );
        const handle = node.locator(
          `.node-resize-corner.${position.split('-').join('.')}`,
        );
        await expect
          .poll(async () => {
            const painted = await center(grip);
            const hit = await center(handle);
            return Math.max(
              Math.abs(painted.x - hit.x),
              Math.abs(painted.y - hit.y),
            );
          })
          .toBeLessThan(0.1);
        expect(
          await grip.evaluate((element, position) => {
            const bounds = element.getBoundingClientRect();
            return document
              .elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              )
              ?.matches(`.node-resize-corner.${position.split('-').join('.')}`);
          }, position),
        ).toBe(true);
      }
      const before = await box(node);
      await drag(
        page,
        page.locator(`[data-node-resize-grip="${id}:bottom-right"]`),
        50,
        40,
        async () => {
          await expect(page.locator('body')).toHaveClass(/node-resize-active/);
        },
      );
      await expect
        .poll(async () => (await box(node)).width)
        .toBeGreaterThan(before.width + 10);
      const after = await box(node);
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
      await savedWidth(page, node, after.width / zoom);
    });
  }

  for (const zoom of [0.5, 1, 2]) {
    test(`resize corners stay above selection and fixed-size at ${zoom} zoom`, async ({
      page,
    }, testInfo) => {
      const item = fixture('note');
      item.position = { x: 60, y: 60 };
      const [node] = await seed(page, [item]);
      await page.addInitScript(
        ({ id, zoom }) => {
          localStorage.setItem(
            `huabu.viewport.${id}`,
            JSON.stringify({ x: 200 - 60 * zoom, y: 180 - 60 * zoom, zoom }),
          );
        },
        { id: canvasId(page), zoom },
      );
      await page.reload();
      await select(page, node);
      const id = await node.getAttribute('data-id');
      const verify = async (size: number, hitSize: number) => {
        const bounds = await box(node);
        const dot = page.locator(`[data-connection-port-dot="${id}:right"]`);
        await expect(dot).toBeVisible();
        const dotBounds = await box(dot);
        expect(dotBounds.width).toBeCloseTo(size, 2);
        expect(dotBounds.height).toBeCloseTo(size, 2);
        const color = await dot.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        const resizeColor = await dot.evaluate((element) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--color-info)';
          element.appendChild(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        });
        expect(resizeColor).not.toBe(color);
        const outline = page.locator(`[data-node-selection-outline="${id}"]`);
        await expect(outline).toHaveCSS(
          'box-shadow',
          `${resizeColor} 0px 0px 0px 1.5px`,
        );
        await expect(outline).toHaveCSS('opacity', '1');
        const radius = await outline.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return Math.min(
            parseFloat(getComputedStyle(element).borderTopLeftRadius),
            rect.width / 2,
            rect.height / 2,
          );
        });
        const tangent = radius - (radius + 1.5) / Math.sqrt(2);
        await expect(dot).toHaveCSS('border-width', '0px');
        await expect(dot).toHaveCSS('opacity', '1');
        for (const position of [
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
        ]) {
          const grip = page.locator(
            `[data-node-resize-grip="${id}:${position}"]`,
          );
          const handle = node.locator(
            `.node-resize-corner.${position.split('-').join('.')}`,
          );
          const painted = await box(grip);
          const hit = await box(handle);
          expect(painted.width).toBeCloseTo(size, 2);
          expect(painted.height).toBeCloseTo(size, 2);
          expect(hit.width).toBeCloseTo(hitSize, 2);
          expect(hit.height).toBeCloseTo(hitSize, 2);
          // The inward square corner touches the rounded outline's outer arc.
          expect(
            Math.abs(
              (position.endsWith('right') ? painted.x : painted.x + size) -
                (bounds.x +
                  (position.endsWith('right')
                    ? bounds.width - tangent
                    : tangent)),
            ),
          ).toBeLessThan(0.05);
          expect(
            Math.abs(
              (position.startsWith('bottom') ? painted.y : painted.y + size) -
                (bounds.y +
                  (position.startsWith('bottom')
                    ? bounds.height - tangent
                    : tangent)),
            ),
          ).toBeLessThan(0.05);
          // Native canvas-space and HUD screen-space layout round separately.
          expect(
            Math.abs(hit.x + hit.width / 2 - painted.x - size / 2),
          ).toBeLessThan(0.05);
          expect(
            Math.abs(hit.y + hit.height / 2 - painted.y - size / 2),
          ).toBeLessThan(0.05);
          await expect(grip).toHaveCSS('pointer-events', 'none');
          expect(
            await grip.evaluate(
              (element) => (element as HTMLElement).style.backgroundColor,
            ),
          ).toBe('var(--color-surface)');
          await expect(grip).toHaveCSS('border-width', '0px');
          await expect(grip).toHaveCSS(
            'box-shadow',
            `${resizeColor} 0px 0px 0px 1.5px inset`,
          );
          await expect(grip).toHaveCSS('opacity', '1');
          // Opt both HUD layers into hit-testing to verify the grip stays on top.
          expect(
            await grip.evaluate((element, position) => {
              const grip = element as HTMLElement;
              const outlines = Array.from(
                document.querySelectorAll<HTMLElement>('.react-flow > .z-998'),
              );
              const previous = [grip, ...outlines].map(
                (el) => el.style.pointerEvents,
              );
              try {
                for (const el of [grip, ...outlines])
                  el.style.pointerEvents = 'auto';
                const rect = grip.getBoundingClientRect();
                return (
                  outlines.length > 0 &&
                  document.elementFromPoint(
                    position.endsWith('right')
                      ? rect.left + 0.5
                      : rect.right - 0.5,
                    position.startsWith('bottom')
                      ? rect.top + 0.5
                      : rect.bottom - 0.5,
                  ) === grip
                );
              } finally {
                [grip, ...outlines].forEach((el, i) => {
                  el.style.pointerEvents = previous[i];
                });
              }
            }, position),
          ).toBe(true);
          expect(
            await grip.evaluate((element) => {
              const r = element.getBoundingClientRect();
              return Boolean(
                document
                  .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.closest('.node-resize-corner'),
              );
            }),
          ).toBe(true);
        }
      };
      await verify(8, 20);
      const bounds = await box(node);
      await page.screenshot({
        path: testInfo.outputPath('corner-mouse.png'),
        clip: {
          x: bounds.x + bounds.width - 40,
          y: bounds.y - 40,
          width: 80,
          height: 80,
        },
      });
      const client = await page.context().newCDPSession(page);
      try {
        await touchTap(client, await center(node));
        await verify(14, 28);
        await page.screenshot({
          path: testInfo.outputPath('corner-touch.png'),
          clip: {
            x: bounds.x + bounds.width - 40,
            y: bounds.y - 40,
            width: 80,
            height: 80,
          },
        });
      } finally {
        await client.detach();
      }
      await page.mouse.click((await center(node)).x, (await center(node)).y);
      const before = await geometry(node);
      await drag(page, corner(node), 50, 30);
      await expect
        .poll(async () => (await geometry(node)).width)
        .toBeGreaterThan(before.width + 10);
    });
  }
});

test.describe('Shared single and multi-selection chrome', () => {
  for (const zoom of [0.5, 1, 2]) {
    test(`tight multi-selection shares grip paint and native resize history at ${zoom} zoom`, async ({
      page,
    }, testInfo) => {
      const first = fixture('note', 'First selection');
      first.position = { x: 60, y: 60 };
      first.size = { width: 220, height: 180 };
      const second = fixture('note', 'Second selection');
      second.position = { x: 310, y: 110 };
      second.size = { width: 220, height: 180 };
      const nodes = await seed(page, [first, second]);
      await restoreTestViewport(page, first, zoom);
      await select(page, nodes[0]);
      await expect(async () => {
        expect((await box(nodes[0])).width).toBeCloseTo(
          first.size.width * zoom,
          1,
        );
      }).toPass({ timeout: 5000 });
      const ids = await Promise.all(
        nodes.map((node) => node.getAttribute('data-id')),
      );
      const viewport = await readViewportTransform(page);
      const group = page.locator('[data-multi-selection]');
      const positions = ['tl', 'tr', 'bl', 'br'] as const;
      const paint = (grip: Locator) =>
        grip.evaluate((element) => {
          const css = getComputedStyle(element);
          return {
            background: css.backgroundColor,
            shadow: css.boxShadow,
            border: css.borderWidth,
            opacity: css.opacity,
            pointerEvents: css.pointerEvents,
          };
        });
      const theme = async (dark: boolean) => {
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle('dark', dark);
        }, dark);
        return nodes[0].evaluate((element) => {
          const probe = document.createElement('span');
          element.appendChild(probe);
          try {
            probe.style.color = 'var(--color-info)';
            const info = getComputedStyle(probe).color;
            probe.style.color = 'var(--color-surface)';
            return { info, surface: getComputedStyle(probe).color };
          } finally {
            probe.remove();
          }
        });
      };
      const singlePaint = new Map<string, Awaited<ReturnType<typeof paint>>>();
      const client = await page.context().newCDPSession(page);
      try {
        // Capture real sole-selection paint before adding the second node.
        for (const pointer of ['mouse', 'touch'] as const) {
          if (pointer === 'touch')
            await touchTap(client, await center(nodes[0]));
          for (const dark of [false, true]) {
            const colors = await theme(dark);
            const grip = page.locator(
              `[data-node-resize-grip="${ids[0]}:bottom-right"]`,
            );
            const size = pointer === 'touch' ? 14 : 8;
            await expect(async () => {
              const rect = await box(grip);
              expect(rect.width).toBeCloseTo(size, 2);
              expect(rect.height).toBeCloseTo(size, 2);
            }).toPass({ timeout: 5000 });
            await expect(grip).toHaveCSS('background-color', colors.surface);
            await expect(grip).toHaveCSS('border-width', '0px');
            await expect(grip).toHaveCSS('opacity', '1');
            await expect(grip).toHaveCSS('pointer-events', 'none');
            await expect(grip).toHaveCSS(
              'box-shadow',
              `${colors.info} 0px 0px 0px 1.5px inset`,
            );
            await expect(
              page.locator(`[data-node-selection-outline="${ids[0]}"]`),
            ).toHaveCSS('box-shadow', `${colors.info} 0px 0px 0px 1.5px`);
            singlePaint.set(`${pointer}-${dark}`, await paint(grip));
          }
        }
        await theme(false);
        // Use the canvas's native marquee after touch, independent of
        // platform modifier-key defaults or editor focus.
        const initialRects = await Promise.all(nodes.map(box));
        await page.mouse.move(
          Math.min(...initialRects.map((rect) => rect.x)) - 24,
          Math.min(...initialRects.map((rect) => rect.y)) - 24,
        );
        await page.mouse.down();
        await page.mouse.move(
          Math.max(...initialRects.map((rect) => rect.x + rect.width)) + 24,
          Math.max(...initialRects.map((rect) => rect.y + rect.height)) + 24,
          { steps: 12 },
        );
        await page.mouse.up();

        const tightBounds = async () => {
          await expect(group).toHaveCount(1);
          await expect(page.locator('.react-flow__node.selected')).toHaveCount(
            2,
          );
          const sample = await page.evaluate((nodeIds) => {
            const rect = (element: Element | null) => {
              if (!element) throw new Error('Missing selection geometry');
              const bounds = element.getBoundingClientRect();
              return {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              };
            };
            const overlay = document.querySelector('[data-multi-selection]');
            return {
              nodes: nodeIds.map((nodeId) =>
                rect(
                  document.querySelector(
                    `.react-flow__node[data-id="${nodeId}"]`,
                  ),
                ),
              ),
              outlines: [
                rect(overlay),
                rect(
                  overlay?.querySelector('[data-selection-outline="dashed"]') ??
                    null,
                ),
                rect(overlay?.querySelector('svg') ?? null),
              ],
            };
          }, ids);
          const rects = sample.nodes;
          const left = Math.min(...rects.map((rect) => rect.x));
          const top = Math.min(...rects.map((rect) => rect.y));
          const right = Math.max(...rects.map((rect) => rect.x + rect.width));
          const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
          const expected = {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          };
          const measuredSizeTolerance = 0.5 * zoom + 0.02;
          for (const actual of sample.outlines) {
            for (const axis of ['x', 'y', 'width', 'height'] as const)
              expect(
                Math.abs(actual[axis] - expected[axis]),
                `tight union ${axis}`,
              ).toBeLessThanOrEqual(measuredSizeTolerance);
          }
          expect(left).toBeGreaterThan(28);
          expect(top).toBeGreaterThan(28);
          expect(right).toBeLessThan(1440 - 28);
          expect(bottom).toBeLessThan(1000 - 28);
          for (const node of nodes) {
            await expect(node).toHaveClass(/selected/);
            await expect(
              node.locator('.react-flow__resize-control'),
            ).toHaveCount(0);
          }
          await expect(page.locator('[data-node-resize-grip]')).toHaveCount(0);
          await expect(
            group.locator('[data-multi-resize-control]'),
          ).toHaveCount(4);
          await expect(group.locator('[data-resize-grip]')).toHaveCount(4);
          expect(await readViewportTransform(page)).toBe(viewport);
          return expected;
        };
        const verifyChrome = async (
          pointer: 'mouse' | 'touch',
          dark: boolean,
        ) => {
          const colors = await theme(dark);
          await tightBounds();
          const bounds = await box(group);
          const stroke = group.locator(
            '[data-selection-outline="dashed"] svg rect',
          );
          expect(Number(await stroke.getAttribute('width'))).toBeCloseTo(
            bounds.width,
            1,
          );
          expect(Number(await stroke.getAttribute('height'))).toBeCloseTo(
            bounds.height,
            1,
          );
          await expect(stroke).toHaveAttribute('stroke-width', '1.5');
          await expect(stroke).toHaveAttribute('stroke-dasharray', '4 3');
          await expect(stroke).toHaveCSS('stroke', colors.info);
          await expect(stroke).toHaveCSS('fill', 'none');
          for (const id of ids) {
            const outline = page.locator(
              `[data-node-selection-outline="${id}"]`,
            );
            await expect(outline).toBeVisible();
            await expect(outline).toHaveCSS(
              'box-shadow',
              `${colors.info} 0px 0px 0px 1.5px`,
            );
          }
          for (const position of positions) {
            const control = group.locator(
              `[data-multi-resize-control="${position}"]`,
            );
            const grip = control.locator('[data-resize-grip]');
            const hit = await box(control);
            const visible = await box(grip);
            const hitSize = pointer === 'touch' ? 28 : 20;
            const gripSize = pointer === 'touch' ? 14 : 8;
            const expectedCenter = {
              x: bounds.x + (position.endsWith('r') ? bounds.width : 0),
              y: bounds.y + (position.startsWith('b') ? bounds.height : 0),
            };
            for (const [rect, size] of [
              [hit, hitSize],
              [visible, gripSize],
            ] as const) {
              expect(rect.width).toBeCloseTo(size, 2);
              expect(rect.height).toBeCloseTo(size, 2);
              expect(
                Math.abs(rect.x + rect.width / 2 - expectedCenter.x),
              ).toBeLessThan(0.1);
              expect(
                Math.abs(rect.y + rect.height / 2 - expectedCenter.y),
              ).toBeLessThan(0.1);
            }
            await expect(control).toHaveCSS(
              'background-color',
              'rgba(0, 0, 0, 0)',
            );
            await expect(control).toHaveCSS('border-width', '0px');
            await expect(control).toHaveCSS('box-shadow', 'none');
            await expect(control).toHaveCSS(
              'cursor',
              position === 'tl' || position === 'br'
                ? 'nwse-resize'
                : 'nesw-resize',
            );
            expect(await paint(grip)).toEqual(
              singlePaint.get(`${pointer}-${dark}`),
            );
            // Test the enlarged transparent area as well as the painted center.
            expect(
              await control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return [
                  [0.5, 0.5],
                  [0.1, 0.1],
                  [0.9, 0.1],
                  [0.1, 0.9],
                  [0.9, 0.9],
                ].every(
                  ([x, y]) =>
                    document
                      .elementFromPoint(
                        rect.x + rect.width * x,
                        rect.y + rect.height * y,
                      )
                      ?.closest('[data-multi-resize-control]') === element,
                );
              }),
            ).toBe(true);
          }
          await page.screenshot({
            path: testInfo.outputPath(
              `multi-${pointer}-${dark ? 'dark' : 'light'}.png`,
            ),
          });
        };
        await expect(async () => {
          await tightBounds();
        }).toPass({ timeout: 5000 });

        for (const pointer of ['mouse', 'touch'] as const) {
          const before = await Promise.all(nodes.map(box));
          const unionBefore = await tightBounds();
          const storedBefore = (await persisted(page)).nodes;
          const originals = ids.map((id) => {
            const node = storedBefore.find((entry) => entry.id === id);
            if (!node) throw new Error(`Missing selected node ${id}`);
            return {
              id,
              x: node.position.x,
              y: node.position.y,
              width: Number(node.style?.width),
              height: Number(node.style?.height),
            };
          });
          const control = group.locator('[data-multi-resize-control="br"]');
          const start = await center(control);
          const growing = async (dx = 80, dy = 60) => {
            await expect(async () => {
              const live = await tightBounds();
              // The opposite corner stays pinned; each move advances the union.
              expect(Math.abs(live.x - unionBefore.x)).toBeLessThan(0.1);
              expect(Math.abs(live.y - unionBefore.y)).toBeLessThan(0.1);
              expect(
                Math.abs(live.width - unionBefore.width - dx),
              ).toBeLessThanOrEqual(0.5 * zoom + 0.02);
              expect(
                Math.abs(live.height - unionBefore.height - dy),
              ).toBeLessThanOrEqual(0.5 * zoom + 0.02);
              for (let i = 0; i < nodes.length; i++) {
                const current = await box(nodes[i]);
                expect(current.width).toBeGreaterThan(before[i].width + 5);
                expect(current.height).toBeGreaterThan(before[i].height + 5);
              }
            }).toPass({ timeout: 5000 });
          };
          if (pointer === 'mouse') {
            for (const dark of [false, true]) await verifyChrome(pointer, dark);
            await drag(page, control, 40, 30, async () => {
              await growing(40, 30);
              await page.mouse.move(start.x + 80, start.y + 60, { steps: 8 });
              await growing();
              await page.screenshot({
                path: testInfo.outputPath('multi-mouse-during-resize.png'),
              });
            });
          } else {
            // A trusted touch begins on the existing group control, not the pane
            // or a member node: switching modality must not replace selection.
            await client.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [start],
            });
            try {
              await expect(async () => {
                expect((await box(control)).width).toBeCloseTo(28, 2);
              }).toPass({ timeout: 5000 });
              for (const dark of [false, true])
                await verifyChrome(pointer, dark);
              for (const distance of [40, 80]) {
                await client.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [
                    { x: start.x + distance, y: start.y + distance * 0.75 },
                  ],
                });
                await growing(distance, distance * 0.75);
              }
              await page.screenshot({
                path: testInfo.outputPath('multi-touch-during-resize.png'),
              });
            } finally {
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
              });
            }
          }
          await growing();
          const after = await Promise.all(nodes.map(box));
          const resized = originals.map((original, i) => ({
            id: original.id,
            x: original.x + (after[i].x - before[i].x) / zoom,
            y: original.y + (after[i].y - before[i].y) / zoom,
            width: after[i].width / zoom,
            height: after[i].height / zoom,
          }));
          const savedGeometry = async (expected: typeof originals) => {
            await expect
              .poll(async () => {
                const state = await persisted(page);
                return expected.every((value) => {
                  const node = state.nodes.find(
                    (entry) => entry.id === value.id,
                  );
                  return (
                    node &&
                    Math.abs(node.position.x - value.x) < 0.1 &&
                    Math.abs(node.position.y - value.y) < 0.1 &&
                    Math.abs(Number(node.style?.width) - value.width) < 0.1 &&
                    Math.abs(Number(node.style?.height) - value.height) < 0.1
                  );
                });
              })
              .toBe(true);
          };
          const restored = async (expected: typeof before) => {
            await expect(async () => {
              for (let i = 0; i < nodes.length; i++) {
                const current = await box(nodes[i]);
                for (const axis of ['x', 'y', 'width', 'height'] as const)
                  expect(
                    Math.abs(current[axis] - expected[i][axis]),
                  ).toBeLessThan(0.1);
              }
              await tightBounds();
            }).toPass({ timeout: 5000 });
          };
          await savedGeometry(resized);
          await page.keyboard.press('ControlOrMeta+z');
          await restored(before);
          await savedGeometry(originals);
          await page.keyboard.press('ControlOrMeta+Shift+z');
          await restored(after);
          await savedGeometry(resized);
          await testInfo.attach(`multi-${pointer}-geometry`, {
            body: JSON.stringify({ originals, resized }, null, 2),
            contentType: 'application/json',
          });
        }
      } finally {
        await client.detach();
      }
    });
  }
});

for (const type of ['image', 'video'] as const) {
  test(`${type} has four ratio corners, no edges, and preserves ratio after a nonuniform drag`, async ({
    page,
  }) => {
    const [node] = await seed(page, [fixture(type)]);
    if (type === 'image') await expect(node.locator('img')).toBeVisible();
    await select(page, node);
    await expect(node.locator('.node-resize-edge')).toHaveCount(0);
    const id = await node.getAttribute('data-id');
    const grips = page.locator(`[data-node-resize-grip^="${id}:"]`);
    await expect(grips).toHaveCount(4);
    await expect(grips.first()).toHaveCSS('z-index', '999');
    const before = await geometry(node);
    await drag(page, corner(node), 115, 25);
    await expect
      .poll(async () => (await geometry(node)).width)
      .toBeGreaterThan(before.width + 50);
    const after = await geometry(node);
    expect(after.width / after.height).toBeCloseTo(
      before.width / before.height,
      2,
    );
    await savedWidth(page, node, after.width);
    await page.reload();
    await expect.poll(() => geometry(node)).toEqual(after);
  });
}

for (const side of ['left', 'right', 'top', 'bottom']) {
  test(`Note real ${side} edge resizes and ports hide during drag then restore`, async ({
    page,
  }) => {
    const [node] = await seed(page, [fixture('note')]);
    await expect(node.locator('.ProseMirror')).toBeVisible();
    await select(page, node);
    await expect(node.locator('.node-resize-edge')).toHaveCount(4);
    const id = await node.getAttribute('data-id');
    await expect(page.locator(`[data-node-resize-grip^="${id}:"]`)).toHaveCount(
      4,
    );
    await expect(port(node)).toHaveCSS('opacity', '1');
    const before = await geometry(node);
    const horizontal = side === 'left' || side === 'right';
    await drag(
      page,
      node.locator(`.node-resize-edge.${side}`),
      horizontal ? (side === 'left' ? -70 : 70) : 0,
      horizontal ? 0 : side === 'top' ? -60 : 60,
      async () => {
        await expect(page.locator('body')).toHaveClass(/node-resize-active/);
        await expect(node.locator('.react-flow__handle')).toHaveCount(8);
        for (const handle of await node.locator('.react-flow__handle').all()) {
          await expect(handle).toHaveCSS('opacity', '0');
          await expect(handle).toHaveCSS('pointer-events', 'none');
        }
        await expect(
          node.locator('.react-flow__handle [role="button"]'),
        ).toHaveCount(0);
      },
    );
    await expect(port(node)).toHaveCSS('opacity', '1');
    await expect(
      node.locator('.react-flow__handle.source [role="button"]'),
    ).toHaveCount(4);
    await expect
      .poll(async () => (await geometry(node))[horizontal ? 'width' : 'height'])
      .toBeGreaterThan(before[horizontal ? 'width' : 'height'] + 30);
    const after = await geometry(node);
    expect(after[horizontal ? 'height' : 'width']).toBe(
      before[horizontal ? 'height' : 'width'],
    );
    await savedWidth(page, node, after.width);
  });
}

test('sole selection raises overlapping body and real controls without persisting order or z-index', async ({
  page,
}) => {
  const back = fixture('note', 'Back');
  const front = fixture('note', 'Front');
  front.position = { x: 350, y: 300 };
  const [a, b] = await seed(page, [back, front]);
  const order = (state: Awaited<ReturnType<typeof persisted>>) =>
    state.nodes.map((node) => ({
      id: node.id,
      zIndex: node.zIndex,
      styleZ: node.style?.zIndex,
    }));
  const baseline = order(await persisted(page));
  const aId = await a.getAttribute('data-id');
  const bId = await b.getAttribute('data-id');
  const aRect = await box(a);
  const bRect = await box(b);
  const overlap = {
    x: Math.max(aRect.x, bRect.x) + 45,
    y: Math.max(aRect.y, bRect.y) + 45,
  };
  const hit = (point: { x: number; y: number }) =>
    page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        id: target?.closest('.react-flow__node')?.getAttribute('data-id'),
        resize: !!target?.closest('.react-flow__resize-control'),
      };
    }, point);
  expect((await hit(overlap)).id).toBe(bId);
  await page.mouse.click(aRect.x + 45, aRect.y + 45);
  await expect(a).toHaveClass(/selected/);
  await expect.poll(() => hit(overlap)).toEqual({ id: aId, resize: false });
  for (const control of [
    corner(a),
    a.locator('.node-resize-edge.right'),
    a.locator('.node-resize-edge.bottom'),
  ]) {
    expect(await hit(await center(control))).toEqual({ id: aId, resize: true });
  }
  await drag(page, corner(a), 55, 45);
  const after = await geometry(a);
  expect(after.width).toBeGreaterThan(back.size.width);
  await savedWidth(page, a, after.width);
  expect(order(await persisted(page))).toEqual(baseline);
  await page.mouse.click(1100, 650);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect.poll(async () => (await hit(overlap)).id).toBe(bId);
  await page.reload();
  await expect(b).toBeVisible();
  expect(order(await persisted(page))).toEqual(baseline);
  // Resize saves the selected flag; selection-only clicks need not trigger a
  // structure save. Reload can therefore restore selection without reordering.
  // Explicitly deselect through a hit-tested empty pane before checking base z.
  const emptyPoint = await page
    .locator('.react-flow__pane')
    .evaluate((pane) => {
      const rect = pane.getBoundingClientRect();
      for (let y = rect.top + 40; y < rect.bottom - 40; y += 40) {
        for (let x = rect.left + 40; x < rect.right - 40; x += 40) {
          const target = document.elementFromPoint(x, y);
          if (target?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      throw new Error('No exposed empty pane point available');
    });
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  // Recompute screen coordinates after viewport restoration, not stored DOM order.
  const reloadedA = await box(a);
  const reloadedB = await box(b);
  expect(
    (
      await hit({
        x: Math.max(reloadedA.x, reloadedB.x) + 45,
        y: Math.max(reloadedA.y, reloadedB.y) + 45,
      })
    ).id,
  ).toBe(bId);
});

test('idle connection dots share the Plus HUD layer and remain hittable over a neighbouring node', async ({
  page,
}, testInfo) => {
  const neighbour = fixture('note', 'Neighbour');
  neighbour.position.x = 540;
  const [source] = await seed(page, [
    fixture('note', 'Port source'),
    neighbour,
  ]);
  await select(page, source);
  await page.mouse.move(1100, 650);
  const id = await source.getAttribute('data-id');
  const dots = page.locator(`[data-connection-port-dot^="${id}:"]`);
  await expect(dots).toHaveCount(4);
  await expect(source.locator('.react-flow__handle .rounded-full')).toHaveCount(
    0,
  );
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const dot = page.locator(`[data-connection-port-dot="${id}:${side}"]`);
    await expect(dot).toHaveCSS('z-index', '999');
    await expect(dot).toHaveCSS('pointer-events', 'none');
    // Temporarily opt the painter into hit-testing to verify actual stacking,
    // not merely visibility/DOM presence; restore before testing native input.
    expect(
      await dot.evaluate((element) => {
        const dot = element as HTMLElement;
        const rect = dot.getBoundingClientRect();
        const previous = dot.style.pointerEvents;
        try {
          dot.style.pointerEvents = 'auto';
          return (
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ) === dot
          );
        } finally {
          dot.style.pointerEvents = previous;
        }
      }),
    ).toBe(true);
    const point = await center(dot);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[data-handleid]')
            ?.getAttribute('data-handleid'),
        point,
      ),
    ).toBe(`${side}-source`);
  }
  await page.screenshot({
    path: testInfo.outputPath('idle-connection-dots.png'),
  });
  const right = page.locator(`[data-connection-port-dot="${id}:right"]`);
  const idleCenter = await center(right);
  await page.mouse.move(idleCenter.x, idleCenter.y);
  const plus = page.locator(`[data-connection-port-icon="${id}:right"]`);
  await expect(plus).toBeVisible();
  await expect(dots).toHaveCount(3);
  const hotCenter = await center(plus);
  expect(hotCenter.x).toBeCloseTo(idleCenter.x, 1);
  expect(hotCenter.y).toBeCloseTo(idleCenter.y, 1);
  await page.mouse.move(1100, 650);
  await expect(dots).toHaveCount(4);
  await expect(plus).toHaveCount(0);
  await page.mouse.click(idleCenter.x, idleCenter.y);
  await expect(
    page.getByRole('group', { name: /Create connected node/i }),
  ).toBeVisible();
});

for (const type of ['video', 'image', 'note'] as const) {
  test(`${type} dot-center click at 200% uses the real shell boundary`, async ({
    page,
  }) => {
    const item = fixture(type);
    const [node] = await seed(page, [item]);
    await page.addInitScript(
      ({ id, position }) => {
        localStorage.setItem(
          `huabu.viewport.${id}`,
          JSON.stringify({
            x: 200 - position.x * 2,
            y: 180 - position.y * 2,
            zoom: 2,
          }),
        );
      },
      { id: canvasId(page), position: item.position },
    );
    await page.reload();
    await select(page, node);
    await page.mouse.move(1100, 700);
    const id = await node.getAttribute('data-id');
    const bounds = await box(node);
    expect(bounds.width).toBeCloseTo(item.size.width * 2, 1);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const dot = page.locator(`[data-connection-port-dot="${id}:${side}"]`);
      await expect(dot).toBeVisible();
      const point = await center(dot);
      const boundary = {
        x:
          side === 'left'
            ? bounds.x
            : side === 'right'
              ? bounds.x + bounds.width
              : bounds.x + bounds.width / 2,
        y:
          side === 'top'
            ? bounds.y
            : side === 'bottom'
              ? bounds.y + bounds.height
              : bounds.y + bounds.height / 2,
      };
      const anchor = await center(port(node, side));
      expect(anchor.x).toBeCloseTo(boundary.x, 1);
      expect(anchor.y).toBeCloseTo(boundary.y, 1);
      expect(point.x - boundary.x).toBeCloseTo(
        side === 'left' ? -16 : side === 'right' ? 16 : 0,
        1,
      );
      expect(point.y - boundary.y).toBeCloseTo(
        side === 'top' ? -16 : side === 'bottom' ? 16 : 0,
        1,
      );
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('[data-handleid]')
              ?.getAttribute('data-handleid'),
          point,
        ),
      ).toBe(`${side}-source`);
    }
    const point = await center(
      page.locator(`[data-connection-port-dot="${id}:right"]`),
    );
    await page.mouse.click(point.x, point.y);
    const picker = page.getByRole('group', { name: /Create connected node/i });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: /New Note/i }).click();
    await expect.poll(async () => (await persisted(page)).nodes.length).toBe(2);
    await expect
      .poll(
        async () =>
          (await persisted(page)).edges.filter((edge) => edge.source === id)
            .length,
      )
      .toBe(1);
  });
}

test('outward ports retain native drag-connect and click-create after resize', async ({
  page,
}) => {
  const target = fixture('note', 'Target');
  target.position = { x: 720, y: 200 };
  target.size = { width: 280, height: 240 };
  const [source, destination] = await seed(page, [
    fixture('note', 'Source'),
    target,
  ]);
  await select(page, source);
  await drag(page, source.locator('.node-resize-edge.right'), 40, 0);
  await expect(port(source)).toHaveCSS('opacity', '1');
  await page.mouse.move(1100, 650);
  const dot = page.locator(
    `[data-connection-port-dot="${await source.getAttribute('data-id')}:right"]`,
  );
  const dotPoint = await center(dot);
  const sourceBox = await box(source);
  expect(dotPoint.x - sourceBox.x - sourceBox.width).toBeCloseTo(16, 0);
  const start = await center(port(source).getByRole('button'));
  const end = await center(destination);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await page.mouse.up();
  const sourceId = await source.getAttribute('data-id');
  const targetId = await destination.getAttribute('data-id');
  await expect
    .poll(async () =>
      (await persisted(page)).edges.some(
        (edge) => edge.source === sourceId && edge.target === targetId,
      ),
    )
    .toBe(true);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await select(page, source);
  await port(source, 'bottom').getByRole('button').click();
  const picker = page.getByRole('group', { name: /Create connected node/i });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /New Note/i }).click();
  await expect.poll(async () => (await persisted(page)).nodes.length).toBe(3);
  await expect.poll(async () => (await persisted(page)).edges.length).toBe(2);
});

for (const nearTop of [false, true]) {
  for (const touch of [false, true]) {
    test(`node toolbar clears full connection hit areas (near top=${nearTop}, touch=${touch})`, async ({
      page,
    }) => {
      const specimen = fixture('note');
      specimen.position.y = nearTop ? 50 : 200;
      const [node] = await seed(page, [specimen]);
      if (touch) {
        const client = await page.context().newCDPSession(page);
        try {
          await touchTap(client, await center(node));
        } finally {
          await client.detach();
        }
        await expect(node).toHaveClass(/selected/);
      } else {
        await select(page, node);
      }
      const toolbar = page.locator('.node-floating-toolbar');
      await expect(toolbar).toBeVisible();
      await expect
        .poll(async () => {
          const bar = await box(toolbar);
          const nodeBox = await box(node);
          const side = bar.y >= nodeBox.y + nodeBox.height ? 'bottom' : 'top';
          const hitBox = await box(port(node, side).getByRole('button'));
          return side === 'bottom'
            ? bar.y - hitBox.y - hitBox.height
            : hitBox.y - bar.y - bar.height;
        })
        .toBeGreaterThanOrEqual(7.5);
      const nodeBox = await box(node);
      const toolbarBox = await box(toolbar);
      if (nearTop)
        expect(toolbarBox.y).toBeGreaterThan(nodeBox.y + nodeBox.height);
      else expect(toolbarBox.y + toolbarBox.height).toBeLessThan(nodeBox.y);
      for (const side of ['top', 'bottom', 'left', 'right']) {
        const button = port(node, side).getByRole('button');
        const hitBox = await box(button);
        expect(hitBox.width).toBeCloseTo(touch ? 28 : 20, 0);
        for (const p of [
          { x: hitBox.x + 1, y: hitBox.y + 1 },
          { x: hitBox.x + hitBox.width - 1, y: hitBox.y + 1 },
          { x: hitBox.x + 1, y: hitBox.y + hitBox.height - 1 },
          { x: hitBox.x + hitBox.width - 1, y: hitBox.y + hitBox.height - 1 },
        ]) {
          const hitsPort = await page.evaluate(
            ({ x, y }) =>
              document
                .elementFromPoint(x, y)
                ?.closest('[data-handleid]')
                ?.getAttribute('data-handleid'),
            p,
          );
          expect(hitsPort).toBe(`${side}-source`);
        }
      }
    });
  }
}

for (const side of ['top', 'right', 'bottom', 'left']) {
  test(`hover connection tooltip clears ${side} Plus without clicking`, async ({
    page,
  }) => {
    const [node] = await seed(page, [fixture('note', 'Tooltip source')]);
    await select(page, node);
    const button = port(node, side).getByRole('button');
    await button.hover();
    const tooltip = page
      .getByRole('tooltip')
      .filter({ hasText: /Create connected node/i });
    await expect(tooltip).toBeVisible();
    await expect(
      page.getByRole('group', { name: /Create connected node/i }),
    ).toBeHidden();
    const id = await node.getAttribute('data-id');
    const icon = page.locator(`[data-connection-port-icon="${id}:${side}"]`);
    await expect(icon).toBeVisible();
    await expect
      .poll(async () => {
        const tip = await box(tooltip);
        const plus = await box(icon);
        return Math.max(
          tip.y - plus.y - plus.height,
          plus.y - tip.y - tip.height,
        );
      })
      .toBeGreaterThanOrEqual(7.5);
    await page.mouse.move(1100, 650);
    await expect(tooltip).toBeHidden();
  });
}

for (const nearTop of [false, true]) {
  for (const input of ['mouse', 'touch', 'keyboard'] as const) {
    test(`top connection creation picker leaves Plus exposed (near top=${nearTop}, input=${input})`, async ({
      page,
    }) => {
      const specimen = fixture('note', 'Picker source');
      specimen.position.y = nearTop ? 50 : 200;
      const [node] = await seed(page, [specimen]);
      await select(page, node);
      const button = port(node, 'top').getByRole('button');
      if (input === 'keyboard') {
        await button.focus();
        await page.keyboard.press('Enter');
      } else if (input === 'touch') {
        const client = await page.context().newCDPSession(page);
        try {
          await touchTap(client, await center(node));
          await expect(button).toHaveCSS('width', '28px');
          const hit = await box(button);
          await touchTap(client, { x: hit.x + hit.width / 2, y: hit.y + 1 });
        } finally {
          await client.detach();
        }
      } else {
        const hit = await box(button);
        // The inner edge of the top hit area is where the old 12px gap overlaps Plus.
        await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height - 1);
      }
      const picker = page.getByRole('group', {
        name: /Create connected node/i,
      });
      await expect(picker).toBeVisible();
      const pickerChrome = picker.locator('..');
      const id = await node.getAttribute('data-id');
      const icon = page.locator(`[data-connection-port-icon="${id}:top"]`);
      await expect(icon).toBeVisible();
      await expect
        .poll(async () => {
          const menu = await box(pickerChrome);
          const plus = await box(icon);
          return Math.max(
            menu.y - plus.y - plus.height,
            plus.y - menu.y - menu.height,
          );
        })
        .toBeGreaterThanOrEqual(7.5);
      const menu = await box(pickerChrome);
      const plus = await box(icon);
      if (nearTop) expect(menu.y).toBeGreaterThan(plus.y + plus.height);
      else expect(menu.y + menu.height).toBeLessThan(plus.y);
      expect(
        await page.evaluate(
          ({ x, y }) =>
            !document.elementFromPoint(x, y)?.closest('[data-floating-chrome]'),
          {
            x: plus.x + plus.width / 2,
            y: plus.y + plus.height / 2,
          },
        ),
      ).toBe(true);
      if (input === 'mouse' && !nearTop) {
        await picker.getByRole('button', { name: /New Note/i }).click();
        await expect
          .poll(async () => (await persisted(page)).nodes.length)
          .toBe(2);
        await expect
          .poll(async () => (await persisted(page)).edges.length)
          .toBe(1);
      } else {
        await page.keyboard.press('Escape');
        await expect(picker).toBeHidden();
      }
    });
  }
}

test('trusted touch selects first, then resizes the actual Note edge without panning', async ({
  page,
}) => {
  const [node] = await seed(page, [fixture('note')]);
  const client = await page.context().newCDPSession(page);
  try {
    await touchTap(client, await center(node));
    await expect(node).toHaveClass(/selected/);
    await expect(node.locator('.node-resize-corner')).toHaveCount(4);
    const before = await geometry(node);
    const viewport = await readViewportTransform(page);
    await oneFingerDrag(
      client,
      await center(node.locator('.node-resize-edge.right')),
      90,
      0,
    );
    await expect
      .poll(async () => (await geometry(node)).width)
      .toBeGreaterThan(before.width + 40);
    expect(await readViewportTransform(page)).toBe(viewport);
    expect((await geometry(node)).height).toBe(before.height);
    await expect(page.locator('body')).not.toHaveClass(/node-resize-active/);
    await expect(
      node.locator('.react-flow__handle.source [role="button"]'),
    ).toHaveCount(4);
    await savedWidth(page, node, (await geometry(node)).width);
  } finally {
    await client.detach();
  }
});
