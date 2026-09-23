// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  openNewCanvas,
  readViewportTransform,
  scaleOf,
  translateOf,
} from './helpers';

import type { GetCanvasResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

// Reuse production-selection-resize's real execute/storage seed and viewport
// pattern without importing a spec (which would register its tests as well).
// No store injection, mocked Canvas responses, or writes to the live dev stack.
const INITIAL_FONT = 31.23456789;
const INITIAL_WIDTH = 420;
const TITLE = 'Compare these approaches and their differences';

function canvasId(page: Page) {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  if (!id) throw new Error('Expected a real Canvas URL');
  return id;
}

async function persisted(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return record.state as { nodes: Node[] };
}

async function storedNode(page: Page, node: Locator) {
  const id = await node.getAttribute('data-id');
  const stored = (await persisted(page)).nodes.find((entry) => entry.id === id);
  if (!stored) throw new Error(`Missing persisted node ${id}`);
  return stored;
}

async function authoredNode(page: Page, node: Locator) {
  const stored = await storedNode(page, node);
  // First structure save can materialize React Flow's derived measurement.
  // Preserve every authored field in the cross-node isolation comparison.
  delete stored.measured;
  return stored;
}

async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'question',
                data: {
                  label: TITLE,
                  content: TITLE,
                  style: { fontSize: INITIAL_FONT },
                },
                position: { x: 60, y: 60 },
                size: { width: INITIAL_WIDTH, height: 240 },
              },
              {
                nodeType: 'text',
                data: {
                  label: 'Unaffected Text control',
                  content: 'Text keeps its own typography.',
                  style: { fontSize: 24 },
                },
                position: { x: 710, y: 430 },
                size: { width: 300, height: 120 },
              },
            ],
          },
        ],
        originator: { source: 'agent', threadId: 'e2e-question-card-scale' },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  const state = await persisted(page);
  const locator = (type: string) => {
    const node = state.nodes.find((entry) => entry.type === type);
    if (!node) throw new Error(`Missing ${type} fixture`);
    return page.locator(`.react-flow__node[data-id="${node.id}"]`);
  };
  await page.addInitScript((id) => {
    if (window !== window.top) return;
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 140, y: 120, zoom: 1 }),
    );
  }, canvasId(page));
  await page.reload();
  await expect
    .poll(async () => {
      const transform = await readViewportTransform(page);
      if (!transform) return null;
      return { ...translateOf(transform), zoom: scaleOf(transform) };
    })
    .toEqual({ x: 140, y: 120, zoom: 1 });
  const question = locator('question');
  const text = locator('text');
  await expect(question.locator('.question-conversation-question')).toHaveText(
    TITLE,
  );
  await expect(text.locator('textarea')).toHaveValue(
    'Text keeps its own typography.',
  );
  return { question, text };
}

async function select(page: Page, node: Locator) {
  const rect = await node.boundingBox();
  if (!rect) throw new Error('Expected a visible production node');
  expect(rect.x).toBeGreaterThan(0);
  expect(rect.y).toBeGreaterThan(100);
  expect(rect.x + rect.width).toBeLessThan(1440);
  expect(rect.y + rect.height).toBeLessThan(1000);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(node).toHaveClass(/selected/);
  await expect(page.locator('.node-floating-toolbar')).toBeVisible();
}

function scaleInput(page: Page) {
  return page.getByRole('spinbutton', { name: 'Scale', exact: true });
}

async function metrics(node: Locator) {
  return node.evaluate((element) => {
    const required = (selector: string) => {
      const target = element.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`Missing card content: ${selector}`);
      return target;
    };
    const card = required('.question-conversation-card');
    const title = required('.question-conversation-question');
    const header = required('.question-conversation-header');
    const agent = required('.question-conversation-agent');
    const avatar = required('.question-conversation-agent > :first-child');
    const status = required('.question-conversation-status');
    const icon = required('.question-conversation-status svg');
    const css = (el: Element, property: keyof CSSStyleDeclaration) =>
      Number.parseFloat(String(getComputedStyle(el)[property]));
    const outer = element.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const content = [title, header, agent, avatar, status, icon];
    const overflow = Math.max(
      ...[
        card,
        title,
        header,
        agent,
        status,
        ...status.querySelectorAll('span'),
      ].flatMap((el) => [
        el.scrollHeight - el.clientHeight,
        el.scrollWidth - el.clientWidth,
      ]),
    );
    const outside = Math.max(
      ...content.flatMap((el) => {
        const r = el.getBoundingClientRect();
        return [
          cardRect.left - r.left,
          r.right - cardRect.right,
          cardRect.top - r.top,
          r.bottom - cardRect.bottom,
          outer.left - r.left,
          r.right - outer.right,
          outer.top - r.top,
          r.bottom - outer.bottom,
        ];
      }),
    );
    return {
      width: css(element, 'width'),
      height: css(element, 'height'),
      font: css(title, 'fontSize'),
      lineHeight: css(title, 'lineHeight'),
      insetX: css(card, 'paddingLeft'),
      insetY: css(card, 'paddingTop'),
      header: css(header, 'height'),
      headerGap: css(header, 'marginBottom'),
      avatar: css(avatar, 'width'),
      agentFont: css(agent, 'fontSize'),
      statusFont: css(status, 'fontSize'),
      statusIcon: css(icon, 'width'),
      statusPaddingX: css(status, 'paddingLeft'),
      statusPaddingY: css(status, 'paddingTop'),
      lines: Math.round(title.clientHeight / css(title, 'lineHeight')),
      overflow,
      outside,
    };
  });
}

type CardMetrics = Awaited<ReturnType<typeof metrics>>;
const scaledMetrics = [
  'font',
  'lineHeight',
  'insetX',
  'insetY',
  'header',
  'headerGap',
  'avatar',
  'agentFont',
  'statusFont',
  'statusIcon',
  'statusPaddingX',
  'statusPaddingY',
] as const;

function expectUnclipped(current: CardMetrics) {
  expect(current.lines).toBeGreaterThan(0);
  expect(
    current.overflow,
    'No title/metadata/card scroll clipping',
  ).toBeLessThanOrEqual(1);
  expect(
    current.outside,
    'Content remains within card and node bounds',
  ).toBeLessThanOrEqual(1);
}

async function expectSaved(
  page: Page,
  node: Locator,
  width: number,
  font: number,
  widthTolerance = 0.000001,
) {
  await expect
    .poll(async () => {
      const stored = await storedNode(page, node);
      return {
        width: Math.abs(Number(stored.style?.width) - width) < widthTolerance,
        font: (stored.data.style as { fontSize?: number })?.fontSize,
        height: stored.style?.height,
      };
    })
    .toEqual({ width: true, font, height: undefined });
}

async function expectRestored(
  page: Page,
  node: Locator,
  expected: CardMetrics,
  font: number,
) {
  await expect(async () => {
    const current = await metrics(node);
    for (const key of ['width', 'height', ...scaledMetrics] as const)
      expect(Math.abs(current[key] - expected[key]), key).toBeLessThan(0.1);
    expectUnclipped(current);
  }).toPass({ timeout: 5000 });
  // Computed CSS widths have browser serialization/layout rounding; direct
  // formula checks above retain full storage precision.
  await expectSaved(page, node, expected.width, font, 0.02);
}

test.beforeEach(async ({ page }) => {
  // Prevent HMR during native interactions; real Canvas SSE remains connected.
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

test('Question toolbar preserves fractional scale, scales the whole card, and restores atomic history and persistence', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const { question, text } = await seed(page);
  await select(page, question);
  const input = scaleInput(page);
  const reset = page.getByRole('button', {
    name: 'Reset card scale to 100%',
    exact: true,
  });
  await expect(reset).toHaveCount(0);
  await expect(
    page.getByRole('spinbutton', { name: 'Font size', exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue(
    String(Math.round((INITIAL_FONT / 24) * 100)),
  );
  await expectSaved(page, question, INITIAL_WIDTH, INITIAL_FONT);
  const initial = await metrics(question);
  const questionBefore = await storedNode(page, question);
  const textBefore = await authoredNode(page, text);
  expectUnclipped(initial);

  // Observe beyond the current 1000ms structure-save debounce, not just before
  // a possible erroneous rounded write has reached the real storage endpoint.
  for (const commit of ['blur', 'Enter']) {
    await input.focus();
    if (commit === 'blur')
      await page
        .getByRole('spinbutton', { name: 'Width', exact: true })
        .focus();
    else await input.press('Enter');
    const start = Date.now();
    await expect
      .poll(
        async () => {
          expect(await storedNode(page, question)).toEqual(questionBefore);
          expect(
            Math.abs((await metrics(question)).font - INITIAL_FONT),
          ).toBeLessThan(0.001);
          return Date.now() - start;
        },
        { intervals: [100, 250, 500] },
      )
      .toBeGreaterThanOrEqual(1600);
  }

  await input.fill('150');
  await input.press('Enter');
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('150');
  const scaledWidth = (INITIAL_WIDTH * 36) / INITIAL_FONT;
  await expectSaved(page, question, scaledWidth, 36);
  await expect(async () => {
    const current = await metrics(question);
    expect(Math.abs(current.width - scaledWidth)).toBeLessThan(0.1);
    for (const key of scaledMetrics)
      expect(
        Math.abs(current[key] - (initial[key] * 36) / INITIAL_FONT),
        key,
      ).toBeLessThan(0.15);
    expect(current.lines).toBe(initial.lines);
    expect(current.height).toBeGreaterThan(initial.height);
    expectUnclipped(current);
  }).toPass({ timeout: 5000 });
  const scaled = await metrics(question);
  await testInfo.attach('card-at-150-percent', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('480');
  await width.press('Enter');
  await expectSaved(page, question, 480, 36);
  await expect(input).toHaveValue('150');
  const reflowed = await metrics(question);
  for (const key of scaledMetrics) expect(reflowed[key], key).toBe(scaled[key]);
  expectUnclipped(reflowed);

  await input.fill('100');
  await input.press('Enter');
  await expect(input).toHaveValue('100');
  await expect(reset).toHaveCount(0);
  await expectSaved(page, question, 320, 24);
  const resetMetrics = await metrics(question);
  expectUnclipped(resetMetrics);

  // Move focus out of toolbar controls so these are Canvas history shortcuts,
  // not native number-input undo. One key restores BOTH width and typography.
  await select(page, question);
  for (const [expected, font, percent] of [
    [reflowed, 36, '150'],
    [scaled, 36, '150'],
    [initial, INITIAL_FONT, String(Math.round((INITIAL_FONT / 24) * 100))],
  ] as const) {
    await page.keyboard.press('ControlOrMeta+z');
    await expectRestored(page, question, expected, font);
    await expect(input).toHaveValue(percent);
  }
  for (const [expected, font, percent] of [
    [scaled, 36, '150'],
    [reflowed, 36, '150'],
    [resetMetrics, 24, '100'],
  ] as const) {
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expectRestored(page, question, expected, font);
    await expect(input).toHaveValue(percent);
  }
  expect(await authoredNode(page, text)).toEqual(textBefore);
  await page.reload();
  await expectRestored(page, question, resetMetrics, 24);
  await select(page, question);
  await expect(input).toHaveValue('100');
  await expect(reset).toHaveCount(0);

  // Also reload a non-default scale, so a fallback-to-100 hydration bug cannot pass.
  await input.fill('150');
  await input.press('Enter');
  await expectSaved(page, question, 480, 36);
  await page.reload();
  await expectRestored(page, question, reflowed, 36);
  await select(page, question);
  await expect(input).toHaveValue('150');
  expect(await authoredNode(page, text)).toEqual(textBefore);
  await testInfo.attach('card-scale-metrics', {
    body: JSON.stringify(
      {
        initial,
        scaled,
        reflowed,
        reset: resetMetrics,
        initialStoredFont: INITIAL_FONT,
        scaledStoredWidth: scaledWidth,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('Text retains its independent font editor and has no Question scale or reset controls', async ({
  page,
}) => {
  const { question, text } = await seed(page);
  const questionBefore = await authoredNode(page, question);
  await select(page, text);
  await expect(scaleInput(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Reset card scale to 100%', exact: true }),
  ).toHaveCount(0);
  const font = page.getByRole('spinbutton', { name: 'Font size', exact: true });
  await expect(font).toHaveAttribute('name', 'font-size');
  await expect(font).toHaveValue('24');
  await font.fill('30');
  await font.press('Enter');
  await expectSaved(page, text, 300, 30);
  await expect(text.locator('textarea')).toHaveCSS('font-size', '30px');
  expect(await authoredNode(page, question)).toEqual(questionBefore);
  await page.reload();
  await select(page, text);
  await expect(font).toHaveValue('30');
  await expectSaved(page, text, 300, 30);
  await expect(scaleInput(page)).toHaveCount(0);
  expect(await authoredNode(page, question)).toEqual(questionBefore);
});
