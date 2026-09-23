// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator } from '@playwright/test';

import { openNewCanvas, readViewportTransform, scaleOf } from './helpers';

import type * as ChangesModule from '../src/store/acpThreadChangesStore';
import type * as StoreModule from '../src/store/canvasStore';
import type * as ChatModule from '../src/store/chatStore';
import type * as PanelModule from '../src/store/panelStore';
import type * as PreviewModule from '../src/store/previewWorkspace/store';
import type { GetCanvasResponse } from '@huabu/shared';
import type * as FlowModule from '@xyflow/react';
import type { Node, ReactFlowInstance } from '@xyflow/react';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

declare global {
  interface Window {
    questionCompactFlow: ReactFlowInstance;
  }
}

// Keep the C contract explicit rather than deriving expected values from the
// production constants being migrated. Geometry is sampled at 100% zoom.
async function nearMetrics(node: Locator) {
  return node.evaluate((element) => {
    const required = (selector: string) => {
      const target = element.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`Missing Question content: ${selector}`);
      return target;
    };
    const card = required('.question-conversation-card');
    const header = required('.question-conversation-header');
    const title = required('.question-conversation-question');
    const avatar = required('.question-conversation-agent > :first-child');
    const status = required('.question-conversation-status');
    const icon = required('.question-conversation-status svg');
    const shell = required('.question-compact');
    const css = (el: Element, property: keyof CSSStyleDeclaration) =>
      Number.parseFloat(String(getComputedStyle(el)[property]));
    const rect = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      const origin = element.getBoundingClientRect();
      // Opening the workspace can pan the canvas; compare card-local layout.
      return { x: x - origin.x, y: y - origin.y, width, height };
    };
    const color = (token: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      card.append(probe);
      const result = getComputedStyle(probe).color;
      probe.remove();
      return result;
    };
    const cardRect = card.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      layout: {
        node: rect(element),
        card: rect(card),
        header: rect(header),
        title: rect(title),
        avatar: rect(avatar),
        status: rect(status),
      },
      padding: [
        'paddingLeft',
        'paddingRight',
        'paddingTop',
        'paddingBottom',
      ].map((key) => css(card, key as keyof CSSStyleDeclaration)),
      insets: [
        headerRect.left - cardRect.left,
        cardRect.right - headerRect.right,
      ],
      gap: titleRect.top - headerRect.bottom,
      titleFont: css(title, 'fontSize'),
      titleLine: css(title, 'lineHeight'),
      statusFont: css(status, 'fontSize'),
      iconSize: [css(icon, 'width'), css(icon, 'height')],
      statusColor: getComputedStyle(status).color,
      chipFill: getComputedStyle(status).backgroundColor,
      chipRadius: css(status, 'borderTopLeftRadius'),
      fill: getComputedStyle(shell).backgroundColor,
      edge: getComputedStyle(card, '::before').boxShadow,
      neutralFill: color('--bg-surface'),
      neutralEdge: color('--edge-default'),
      tone: color('--question-tone'),
      toneFill: color('--question-bg'),
      toneEdge: color('--question-light'),
    };
  });
}

async function expectNearC(node: Locator, fontSize = 24) {
  await expect(node.locator('.question-conversation-rail')).toHaveCount(0);
  await expect(node.locator('.question-conversation-status svg')).toHaveCount(
    1,
  );
  await expect(node.locator('.question-conversation-status svg')).toBeVisible();
  const scale = fontSize / 28;
  await expect(async () => {
    const metrics = await nearMetrics(node);
    for (const padding of metrics.padding)
      expect(padding).toBeCloseTo(24 * scale, 1);
    expect(metrics.layout.header.height).toBeCloseTo(32 * scale, 1);
    expect(metrics.layout.avatar.width).toBeCloseTo(32 * scale, 1);
    expect(metrics.layout.avatar.height).toBeCloseTo(32 * scale, 1);
    expect(metrics.titleFont).toBe(fontSize);
    expect(metrics.statusFont).toBeCloseTo(18 * scale, 1);
    for (const size of metrics.iconSize)
      expect(size).toBeCloseTo(16 * scale, 1);
  }).toPass({ timeout: 5000 });
  const m = await nearMetrics(node);
  for (const inset of m.insets) expect(inset).toBeCloseTo(24 * scale, 1);
  expect(m.gap).toBeCloseTo(12 * scale, 1);
  expect(m.titleLine).toBeCloseTo(36.4 * scale, 1);
  expect(m.statusColor).toBe(m.tone);
  expect(m.chipFill).toBe(m.toneFill);
  expect(m.chipRadius).toBeGreaterThan(0);
  return m;
}

test(
  'browser component: compact questions retain status, fit, native drag and far-zoom takeover',
  { tag: '@component' },
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1500, height: 1400 });
    const writes: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/api/**', async (route) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        writes.push(`${route.request().method()} ${route.request().url()}`);
        await route.fulfill({
          status: 409,
          json: { error: 'Read-only fixture' },
        });
      } else {
        await route.continue();
      }
    });
    await page.goto('/playground/question-nodes');
    await page.locator('#reference-gallery').waitFor();
    await page.evaluate(async () => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const storePath = '/src/store/canvasStore.ts';
      const questionPath = '/src/components/Nodes/question/QuestionNode.tsx';
      const cssPath = '/node_modules/@xyflow/react/dist/style.css';
      await import(cssPath);
      const { createElement: h } = (await import(reactPath))
        .default as typeof ReactModule;
      const { createRoot } = (await import(domPath))
        .default as typeof DomModule;
      const { default: store } = (await import(
        storePath
      )) as typeof StoreModule;
      const { QuestionNode } = await import(questionPath);
      const chatPath = '/src/store/chatStore.ts';
      const changesPath = '/src/store/acpThreadChangesStore.ts';
      const { useChatStore } = (await import(chatPath)) as typeof ChatModule;
      const { useAcpThreadChangesStore } = (await import(
        changesPath
      )) as typeof ChangesModule;
      useChatStore.getState().setMessages('compact-approval', [
        {
          id: 'permission-message',
          role: 'assistant',
          segments: [
            {
              kind: 'permission',
              requestId: 'compact-permission',
              toolCall: {},
              options: [],
            },
          ],
        },
      ]);
      useAcpThreadChangesStore.getState().replaceFromBroadcast(
        'compact-conflict',
        [
          {
            id: 'skipped-change',
            kind: 'update',
            label: 'Skipped edit',
            nodeId: 'unread',
            revertDeltas: [],
          },
        ],
        ['unread'],
      );
      const flowPath = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@xyflow_react.js?v='));
      if (!flowPath) throw new Error('Missing production React Flow URL');
      const { ReactFlow } = (await import(flowPath)) as typeof FlowModule;
      const nodes = [
        {
          id: 'unread',
          label: 'Compare the two approaches',
          status: 'done',
          viewed: false,
        },
        {
          id: 'running',
          label: 'Review the evidence and prepare a concise summary',
          status: 'running',
          viewed: false,
        },
        {
          id: 'viewed',
          label: 'Summarize this document',
          status: 'done',
          viewed: true,
        },
        {
          id: 'error',
          label: 'Find related work',
          status: 'error',
          viewed: false,
        },
        { id: 'idle', label: 'Hi', status: 'idle', viewed: false },
        {
          id: 'narrow',
          label:
            'A longer question title wraps without crossing the card boundary',
          status: 'idle',
          viewed: false,
        },
        {
          id: 'approval',
          label: 'Approve the next step',
          status: 'running',
          viewed: false,
          threadId: 'compact-approval',
        },
        {
          id: 'conflict',
          label: 'Review skipped changes',
          status: 'done',
          viewed: true,
          threadId: 'compact-conflict',
        },
      ].map(({ id, ...data }, index) => ({
        id,
        type: 'question',
        position: { x: (index % 3) * 480, y: Math.floor(index / 3) * 430 },
        ...(id === 'idle'
          ? {}
          : { style: { width: id === 'narrow' ? 160 : 280 } }),
        data: {
          ...data,
          content: data.label,
          agentMode: 'ask' as const,
          ...(id === 'unread' ? { style: { fontSize: 28 } } : {}),
        },
      }));
      store.setState({ isLoading: true });
      store.setState({
        canvasId: 'question-compact-memory-only',
        nodes,
        edges: [],
      });
      const host = document.createElement('div');
      host.id = 'question-compact-fixture';
      host.className = 'bg-bg-default';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999';
      document.body.append(host);
      const nodeTypes = { question: QuestionNode };
      function Fixture() {
        const liveNodes = store((state) => state.nodes);
        return h(ReactFlow, {
          nodes: liveNodes,
          edges: [],
          nodeTypes,
          onNodesChange: store.getState().onNodesChange,
          defaultViewport: { x: 60, y: 60, zoom: 1 },
          minZoom: 0.05,
          onInit: (rf) => {
            window.questionCompactFlow = rf;
          },
        });
      }
      createRoot(host).render(h(Fixture));
    });
    const fixture = page.locator('#question-compact-fixture');
    const unread = fixture.locator('[data-id="unread"]');
    await expect(unread.locator('.question-conversation-card')).toHaveAttribute(
      'data-state',
      'unread',
    );
    await expect(unread.locator('.question-conversation-status')).toHaveText(
      /To review|待查看/,
    );
    await expect(
      unread.locator('.question-conversation-status'),
    ).toHaveAttribute('title', /Turn ended · Not viewed|本轮结束 · 未查看/);
    await expect(
      fixture.locator('[data-id="running"] .question-conversation-loading'),
    ).toHaveCount(1);
    await expect(
      fixture.locator('[data-id="viewed"] .question-conversation-card'),
    ).toHaveAttribute('data-state', 'viewed');
    await expect(
      fixture.locator('[data-id="error"] .question-conversation-card'),
    ).toHaveAttribute('data-state', 'error');
    // Only the unauthored natural-width fixture adopts 440. Existing widths
    // remain meaningful, including deliberately narrow wrapping coverage.
    await expect(fixture.locator('[data-id="idle"]')).toHaveCSS(
      'width',
      '440px',
    );
    await expect(unread).toHaveCSS('width', '280px');
    await expect(fixture.locator('[data-id="narrow"]')).toHaveCSS(
      'width',
      '160px',
    );
    for (const id of [
      'unread',
      'running',
      'viewed',
      'error',
      'idle',
      'approval',
      'conflict',
    ]) {
      const node = fixture.locator(`[data-id="${id}"]`);
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-state',
        id,
      );
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-open',
        'false',
      );
      const closed = await expectNearC(node, id === 'unread' ? 28 : 24);
      const label = await node
        .locator('.question-conversation-status')
        .textContent();
      expect(label?.trim()).toBeTruthy();
      const tabId = await page.evaluate(async (nodeId) => {
        const previewPath = '/src/store/previewWorkspace/store.ts';
        const panelPath = '/src/store/panelStore.ts';
        const { usePreviewWorkspaceStore } = (await import(
          previewPath
        )) as typeof PreviewModule;
        const { usePanelStore } = (await import(
          panelPath
        )) as typeof PanelModule;
        usePanelStore.setState({ isRightCollapsed: false });
        return usePreviewWorkspaceStore.getState().openPreviewTarget({
          kind: 'node',
          canvasId: 'question-compact-memory-only',
          nodeId,
        });
      }, id);
      expect(tabId).not.toBe('');
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-open',
        'true',
      );
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-state',
        id,
      );
      await expect(node.locator('.question-conversation-status')).toHaveText(
        label ?? '',
      );
      const opened = await expectNearC(node, id === 'unread' ? 28 : 24);
      expect(opened.layout).toEqual(closed.layout);
      expect(opened.fill).toBe(opened.toneFill);
      expect(opened.edge).toContain(opened.toneEdge);
      await expect(node.locator('.question-conversation-tail')).toHaveCount(0);
      await page.evaluate(async (id) => {
        const previewPath = '/src/store/previewWorkspace/store.ts';
        const { usePreviewWorkspaceStore } = (await import(
          previewPath
        )) as typeof PreviewModule;
        usePreviewWorkspaceStore.getState().closeTab(id);
      }, tabId);
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-open',
        'false',
      );
      await expect(node.locator('.question-conversation-card')).toHaveAttribute(
        'data-state',
        id,
      );
      await expect(node.locator('.question-conversation-tail')).toHaveCount(0);
      const restored = await expectNearC(node, id === 'unread' ? 28 : 24);
      expect(restored.layout).toEqual(closed.layout);
      expect(restored.fill).toBe(closed.fill);
      expect(restored.edge).toBe(closed.edge);
    }
    await expect(
      fixture.locator('[data-id="approval"] .question-conversation-loading'),
    ).toHaveCount(0);
    await expect(
      fixture.locator('[data-id="conflict"] .question-conversation-status'),
    ).toHaveAttribute('title', /1/);
    await expect(unread.locator('.question-conversation-question')).toHaveCSS(
      'font-size',
      '28px',
    );
    await expect(unread.locator('.question-conversation-question')).toHaveCSS(
      'line-height',
      '36.4px',
    );
    await expect(unread.locator('.question-conversation-agent')).toHaveCSS(
      'font-size',
      '18px',
    );
    await expect(unread.locator('.question-conversation-status')).toHaveCSS(
      'font-size',
      '18px',
    );
    for (const node of await fixture
      .locator('.react-flow__node-question')
      .all()) {
      const geometry = await node.evaluate((el) => {
        const card = el.querySelector<HTMLElement>(
          '.question-conversation-card',
        );
        const title = el.querySelector<HTMLElement>(
          '.question-conversation-question',
        );
        const header = el.querySelector<HTMLElement>(
          '.question-conversation-header',
        );
        if (!card || !title || !header)
          throw new Error('Missing compact card content');
        return {
          width: card.clientWidth,
          scrollWidth: card.scrollWidth,
          titleBottom: title.getBoundingClientRect().bottom,
          cardBottom: card.getBoundingClientRect().bottom,
          titleTop: title.getBoundingClientRect().top,
          headerBottom: header.getBoundingClientRect().bottom,
          titleHeight: title.clientHeight,
          titleScrollHeight: title.scrollHeight,
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.titleBottom).toBeLessThanOrEqual(geometry.cardBottom);
      const fontSize =
        (await node.getAttribute('data-id')) === 'unread' ? 28 : 24;
      expect(geometry.titleTop - geometry.headerBottom).toBeCloseTo(
        (12 * fontSize) / 28,
        1,
      );
      expect(geometry.titleScrollHeight).toBeLessThanOrEqual(
        geometry.titleHeight,
      );
    }
    await page.screenshot({ path: testInfo.outputPath('compact-light.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect
      .poll(() =>
        unread.locator('.question-compact').evaluate((el) => {
          const probe = document.createElement('div');
          probe.style.backgroundColor = 'var(--bg-surface)';
          el.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(el).backgroundColor === expected;
        }),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath('compact-dark.png') });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
    const handoff = await page.evaluate(async () => {
      const shell = document.querySelector<HTMLElement>(
        '#question-compact-fixture [data-id="unread"] .question-compact',
      );
      const portal = document.querySelector<HTMLElement>(
        '[data-takeover-node="unread"]',
      );
      if (!shell || !portal) throw new Error('Missing takeover surfaces');
      const samples: {
        body: number;
        mark: number;
        stage: string | null;
        hasMark: boolean;
      }[] = [];
      const sample = async (frames: number) => {
        for (let i = 0; i < frames; i++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          samples.push({
            body: Number(getComputedStyle(shell).opacity),
            mark: Number(getComputedStyle(portal).opacity),
            stage: shell.getAttribute('data-lod-body'),
            hasMark: !!portal.querySelector('[data-question-takeover-mark]'),
          });
        }
      };
      await window.questionCompactFlow.setViewport({
        x: 60,
        y: 60,
        zoom: 0.15,
      });
      await sample(6);
      // Reverse before the outgoing animation completes, then cross again.
      await window.questionCompactFlow.setViewport({ x: 60, y: 60, zoom: 0.3 });
      await sample(6);
      await window.questionCompactFlow.setViewport({
        x: 60,
        y: 60,
        zoom: 0.15,
      });
      await sample(20);
      await window.questionCompactFlow.setViewport({ x: 60, y: 60, zoom: 1 });
      await sample(20);
      return samples;
    });
    expect(handoff.some((s) => s.mark > 0.05 && s.mark < 0.95)).toBe(true);
    expect(
      handoff.some((s) => s.stage === 'visible' && s.mark > 0.05 && s.hasMark),
      JSON.stringify(handoff),
    ).toBe(true);
    for (const sample of handoff) {
      expect(sample.body + sample.mark).toBeCloseTo(1, 4);
      if (sample.mark > 0) expect(sample.hasMark).toBe(true);
    }
    const before = await page.evaluate(() => {
      const node = window.questionCompactFlow.getNode('unread');
      if (!node) throw new Error('Missing question node');
      return node.position;
    });
    await unread.locator('.question-conversation-question').click();
    await expect(unread.locator('.react-flow__resize-control')).toHaveCount(6);
    await expect(
      unread.locator('.node-text-width-handle, .node-text-width-grip'),
    ).toHaveCount(0);
    await expect(unread.locator('.node-resize-edge')).toHaveCount(2);
    await expect(unread.locator('.node-resize-corner')).toHaveCount(4);
    await expect(
      fixture.locator('[data-node-resize-grip^="unread:"]'),
    ).toHaveCount(4);
    const grip = unread.locator(
      '.react-flow__resize-control.line.node-resize-edge.right',
    );
    await expect(grip).toBeVisible();
    await expect(grip).toHaveCSS('cursor', 'ew-resize');
    await expect(grip).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
    await expect(grip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(grip).toHaveCSS('box-shadow', 'none');
    await expect(grip.locator('*')).toHaveCount(0);
    const gripBox = await grip.boundingBox();
    const originalWidth = await unread.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    if (!gripBox) throw new Error('Missing Question resize handle');
    const nodeBox = await unread.boundingBox();
    if (!nodeBox) throw new Error('Missing Question node');
    expect(gripBox.height).toBeCloseTo(nodeBox.height, 1);
    expect(
      await grip.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ) === el
        );
      }),
    ).toBe(true);
    await page.mouse.move(
      gripBox.x + gripBox.width / 2,
      gripBox.y + gripBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      gripBox.x + gripBox.width / 2 + 120,
      gripBox.y + gripBox.height / 2 + 70,
      { steps: 10 },
    );
    await expect(unread.locator('.question-conversation-question')).toHaveCSS(
      'font-size',
      '28px',
    );
    await page.mouse.up();
    await expect
      .poll(() => unread.evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(originalWidth + 50);
    await expect(unread.locator('.question-conversation-question')).toHaveCSS(
      'font-size',
      '28px',
    );
    expect(
      await page.evaluate(
        () =>
          (
            window.questionCompactFlow.getNode('unread')?.data.style as {
              fontSize?: number;
            }
          )?.fontSize,
      ),
    ).toBe(28);
    expect(
      await page.evaluate(
        () => window.questionCompactFlow.getNode('unread')?.style?.height,
      ),
    ).toBeUndefined();
    const title = await unread
      .locator('.question-conversation-question')
      .boundingBox();
    if (!title) throw new Error('Missing question');
    await page.mouse.move(title.x + 30, title.y + 8);
    await page.mouse.down();
    await page.mouse.move(title.x + 60, title.y + 28, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.questionCompactFlow.getNode('unread')?.position.x ?? 0,
        ),
      )
      .toBeGreaterThan(before.x + 20);
    await page.evaluate(() =>
      window.questionCompactFlow.setViewport({ x: 60, y: 60, zoom: 0.1 }),
    );
    await expect(unread.locator('.question-compact')).toHaveAttribute(
      'data-lod-body',
      'hidden',
    );
    await expect(unread.locator('.question-compact')).toHaveCSS('opacity', '0');
    await expect(
      page.locator(
        '[data-takeover-node="unread"] [data-question-takeover-mark]',
      ),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('compact-far.png') });
    await page.evaluate(() =>
      window.questionCompactFlow.setViewport({ x: 60, y: 60, zoom: 1 }),
    );
    await expect(unread.locator('.question-compact')).toHaveAttribute(
      'data-lod-body',
      'visible',
    );
    await expect(unread.locator('.question-compact')).toHaveCSS('opacity', '1');
    await expect(fixture.locator('.question-agent-badge')).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  },
);

test('real Canvas Question reload keeps the card and takeover mutually exclusive', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await openNewCanvas(page);
  const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'question',
              data: { label: 'Reload Question', content: 'Reload Question' },
              position: { x: 40, y: 60 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-question-reload' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const saved = await page.request.get(`/api/canvas/${canvasId}`);
  expect(saved.ok(), await saved.text()).toBe(true);
  const record = (await saved.json()) as GetCanvasResponse;
  const state = record.state as { nodes: Node[] };
  const question = state.nodes.find((node) => node.type === 'question');
  if (!question) throw new Error('Missing persisted Question');
  await page.addInitScript((id) => {
    if (window !== window.top) return;
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({
        x: 140,
        y: 120,
        zoom: Number(sessionStorage.getItem('e2e-question-zoom') ?? '0.2'),
      }),
    );
  }, canvasId);

  for (const zoom of [0.2, 0.3, 0.2]) {
    await page.evaluate((value) => {
      sessionStorage.setItem('e2e-question-zoom', String(value));
    }, zoom);
    await page.reload();
    await expect(page.locator('.react-flow__viewport')).toBeVisible();
    await expect
      .poll(async () => scaleOf(await readViewportTransform(page)))
      .toBe(zoom);
    const shell = page.locator(
      `.react-flow__node[data-id="${question.id}"] .question-compact`,
    );
    const portal = page.locator(`[data-takeover-node="${question.id}"]`);
    const collapsed = zoom < 0.25;
    await expect(shell).toHaveAttribute(
      'data-lod-body',
      collapsed ? 'hidden' : 'visible',
    );
    await expect(shell).toHaveCSS('opacity', collapsed ? '0' : '1');
    await expect(portal).toHaveCSS('opacity', collapsed ? '1' : '0');
    await expect(portal).toHaveCSS(
      'visibility',
      collapsed ? 'visible' : 'hidden',
    );
    await page.screenshot({
      path: testInfo.outputPath(`question-reload-${zoom}.png`),
    });
  }
  expect(errors).toEqual([]);
});

test('real Canvas C questions preserve authored width and open without moving content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await openNewCanvas(page);
  const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
  expect(canvasId).toBeTruthy();
  // Reuse the real execute/storage fixture from question-card-scale; no
  // mocked Canvas responses and no forced width on the natural-size node.
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'question',
              data: { label: 'Natural C', content: 'Natural C' },
              position: { x: 40, y: 60 },
            },
            {
              nodeType: 'question',
              data: { label: 'Authored C', content: 'Authored C' },
              position: { x: 40, y: 330 },
              size: { width: 400, height: 240 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-question-compact-c' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const saved = await page.request.get(`/api/canvas/${canvasId}`);
  expect(saved.ok(), await saved.text()).toBe(true);
  const record = (await saved.json()) as GetCanvasResponse;
  const state = record.state as { nodes: Node[] };
  const naturalNode = state.nodes.find(
    (node) => node.data.label === 'Natural C',
  );
  const authoredNode = state.nodes.find(
    (node) => node.data.label === 'Authored C',
  );
  if (!naturalNode || !authoredNode)
    throw new Error('Missing real Canvas Questions');
  expect(Number(naturalNode.style?.width)).toBe(440);
  expect(Number(authoredNode.style?.width)).toBe(400);
  await page.addInitScript((id) => {
    if (window !== window.top) return;
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 140, y: 120, zoom: 1 }),
    );
  }, canvasId);
  await page.reload();
  await expect(page.locator('.react-flow__viewport')).toBeVisible();
  await expect
    .poll(async () => scaleOf(await readViewportTransform(page)))
    .toBe(1);
  const natural = page.locator(
    `.react-flow__node[data-id="${naturalNode.id}"]`,
  );
  const authored = page.locator(
    `.react-flow__node[data-id="${authoredNode.id}"]`,
  );
  await expect(natural).toHaveCSS('width', '440px');
  await expect(authored).toHaveCSS('width', '400px');
  await expectNearC(natural);
  await expectNearC(authored);

  // Select before sampling so selection chrome is not confused with open paint.
  await authored.locator('.question-conversation-question').click();
  const card = authored.locator('.question-conversation-card');
  await expect(card).toHaveAttribute('data-open', 'false');
  const closed = await nearMetrics(authored);
  expect(closed.fill).toBe(closed.neutralFill);
  expect(closed.edge).toContain(closed.neutralEdge);
  await authored.locator('.question-conversation-question').dblclick();
  await expect(card).toHaveAttribute('data-open', 'true');
  await expect(card).toHaveAttribute('data-state', 'idle');
  // Sample settled paint rather than an intermediate background transition.
  await expect(authored.locator('.question-compact')).toHaveCSS(
    'background-color',
    closed.toneFill,
  );
  const opened = await expectNearC(authored);
  for (const key of Object.keys(
    closed.layout,
  ) as (keyof typeof closed.layout)[]) {
    for (const metric of ['x', 'y', 'width', 'height'] as const) {
      // Fractional camera translation can introduce subpixel subtraction noise.
      expect(opened.layout[key][metric]).toBeCloseTo(
        closed.layout[key][metric],
        3,
      );
    }
  }
  expect(opened.fill).toBe(opened.toneFill);
  expect(opened.edge).toContain(opened.toneEdge);
  expect(opened.edge).not.toBe(closed.edge);
  const tail = authored.locator('.question-conversation-tail');
  await expect(tail).toHaveCount(0);

  // Close through the existing workspace action, without changing lifecycle
  // or injecting an isOpen prop into the production Question component.
  await page.evaluate(async (nodeId) => {
    const previewPath = '/src/store/previewWorkspace/store.ts';
    const { usePreviewWorkspaceStore } = (await import(
      previewPath
    )) as typeof PreviewModule;
    const store = usePreviewWorkspaceStore.getState();
    for (const tab of Object.values(store.workspace.tabs)) {
      if (tab.target.kind === 'node' && tab.target.nodeId === nodeId)
        store.closeTab(tab.id);
    }
  }, authoredNode.id);
  await expect(card).toHaveAttribute('data-open', 'false');
  await expect(card).toHaveAttribute('data-state', 'idle');
  await expect(tail).toHaveCount(0);
  await expect(authored.locator('.question-compact')).toHaveCSS(
    'background-color',
    closed.fill,
  );
  const restored = await expectNearC(authored);
  for (const key of Object.keys(
    closed.layout,
  ) as (keyof typeof closed.layout)[]) {
    for (const metric of ['x', 'y', 'width', 'height'] as const) {
      expect(restored.layout[key][metric]).toBeCloseTo(
        closed.layout[key][metric],
        3,
      );
    }
  }
  expect(restored.fill).toBe(closed.fill);
  expect(restored.edge).toBe(closed.edge);
  expect(errors).toEqual([]);
});
