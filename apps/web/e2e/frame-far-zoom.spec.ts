// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as HistoryModule from '../src/store/canvasHistoryManager';
import type * as StoreModule from '../src/store/canvasStore';
import type * as FlowModule from '@xyflow/react';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

declare global {
  interface Window {
    frameZoomFixture: {
      rf: FlowModule.ReactFlowInstance;
      snapshot: () => unknown;
    };
  }
}

async function mountFrames(
  page: Page,
  {
    nested = false,
    narrow = false,
    narrowHeight = 728,
    narrowChildCount = 1,
    regionTitle = '研究资料与工作笔记',
    contentSize = { width: 400, height: 320 },
    innerSize = { width: 800, height: 600 },
    structure = false,
    accent = 'teal',
    question = false,
    questionFont = 24,
    initialZoom = 0.3,
    conversation = false,
  } = {},
) {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      writes.push(`${route.request().method()} ${route.request().url()}`);
      await route.fulfill({
        status: 409,
        json: { error: 'Read-only fixture' },
      });
    } else await route.continue();
  });
  await page.goto('/playground/design');
  await page.evaluate(
    async ({
      nested,
      narrow,
      narrowHeight,
      narrowChildCount,
      regionTitle,
      contentSize,
      innerSize,
      structure,
      accent,
      question,
      questionFont,
      initialZoom,
      conversation,
    }) => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const storePath = '/src/store/canvasStore.ts';
      const historyPath = '/src/store/canvasHistoryManager.ts';
      const framePath = '/src/components/Nodes/frame/FrameNode.tsx';
      const notePath = '/src/components/Nodes/note/NoteNode.tsx';
      const officePath = '/src/components/Nodes/office/OfficeNode.tsx';
      const textPath = '/src/components/Nodes/text/TextNode.tsx';
      const questionPath = '/src/components/Nodes/question/QuestionNode.tsx';
      const edgePath = '/src/components/Panels/Canvas/edges/LabelledEdge.tsx';
      const zoomPath = '/src/components/Nodes/frame/FrameZoomContext.tsx';
      const cssPath = '/node_modules/@xyflow/react/dist/style.css';
      await import(cssPath);
      const { createElement: h } = (await import(reactPath))
        .default as typeof ReactModule;
      const { createRoot } = (await import(domPath))
        .default as typeof DomModule;
      const { default: store } = (await import(
        storePath
      )) as typeof StoreModule;
      const { canvasHistoryManager: history, createSnapshot } = (await import(
        historyPath
      )) as typeof HistoryModule;
      const { FrameNode } = await import(framePath);
      const { NoteNode } = await import(notePath);
      const { OfficeNode } = await import(officePath);
      const { TextNode } = await import(textPath);
      const { QuestionNode } = await import(questionPath);
      const { LabelledEdge } = await import(edgePath);
      const { FrameZoomProvider, FrameZoomController } = await import(zoomPath);
      const flowPath = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@xyflow_react.js?v='));
      if (!flowPath) throw new Error('Missing React Flow module');
      const { ReactFlow } = (await import(flowPath)) as typeof FlowModule;
      const makeNode = (
        id: string,
        type: string,
        width: number,
        height: number,
        x: number,
        y: number,
        parentId?: string,
      ): FlowModule.Node => ({
        id,
        type,
        parentId,
        position: { x, y },
        style: { width, height },
        zIndex: parentId ? 21 : id === 'empty' ? 22 : 20,
        data: {
          label: id === 'outer' ? regionTitle : id,
          sizing: 'manual',
          layoutMode: 'free',
          style: { accent },
          ...(type === 'note'
            ? { content: `# ${id}\n\nExisting body text.`, heightMode: 'fixed' }
            : {}),
          ...(type === 'office'
            ? { format: 'docx', src: '', summary: 'Existing summary' }
            : {}),
        },
      });
      const nodes = narrow
        ? [
            makeNode('outer', 'frame', 440, narrowHeight, 0, 0),
            makeNode('note', 'note', 400, 644, 20, 64, 'outer'),
          ]
        : nested
          ? [
              makeNode('outer', 'frame', 1800, 1000, 0, 0),
              makeNode(
                'inner',
                'frame',
                innerSize.width,
                innerSize.height,
                20,
                64,
                'outer',
              ),
              makeNode('leaf', 'note', 200, 200, 20, 64, 'inner'),
            ]
          : [
              makeNode('outer', 'frame', 1400, 700, 0, 0),
              makeNode(
                'note',
                'note',
                contentSize.width,
                contentSize.height,
                20,
                64,
                'outer',
              ),
              makeNode('office', 'office', 200, 200, 600, 300, 'outer'),
              makeNode('empty', 'frame', 400, 300, 1500, 0),
            ];
      if (narrow) {
        for (let index = 1; index < narrowChildCount; index++) {
          nodes.push(
            makeNode(`extra-${index}`, 'text', 60, 20, 20, 64, 'outer'),
          );
        }
      }
      if (structure) {
        nodes.push(makeNode('text', 'text', 300, 100, 450, 64, 'outer'));
        nodes.push(makeNode('other', 'frame', 1000, 700, 2000, 0));
        nodes.push(makeNode('other-note', 'note', 400, 320, 20, 64, 'other'));
      }
      if (question) {
        const questionNode = makeNode(
          'question',
          'question',
          440,
          180,
          750,
          64,
          'outer',
        );
        if (conversation) {
          questionNode.data = {
            ...questionNode.data,
            status: 'running',
            threadId: 'e2e-takeover-thread',
            agentBinding: { kind: 'internal' },
            content: 'Existing question',
          };
        }
        if (questionFont !== 24) {
          questionNode.data = {
            ...questionNode.data,
            style: { fontSize: questionFont },
          };
        }
        nodes.push(questionNode);
      }
      const edges: FlowModule.Edge[] =
        nested || narrow
          ? []
          : [
              {
                id: 'edge',
                source: 'note',
                target: 'office',
                sourceHandle: 'right-source',
                targetHandle: 'left-target',
              },
            ];
      if (structure) {
        edges.push(
          {
            id: 'text-edge',
            type: 'labelled',
            source: 'text',
            target: 'note',
            data: { edgeStyle: { label: 'Internal relation' } },
          },
          {
            id: 'cross-edge',
            type: 'labelled',
            source: 'note',
            target: 'other-note',
            data: { edgeStyle: { label: 'Cross region' } },
          },
        );
      }
      store.setState({ isLoading: true });
      store.setState({ canvasId: 'e2e-frame-zoom-memory', nodes, edges });
      history.activate('e2e-frame-zoom-memory', true);
      history.takeSnapshot(nodes, edges);
      const host = document.createElement('div');
      host.id = 'frame-zoom-fixture';
      host.className = 'bg-bg-default';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999';
      document.body.append(host);
      function Fixture() {
        const liveNodes = store((state) => state.nodes);
        return h(
          FrameZoomProvider,
          null,
          h(
            ReactFlow,
            {
              nodes: liveNodes,
              edges,
              nodeTypes: {
                frame: FrameNode,
                note: NoteNode,
                office: OfficeNode,
                text: TextNode,
                question: QuestionNode,
              },
              edgeTypes: { labelled: LabelledEdge },
              onNodesChange: store.getState().onNodesChange,
              defaultViewport: { x: 60, y: 60, zoom: initialZoom },
              minZoom: 0.02,
              maxZoom: 2,
              onlyRenderVisibleElements: false,
              zIndexMode: 'manual',
              elevateNodesOnSelect: false,
              onInit: (rf: FlowModule.ReactFlowInstance) => {
                window.frameZoomFixture = {
                  rf,
                  snapshot: () => ({
                    nodes: createSnapshot(
                      store.getState().nodes,
                      store.getState().edges,
                    ),
                    canUndo: history.canUndo,
                    canRedo: history.canRedo,
                  }),
                };
              },
            },
            h(FrameZoomController),
          ),
        );
      }
      createRoot(host).render(h(Fixture));
    },
    {
      nested,
      narrow,
      narrowHeight,
      narrowChildCount,
      regionTitle,
      contentSize,
      innerSize,
      structure,
      accent,
      question,
      questionFont,
      initialZoom,
      conversation,
    },
  );
  await expect(
    page.locator('#frame-zoom-fixture [data-frame-header]').first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.frameZoomFixture.rf
          .getNodes()
          .every((node) => !!node.measured?.width),
      ),
    )
    .toBe(true);
  const snapshot = await page.evaluate(() =>
    window.frameZoomFixture.snapshot(),
  );
  return { writes, errors, snapshot };
}

const shell = (page: Page, id: string) =>
  page
    .locator(
      `#frame-zoom-fixture .react-flow__node[data-id="${id}"] .semantic-lod-node`,
    )
    .first();
const region = (page: Page, id: string) =>
  page.locator(`#frame-zoom-fixture [data-frame-region-owner="${id}"]`);
async function zoomTo(page: Page, zoom: number) {
  await page.evaluate(async (zoom) => {
    await window.frameZoomFixture.rf.setViewport({ x: 60, y: 60, zoom });
  }, zoom);
}

for (const contentSize of [
  { width: 100, height: 80 },
  { width: 1000, height: 600 },
]) {
  test(`Frame takeover uses scale for ${contentSize.width}px content and preserves the node-title stage`, async ({
    page,
  }) => {
    const audit = await mountFrames(page, { contentSize });
    await zoomTo(page, 0.24);
    await expect(region(page, 'outer')).toHaveCount(0);
    await expect(shell(page, 'office').locator('[data-study-label]')).toHaveCSS(
      'opacity',
      '1',
    );
    await zoomTo(page, 0.18);
    await expect(region(page, 'outer')).toHaveCount(0);
    await zoomTo(page, 0.16);
    await expect(region(page, 'outer')).toHaveCount(0);
    await zoomTo(page, 0.14);
    await expect(region(page, 'outer')).toBeVisible();
    await expect(shell(page, 'note')).toHaveCSS('opacity', '1');
    await zoomTo(page, 0.19);
    await expect(region(page, 'outer')).toBeVisible();
    await zoomTo(page, 0.2);
    await expect(region(page, 'outer')).toHaveCount(0);
    await expect(shell(page, 'office').locator('[data-study-label]')).toHaveCSS(
      'opacity',
      '1',
    );
    expect(
      await page.evaluate(() => window.frameZoomFixture.snapshot()),
    ).toEqual(audit.snapshot);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('Frame takeover retains the Question mark without restoring its card shell', async ({
  page,
}, testInfo) => {
  const audit = await mountFrames(page, { question: true });
  const questionShell = shell(page, 'question');
  const mark = page.locator(
    '#frame-zoom-fixture [data-takeover-node="question"]',
  );
  const dot = mark.locator('[data-question-takeover-dot]');
  await expect(questionShell).toHaveCSS('opacity', '1');
  await expect(
    questionShell.locator('.question-conversation-question'),
  ).toHaveCSS('font-size', '24px');
  const geometry = await page.evaluate(() =>
    window.frameZoomFixture.snapshot(),
  );
  for (const [zoom, readable] of [
    [0.24, true],
    [0.2, false],
    [0.14, false],
    [0.1, false],
    [0.19, false],
    [0.2, false],
    [0.22, false],
    [5.5 / 24, true],
  ] as const) {
    await zoomTo(page, zoom);
    const suppressed = zoom >= 0.1 && zoom < 0.2;
    await expect(questionShell).toHaveCSS('opacity', readable ? '1' : '0');
    if (suppressed) {
      await expect(region(page, 'outer')).toBeVisible();
      await expect(questionShell).toHaveAttribute(
        'data-frame-suppressed',
        'true',
      );
      await expect(shell(page, 'note')).toHaveCSS('opacity', '1');
      await expect(dot).toBeVisible();
      await expect(dot).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      expect(
        await dot.evaluate((element) => {
          const style = getComputedStyle(element);
          return parseFloat(style.borderRadius) >= parseFloat(style.width) / 2;
        }),
      ).toBe(true);
      await expect(mark.locator('[data-question-takeover-avatar]')).toHaveCount(
        0,
      );
      await expect(mark.locator('svg')).toHaveCount(0);
      const bounds = await dot.boundingBox();
      expect(bounds?.width).toBeCloseTo(180 * 0.75 * zoom, 1);
      expect(bounds?.height).toBeCloseTo(180 * 0.75 * zoom, 1);
    } else {
      await expect(region(page, 'outer')).toHaveCount(0);
      await expect(dot).toHaveCount(0);
      if (!readable) {
        await expect(
          mark.locator('[data-question-takeover-avatar]'),
        ).toBeVisible();
      }
    }
    await expect(mark).toHaveCSS('opacity', readable ? '0' : '1');
    if (!readable) {
      await expect(mark).toBeVisible();
      const markBody = mark.locator(':scope > .nopan');
      await expect(markBody).toHaveCSS('pointer-events', 'auto');
      expect(
        await markBody.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit !== null && element.contains(hit);
        }),
      ).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath(`question-frame-${zoom}.png`),
    });
    if (zoom === 0.14) {
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await expect(dot).toHaveCSS('background-color', 'oklch(0.87 0 0)');
      await page.screenshot({
        path: testInfo.outputPath('question-frame-dark.png'),
      });
      await page.evaluate(() =>
        document.documentElement.classList.remove('dark'),
      );
    }
  }
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    geometry,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('Question opens from initial far zoom without restoring its card or changing zoom', async ({
  page,
}, testInfo) => {
  const audit = await mountFrames(page, {
    question: true,
    initialZoom: 0.2,
    conversation: true,
  });
  const card = shell(page, 'question');
  const portal = page.locator(
    '#frame-zoom-fixture [data-takeover-node="question"]',
  );
  const mark = portal.locator('[data-question-takeover-mark]');
  const avatar = portal.locator('[data-question-takeover-avatar]');
  await expect(card).toHaveCSS('opacity', '0');
  await expect(portal).toHaveCSS('opacity', '1');
  const before = await page.evaluate(() =>
    window.frameZoomFixture.rf.getViewport(),
  );
  const cardBounds = await card.boundingBox();
  const avatarBounds = await avatar.boundingBox();
  expect(avatarBounds?.height).toBeCloseTo(
    Math.min(cardBounds!.height, cardBounds!.width) * 0.75,
    1,
  );
  await mark.dblclick();
  await expect(mark).toHaveAttribute('data-open', 'true');
  await expect(portal.locator('.question-agent-badge-bubble')).toBeVisible();
  await expect(card).toHaveCSS('opacity', '0');
  await expect(portal).toHaveCSS('opacity', '1');
  expect((await avatar.boundingBox())?.height).toBeCloseTo(
    avatarBounds!.height,
    1,
  );
  expect(
    await page.evaluate(() => window.frameZoomFixture.rf.getViewport()),
  ).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('far-open.png') });
  await page.evaluate(async () => {
    const modulePath = '/src/store/panelStore.ts';
    const { usePanelStore } = await import(modulePath);
    usePanelStore.getState().setRightCollapsed(true);
  });
  await expect(mark).toHaveAttribute('data-open', 'false');
  await expect(card).toHaveCSS('opacity', '0');
  await zoomTo(page, 5.5 / 24);
  await expect(card).toHaveCSS('opacity', '1');
  await expect(portal).toHaveCSS('opacity', '0');
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('Question uses screen-font thresholds for small titles', async ({
  page,
}) => {
  const audit = await mountFrames(page, {
    question: true,
    questionFont: 12,
    initialZoom: 0.6,
  });
  const card = shell(page, 'question');
  const portal = page.locator(
    '#frame-zoom-fixture [data-takeover-node="question"]',
  );
  await expect(card.locator('.question-conversation-question')).toHaveCSS(
    'font-size',
    '12px',
  );
  for (const [zoom, readable] of [
    [0.49, true],
    [5 / 12, true],
    [0.41, false],
    [0.45, false],
    [5.5 / 12, true],
  ] as const) {
    await zoomTo(page, zoom);
    await expect(card).toHaveCSS('opacity', readable ? '1' : '0');
    await expect(portal).toHaveCSS('opacity', readable ? '0' : '1');
  }
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('Question large titles stay readable until Frame suppression takes over', async ({
  page,
}) => {
  const audit = await mountFrames(page, { question: true, questionFont: 48 });
  const card = shell(page, 'question');
  const portal = page.locator(
    '#frame-zoom-fixture [data-takeover-node="question"]',
  );
  await expect(card.locator('.question-conversation-question')).toHaveCSS(
    'font-size',
    '48px',
  );
  await zoomTo(page, 0.2);
  await expect(card).toHaveCSS('opacity', '1');
  await expect(portal).toHaveCSS('opacity', '0');
  await zoomTo(page, 0.14);
  await expect(card).toHaveCSS('opacity', '0');
  await expect(portal).toHaveCSS('opacity', '1');
  await expect(portal.locator('[data-question-takeover-dot]')).toBeVisible();
  await zoomTo(page, 0.2);
  await expect(card).toHaveCSS('opacity', '1');
  await expect(portal).toHaveCSS('opacity', '0');
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('region takeover preserves same-accent Text and Note structure and dims only internal edges', async ({
  page,
}, testInfo) => {
  const audit = await mountFrames(page, { structure: true });
  const internal = page.locator(
    '#frame-zoom-fixture .react-flow__edge[data-id="text-edge"]',
  );
  const cross = page.locator(
    '#frame-zoom-fixture .react-flow__edge[data-id="cross-edge"]',
  );
  await expect(internal.locator('[data-frame-internal-edge]')).toHaveCount(0);
  await zoomTo(page, 0.14);
  for (const id of ['note', 'text', 'office']) {
    await expect(shell(page, id)).toHaveCSS('opacity', '1');
    await expect(shell(page, id).locator('.semantic-lod-content')).toHaveCSS(
      'visibility',
      'hidden',
    );
  }
  const backgrounds = await Promise.all(
    ['note', 'text', 'office'].map((id) =>
      shell(page, id).evaluate((el) => getComputedStyle(el).backgroundColor),
    ),
  );
  expect(backgrounds[0]).not.toBe('rgba(0, 0, 0, 0)');
  expect(new Set(backgrounds).size).toBe(1);
  expect(backgrounds[0]).toMatch(/^color\(srgb [^/]+(?:\/\s*1)?\)$/);
  const border = await shell(page, 'note').evaluate(
    (el) => getComputedStyle(el).borderTopColor,
  );
  // The canonical accent divider has 0.3 alpha; suppression multiplies it by 0.4.
  expect(border).toMatch(/\/\s*0\.12\)/);
  const textBorder = await shell(page, 'text').evaluate(
    (el) => getComputedStyle(el).borderTopColor,
  );
  expect(textBorder).toMatch(/\/\s*0\)/);
  await expect(internal.locator('[data-frame-internal-edge]')).toHaveAttribute(
    'opacity',
    '0.4',
  );
  await expect(cross.locator('[data-frame-internal-edge]')).toHaveCount(0);
  await expect(
    page.getByText('Internal relation', { exact: true }),
  ).toBeHidden();
  await expect(page.getByText('Cross region', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('frame-structure.png') });
  await zoomTo(page, 0.2);
  await expect(shell(page, 'text').locator('.semantic-lod-content')).toHaveCSS(
    'visibility',
    'visible',
  );
  await expect(internal.locator('[data-frame-internal-edge]')).toHaveCount(0);
  await expect(
    page.getByText('Internal relation', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    audit.snapshot,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

for (const accent of ['white', 'teal']) {
  test(`far Frame ${accent} keeps a top-left title with a trailing count badge`, async ({
    page,
  }, testInfo) => {
    const audit = await mountFrames(page, { narrow: true, accent });
    for (const dark of [false, true]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        dark,
      );
      for (const zoom of [0.14, 0.1, 0.07]) {
        await zoomTo(page, zoom);
        const owner = region(page, 'outer');
        const count = owner.locator('[data-frame-region-count]');
        const title = owner.locator('[data-frame-region-title]');
        await expect(count).toHaveText('1');
        await expect(count).toHaveCSS('align-items', 'center');
        await expect(count).toHaveCSS('height', '10px');
        await expect(count).toHaveCSS('width', '10px');
        await expect(owner.locator('[data-frame-region-marker]')).toHaveCount(
          0,
        );
        await expect(title).toHaveCSS('text-align', 'left');
        await expect(title).toHaveCSS('font-size', '11px');
        await expect(title).toHaveCSS('font-weight', '500');
        const veil = owner.locator('[data-frame-region-veil]');
        await expect(veil).toHaveCSS('opacity', '0.6');
        await expect(veil).toHaveCSS('pointer-events', 'none');
        await expect(owner.locator('[data-frame-region-label]')).toHaveCSS(
          'opacity',
          '1',
        );
        const frameBox = await owner.boundingBox();
        const veilBox = await veil.boundingBox();
        expect(veilBox).toEqual(frameBox);
        const labelBox = await owner
          .locator('[data-frame-region-label]')
          .boundingBox();
        const titleBox = await title.boundingBox();
        if (!frameBox || !labelBox || !titleBox)
          throw new Error('Missing region geometry');
        const countBox = await count.boundingBox();
        if (!countBox) throw new Error('Missing count badge');
        if ((await owner.locator('[data-frame-region-inline]').count()) === 0) {
          expect(countBox.y).toBeGreaterThanOrEqual(
            titleBox.y + titleBox.height - 0.1,
          );
        }
        expect(countBox.x).toBeGreaterThanOrEqual(labelBox.x - 0.1);
        expect(countBox.x + countBox.width).toBeLessThanOrEqual(
          labelBox.x + labelBox.width + 0.1,
        );
        expect(countBox.y + countBox.height).toBeLessThanOrEqual(
          frameBox.y + frameBox.height - 8 * zoom + 0.1,
        );
        expect(labelBox.x).toBeGreaterThan(frameBox.x);
        expect(labelBox.y).toBeGreaterThanOrEqual(frameBox.y);
        expect(titleBox.x).toBeCloseTo(labelBox.x, 1);
        expect(titleBox.y).toBeCloseTo(labelBox.y, 1);
        const headerPosition = await shell(page, 'outer')
          .locator('[data-frame-header] > div')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              left: Number.parseFloat(style.left),
              top: Number.parseFloat(style.top),
              width: Number.parseFloat(style.maxWidth),
            };
          });
        expect(labelBox.x - frameBox.x).toBeCloseTo(
          headerPosition.left * zoom,
          1,
        );
        expect(labelBox.y - frameBox.y).toBeCloseTo(
          headerPosition.top * zoom,
          1,
        );
        expect(labelBox.width).toBeCloseTo(headerPosition.width * zoom, 1);
        await page.screenshot({
          path: testInfo.outputPath(
            `${accent}-${dark ? 'dark' : 'light'}-${zoom}.png`,
          ),
        });
      }
    }
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('Agent title starts on the first line before the count badge', async ({
  page,
}, testInfo) => {
  const audit = await mountFrames(page, {
    narrow: true,
    narrowHeight: 816,
    regionTitle: 'Agent 任务编排 IDE',
  });
  for (const zoom of [0.14, 0.12, 0.11, 0.105, 0.1, 0.09, 0.1, 0.105, 0.14]) {
    await zoomTo(page, zoom);
    const owner = region(page, 'outer');
    const title = owner.locator('[data-frame-region-title]');
    const result = await title.evaluate((element) => {
      const word = element.querySelector('[data-study-word]');
      const label = element.closest('[data-frame-region-label]');
      if (!word || !label) throw new Error('Missing Frame title');
      const bounds = element.getBoundingClientRect();
      return {
        height: bounds.height,
        availableHeight: Number.parseFloat(getComputedStyle(label).maxHeight),
        wordRects: [...word.getClientRects()].map((rect) => ({
          top: rect.top - bounds.top,
          bottom: rect.bottom - bounds.top,
          left: rect.left - bounds.left,
          width: rect.width,
        })),
        width: bounds.width,
        lines: Number(getComputedStyle(element).webkitLineClamp),
        inline: !!element.closest('[data-frame-region-inline]'),
      };
    });
    if (!result.inline)
      expect(result.lines).toBe(Math.floor(result.availableHeight / 16) - 1);
    expect(result.height).toBeLessThanOrEqual(result.availableHeight);
    expect(result.wordRects).toHaveLength(1);
    expect(result.wordRects[0].width).toBeLessThanOrEqual(result.width);
    expect(result.wordRects[0].bottom).toBeLessThanOrEqual(result.height);
    expect(result.wordRects[0].top).toBeLessThan(16);
    expect(result.wordRects[0].left).toBeCloseTo(0, 1);
    await expect(owner.locator('[data-frame-region-count]')).toHaveText('1');
    await owner.screenshot({ path: testInfo.outputPath(`agent-${zoom}.png`) });
  }
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    audit.snapshot,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

for (const [titleText, childCount, mobile] of [
  ['AI', 6, false],
  ['产品研究资料 AI', 7, false],
  [
    'A very long Frame title with research notes and supporting documents',
    12,
    true,
  ],
  ['很长的分组标题需要省略但数量徽章必须始终保持完整可见', 120, false],
] as const) {
  test(`trailing badge ${childCount} stays visible after short or clipped titles`, async ({
    page,
  }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const audit = await mountFrames(page, {
      narrow: true,
      regionTitle: titleText,
      narrowChildCount: childCount,
    });
    for (const zoom of [0.14, 0.1, 0.07, 0.1, 0.14]) {
      await zoomTo(page, zoom);
      const owner = region(page, 'outer');
      const count = owner.locator('[data-frame-region-count]');
      await expect(count).toHaveText(String(childCount));
      await expect(count).toHaveCSS('font-size', '7px');
      await expect(count).toHaveCSS('height', '10px');
      if (childCount < 10) await expect(count).toHaveCSS('width', '10px');
      const bounds = await owner.evaluate((element) => {
        const title = element.querySelector('[data-frame-region-title]');
        const count = element.querySelector('[data-frame-region-count]');
        const label = element.querySelector('[data-frame-region-label]');
        if (!title || !count || !label)
          throw new Error('Missing trailing count layout');
        const range = document.createRange();
        range.selectNodeContents(count);
        const titleRange = document.createRange();
        titleRange.selectNodeContents(title);
        const lastTitleFragment = [...titleRange.getClientRects()]
          .filter((rect) => rect.width > 0)
          .at(-1);
        if (!lastTitleFragment) throw new Error('Missing title text');
        return {
          title: title.getBoundingClientRect().toJSON(),
          count: count.getBoundingClientRect().toJSON(),
          digits: range.getBoundingClientRect().toJSON(),
          label: label.getBoundingClientRect().toJSON(),
          frame: element.getBoundingClientRect().toJSON(),
          fullTitleHeight: title.scrollHeight,
          lastTitleFragment: lastTitleFragment.toJSON(),
          inline: !!element.querySelector('[data-frame-region-inline]'),
        };
      });
      expect(bounds.count.right).toBeLessThanOrEqual(bounds.label.right + 0.1);
      expect(bounds.count.bottom).toBeLessThanOrEqual(
        bounds.frame.bottom - 8 * zoom + 0.1,
      );
      expect(bounds.digits.left).toBeGreaterThanOrEqual(bounds.count.left);
      expect(bounds.digits.right).toBeLessThanOrEqual(bounds.count.right);
      expect(bounds.digits.bottom).toBeLessThanOrEqual(
        bounds.count.bottom + 0.1,
      );
      if ((childCount === 6 || childCount === 7) && zoom >= 0.1) {
        expect(bounds.inline).toBe(true);
        if (childCount === 7) expect(bounds.title.height).toBeGreaterThan(16);
      }
      if (bounds.inline) {
        expect(
          Math.abs(
            (bounds.count.top + bounds.count.bottom) / 2 -
              (bounds.lastTitleFragment.top + bounds.lastTitleFragment.bottom) /
                2,
          ),
        ).toBeLessThanOrEqual(1);
        expect(bounds.count.left - bounds.lastTitleFragment.right).toBeCloseTo(
          6,
          1,
        );
      } else {
        expect(bounds.count.top).toBeGreaterThanOrEqual(
          bounds.title.bottom - 0.1,
        );
        expect(bounds.count.left).toBeCloseTo(bounds.label.left, 1);
      }
      if (childCount >= 12 && zoom <= 0.1)
        expect(bounds.fullTitleHeight).toBeGreaterThan(bounds.title.height);
      await owner.screenshot({
        path: testInfo.outputPath(`count-${childCount}-${zoom}.png`),
      });
    }
    expect(
      await page.evaluate(() => window.frameZoomFixture.snapshot()),
    ).toEqual(audit.snapshot);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('single-column 440px Frames visibly take over before shrinking below readable bounds', async ({
  page,
}) => {
  const audit = await mountFrames(page, { narrow: true });
  await zoomTo(page, 0.18);
  await expect(region(page, 'outer')).toHaveCount(0);
  for (const zoom of [0.14, 0.13, 0.12, 0.1]) {
    await zoomTo(page, zoom);
    const label = region(page, 'outer').locator('[data-frame-region-label]');
    await expect(label).toBeVisible();
    await expect(label).toHaveCSS('font-size', '11px');
    const availableHeight = await label.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).maxHeight),
    );
    await expect(label.locator('[data-frame-region-title]')).toHaveCSS(
      '-webkit-line-clamp',
      (await label.locator('[data-frame-region-inline]').count()) > 0
        ? 'none'
        : String(Math.floor(availableHeight / 16) - 1),
    );
    await expect(label.locator('[data-frame-region-count]')).toBeVisible();
    await expect(shell(page, 'note')).toHaveCSS('opacity', '1');
    const frameBounds = await shell(page, 'outer').boundingBox();
    const labelBounds = await label.boundingBox();
    if (!frameBounds || !labelBounds)
      throw new Error('Missing region geometry');
    // The title owns the complete centered width.
    expect(labelBounds.width).toBeGreaterThanOrEqual(24);
    expect(labelBounds.y).toBeGreaterThan(frameBounds.y);
    expect(labelBounds.y + labelBounds.height).toBeLessThanOrEqual(
      frameBounds.y + frameBounds.height - 8 * zoom + 0.1,
    );
    expect(labelBounds.x).toBeGreaterThan(frameBounds.x);
    expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(
      frameBounds.x + frameBounds.width - 8 * zoom + 0.1,
    );
  }
  await zoomTo(page, 0.09);
  await expect(region(page, 'outer')).toBeVisible();
  await zoomTo(page, 0.06);
  await expect(region(page, 'outer')).toHaveCount(0);
  await expect(shell(page, 'note')).toHaveCSS('opacity', '1');
  await zoomTo(page, 0.14);
  await expect(region(page, 'outer')).toBeVisible();
  await zoomTo(page, 0.2);
  await expect(region(page, 'outer')).toHaveCount(0);
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    audit.snapshot,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('Frame region replaces mixed child content, retains footprints and edges, and restores with hysteresis', async ({
  page,
}, testInfo) => {
  const audit = await mountFrames(page);
  await zoomTo(page, 0.18);
  await expect(region(page, 'outer')).toHaveCount(0);
  await zoomTo(page, 0.14);
  await expect(region(page, 'outer')).toBeVisible();
  await expect(
    shell(page, 'outer').locator('[data-frame-header]'),
  ).toHaveAttribute('aria-hidden', 'true');
  for (const id of ['note', 'office']) {
    await expect(shell(page, id)).toHaveCSS('opacity', '1');
    await expect(
      shell(page, id).locator('.semantic-lod-content'),
    ).toHaveAttribute('inert', '');
    await expect(shell(page, id).locator('.semantic-lod-content')).toHaveCSS(
      'visibility',
      'hidden',
    );
    await expect(shell(page, id).locator('[data-study-label]')).toHaveCSS(
      'opacity',
      '0',
    );
  }
  await expect(region(page, 'empty')).toHaveCount(0);
  const label = region(page, 'outer').locator('[data-frame-region-label]');
  // Visibility assertions alone miss labels painted underneath opaque shells.
  expect(
    await region(page, 'outer').evaluate((el) => getComputedStyle(el).zIndex),
  ).toBe('21');
  const paintedOnTop = await label.evaluate((el) => {
    const previous = el.style.pointerEvents;
    el.style.pointerEvents = 'auto';
    try {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return hit
        ?.closest('[data-frame-region-owner]')
        ?.getAttribute('data-frame-region-owner');
    } finally {
      el.style.pointerEvents = previous;
    }
  });
  expect(paintedOnTop).toBe('outer');
  await expect(label).toHaveCSS('font-size', '11px');
  await expect(label).toHaveCSS('line-height', '16px');
  await expect(
    region(page, 'outer').locator('[data-frame-region-count]'),
  ).toHaveCount(1);
  const positions = await page.evaluate(() => {
    const frame = document
      .querySelector('#frame-zoom-fixture .react-flow__node[data-id="outer"]')
      ?.getBoundingClientRect();
    const label = document
      .querySelector('#frame-zoom-fixture [data-frame-region-label]')
      ?.getBoundingClientRect();
    if (!frame || !label) throw new Error('Missing label');
    return {
      dx: label.x - frame.x,
      dy: label.y - frame.y,
    };
  });
  expect(positions.dx).toBeGreaterThan(0);
  expect(positions.dy).toBeGreaterThan(0);
  await expect(
    page.locator('#frame-zoom-fixture .react-flow__edge-path'),
  ).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('frame-region.png') });
  await zoomTo(page, 0.19);
  await expect(region(page, 'outer')).toBeVisible();
  await zoomTo(page, 0.2);
  await expect(region(page, 'outer')).toHaveCount(0);
  await expect(shell(page, 'note')).toHaveCSS('opacity', '1');
  await expect(
    shell(page, 'outer').locator('[data-frame-header]'),
  ).toBeVisible();
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    audit.snapshot,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

for (const innerSize of [
  { width: 440, height: 728 },
  { width: 800, height: 600 },
]) {
  test(`nested ${innerSize.width}px Frame hands off without a blank interval`, async ({
    page,
  }) => {
    const audit = await mountFrames(page, { nested: true, innerSize });
    const steps = Array.from({ length: 81 }, (_, i) => (140 - i) / 1000);
    for (const zoom of [...steps, ...steps.toReversed()]) {
      await zoomTo(page, zoom);
      const owners = page.locator(
        '#frame-zoom-fixture [data-frame-region-owner]',
      );
      await expect(owners).toHaveCount(1);
      await expect(owners).toBeVisible();
      const title = owners.locator('[data-frame-region-label]');
      await expect(title).toHaveCSS('font-size', '11px');
      expect(
        await title.evaluate((el) => {
          el.style.pointerEvents = 'auto';
          try {
            const box = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return (
              hit?.closest('[data-frame-region-owner]') ===
              el.closest('[data-frame-region-owner]')
            );
          } finally {
            el.style.pointerEvents = '';
          }
        }),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => window.frameZoomFixture.snapshot()),
    ).toEqual(audit.snapshot);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('visible outer Frame owns nested labels; too-small regions release descendants', async ({
  page,
}) => {
  const audit = await mountFrames(page, { nested: true });
  await zoomTo(page, 0.14);
  await expect(region(page, 'inner')).toBeVisible();
  await expect(region(page, 'outer')).toHaveCount(0);
  await zoomTo(page, 0.1);
  await expect(region(page, 'inner')).toBeVisible();
  await expect(region(page, 'outer')).toHaveCount(0);
  await zoomTo(page, 0.08);
  // The inner Frame no longer fits; the parent replaces it in the same update.
  await expect(region(page, 'inner')).toHaveCount(0);
  await expect(region(page, 'outer')).toBeVisible();
  await expect(shell(page, 'leaf')).toHaveCSS('opacity', '1');
  await zoomTo(page, 0.079);
  await expect(region(page, 'outer')).toBeVisible();
  await expect(region(page, 'inner')).toHaveCount(0);
  await expect(shell(page, 'inner')).toHaveCSS('opacity', '1');
  await expect(shell(page, 'leaf')).toHaveCSS('opacity', '1');
  await zoomTo(page, 0.12);
  await expect(region(page, 'inner')).toBeVisible();
  await expect(region(page, 'outer')).toHaveCount(0);
  await zoomTo(page, 0.03);
  await expect(region(page, 'outer')).toHaveCount(0);
  await expect(region(page, 'inner')).toHaveCount(0);
  await expect(shell(page, 'leaf')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => window.frameZoomFixture.snapshot())).toEqual(
    audit.snapshot,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});
