// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { FAR_ZOOM_DESIGN as FAR } from '../src/components/Nodes/design/farZoomDesign';
import { NODE_TYPOGRAPHY } from '../src/components/Nodes/design/nodeTypography';

import type * as HistoryModule from '../src/store/canvasHistoryManager';
import type * as StoreModule from '../src/store/canvasStore';
import type { Locator, Page } from '@playwright/test';
import type * as FlowModule from '@xyflow/react';
import type { ReactFlowInstance } from '@xyflow/react';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

const TYPES = ['note', 'web', 'pdf', 'office'] as const;
type NodeType = (typeof TYPES)[number];
type FixtureOptions = {
  width?: number;
  height?: number;
  zoom?: number;
  title?: string;
  description?: string;
  cover?: boolean;
  count?: number;
  pdfHeight?: number;
};

declare global {
  interface Window {
    farZoomFixture: {
      rf: ReactFlowInstance;
      doubleClicks: string[];
      readState: () => unknown;
      verifyHistory: () => unknown;
    };
  }
}

// A real one-page PDF keeps reader/thumbnail activation deterministic, without
// persisting a canvas or relying on an external document server.
function tinyPdf(height = 320) {
  const content = 'BT /F1 20 Tf 30 260 Td (Review document text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function mountNodes(page: Page, options: FixtureOptions = {}) {
  const requests: string[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      /\/api\/web\/|far-zoom\.example\.test|\/PDFPreview\.tsx|\/PDFFirstPageThumbnail\.tsx|pdf\.worker/.test(
        request.url(),
      )
    ) {
      requests.push(request.url());
    }
  });
  // Fail closed on mutations, including any accidentally scheduled autosave.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push(`${request.method()} ${request.url()}`);
      await route.fulfill({
        status: 409,
        json: { error: 'Read-only fixture' },
      });
    } else if (new URL(request.url()).pathname === '/api/web/preview') {
      await route.fulfill({
        json: {
          label: options.title ?? 'Web',
          summary: options.description ?? 'Source details remain readable.',
          siteName: 'Far zoom fixture',
          ...(options.cover !== false
            ? {
                image:
                  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320"><rect width="400" height="320" fill="teal"/></svg>',
              }
            : {}),
        },
      });
    } else {
      await route.continue();
    }
  });
  await page.route('https://far-zoom.example.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.pdf')
        ? { contentType: 'application/pdf', body: tinyPdf(options.pdfHeight) }
        : {
            contentType: 'text/html',
            body: '<!doctype html><html><body>Fixture website</body></html>',
          },
    ),
  );
  await page.goto('/playground/design');
  await page.evaluate(async (options) => {
    // Variable paths intentionally use Vite's browser module graph, not the
    // Playwright Node loader. These are production components, not test doubles.
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const storePath = '/src/store/canvasStore.ts';
    const historyPath = '/src/store/canvasHistoryManager.ts';
    const notePath = '/src/components/Nodes/note/NoteNode.tsx';
    const webPath = '/src/components/Nodes/web/WebNode.tsx';
    const pdfPath = '/src/components/Nodes/pdf/PDFNode.tsx';
    const officePath = '/src/components/Nodes/office/OfficeNode.tsx';
    const flowCssPath = '/node_modules/@xyflow/react/dist/style.css';
    await import(flowCssPath);
    const { createElement: h } = (await import(reactPath))
      .default as typeof ReactModule;
    const { createRoot } = (await import(domPath)).default as typeof DomModule;
    const { default: store } = (await import(storePath)) as typeof StoreModule;
    const { canvasHistoryManager: history, createSnapshot } = (await import(
      historyPath
    )) as typeof HistoryModule;
    const { NoteNode } = await import(notePath);
    const { WebNode } = await import(webPath);
    const { PDFNode } = await import(pdfPath);
    const { OfficeNode } = await import(officePath);
    // Vite's versioned module URL must match the node hooks' URL exactly;
    // importing the unversioned dependency creates a second Context singleton.
    const flowPath = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@xyflow_react.js?v='));
    if (!flowPath) throw new Error('Missing production React Flow module URL');
    const { ReactFlow } = (await import(flowPath)) as typeof FlowModule;
    const width = options.width ?? 400;
    const height = options.height ?? 320;
    const nodes = Array.from(
      { length: options.count ?? 4 },
      (_, index) => ['note', 'web', 'pdf', 'office'][index % 4],
    ).map((type, index) => {
      const label =
        options.title ??
        ({ note: 'Note', web: 'Web', pdf: 'PDF', office: 'Office' }[
          type
        ] as string);
      const description =
        options.description ?? 'Source details remain readable.';
      return {
        id: index < 4 ? `far-${type}` : `far-${type}-${index}`,
        type,
        position: {
          x: (index % (options.count ? 8 : 2)) * (width + 40),
          y: Math.floor(index / (options.count ? 8 : 2)) * (height + 40),
        },
        style: { width, height },
        data: {
          label,
          summary: description,
          style: { accent: 'teal' },
          ...(type === 'note'
            ? {
                content: `# ${label}\n\n${description}`,
                heightMode: 'fixed' as const,
              }
            : {
                src: `https://far-zoom.example.test/${type === 'pdf' ? 'document.pdf' : type === 'office' ? 'document.docx' : 'website'}`,
              }),
          ...(type === 'pdf' && options.cover !== false
            ? {
                coverUrl:
                  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320"/>',
              }
            : {}),
          ...(type === 'office' ? { format: 'docx' as const } : {}),
        },
      };
    });
    // Loading suppresses autosave, but leaves the real store actions, geometry
    // measurement, history manager, and React Flow subscriptions intact.
    store.setState({ isLoading: true });
    store.setState({ canvasId: 'e2e-far-zoom-memory-only', nodes, edges: [] });
    history.activate('e2e-far-zoom-memory-only', true);
    const sentinel = nodes.map((node) => ({
      ...node,
      position: { ...node.position, x: node.position.x - 17 },
    }));
    history.takeSnapshot(sentinel, []);
    history.takeSnapshot(nodes, []);
    history.undo(nodes, []);
    const host = document.createElement('div');
    host.id = 'far-zoom-fixture';
    host.className = 'bg-bg-default';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999';
    document.body.append(host);
    function Fixture() {
      const liveNodes = store((state) => state.nodes);
      return h(ReactFlow, {
        nodes: liveNodes,
        edges: [],
        nodeTypes: {
          note: NoteNode,
          web: WebNode,
          pdf: PDFNode,
          office: OfficeNode,
        },
        onNodesChange: store.getState().onNodesChange,
        onNodeDoubleClick: (_event, node) => {
          window.farZoomFixture.doubleClicks.push(node.id);
        },
        defaultViewport: { x: 60, y: 60, zoom: options.zoom ?? 0.24 },
        minZoom: 0.05,
        maxZoom: 5,
        onlyRenderVisibleElements: false,
        onInit: (rf) => {
          window.farZoomFixture = {
            rf,
            doubleClicks: [],
            readState: () => ({
              flow: createSnapshot(rf.getNodes(), rf.getEdges()),
              store: createSnapshot(
                store.getState().nodes,
                store.getState().edges,
              ),
              canUndo: history.canUndo,
              canRedo: history.canRedo,
            }),
            verifyHistory: () => {
              const before = {
                canUndo: history.canUndo,
                canRedo: history.canRedo,
              };
              const undo = history.undo(store.getState().nodes, []);
              const exhausted = !history.canUndo;
              const redo = history.redo(undo?.nodes ?? [], []);
              return {
                before,
                undo: undo ? createSnapshot(undo.nodes, undo.edges) : null,
                redo: redo ? createSnapshot(redo.nodes, redo.edges) : null,
                exhausted,
                sentinel: createSnapshot(sentinel, []),
              };
            },
          };
        },
      });
    }
    createRoot(host).render(h(Fixture));
    await document.fonts.ready;
  }, options);
  await expect(
    page.locator('#far-zoom-fixture .semantic-lod-node'),
  ).toHaveCount(options.count ?? 4);
  await page.waitForFunction(
    () => !!window.farZoomFixture?.rf.viewportInitialized,
  );
  await frames(page);
  return { requests, writes, errors };
}

async function frames(page: Page) {
  // Let ResizeObservers, font probes, and the per-frame hydration queue settle.
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  });
}

test('blank-gap regression: dense Note titles remain visible down to the Frame entry boundary', async ({
  page,
}) => {
  const audit = await mountNodes(page, {
    width: 240,
    height: 180,
    zoom: 0.18,
    title: '研究笔记',
  });
  const note = shell(page, 'note');
  for (const zoom of [0.09, 0.085, 0.08]) {
    await zoomTo(page, zoom, 'note');
    const label = note.locator('[data-study-label]');
    await expect(label).toHaveAttribute('aria-hidden', 'false');
    await expect(label).toHaveCSS('opacity', '1');
    await expect(label.locator('[data-study-title]')).toBeVisible();
    const [labelBox, nodeBox] = await Promise.all([
      label.boundingBox(),
      note.boundingBox(),
    ]);
    if (!labelBox || !nodeBox) throw new Error('Missing label geometry');
    expect(labelBox.width).toBeGreaterThanOrEqual(FAR.labelFont - 0.1);
    expect(labelBox.x).toBeGreaterThanOrEqual(nodeBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
      nodeBox.x + nodeBox.width + 0.1,
    );
  }
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('Note far-zoom labels retain typography and spacing without a divider', async ({
  page,
}) => {
  const audit = await mountNodes(page, { zoom: 0.2, title: 'Review notes' });
  const node = shell(page, 'note');
  const divider = node.locator('[data-far-description-divider]');
  const before = await page.evaluate(() => window.farZoomFixture.readState());
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    for (const zoom of [0.2, 0.24, 0.29]) {
      await zoomTo(page, zoom, 'note');
      await expect(divider).toHaveCount(0);
      const title = node.locator('[data-study-title]');
      const description = node.locator('[data-study-description]');
      await expect(title).toHaveCSS('font-size', `${FAR.labelFont}px`);
      await expect(description).toHaveCSS(
        'font-size',
        `${FAR.descriptionFont}px`,
      );
      const [titleBox, descriptionBox] = await Promise.all([
        title.boundingBox(),
        description.boundingBox(),
      ]);
      if (!titleBox || !descriptionBox)
        throw new Error('Missing thumbnail geometry');
      expect(descriptionBox.y - titleBox.y - titleBox.height).toBeCloseTo(
        FAR.descriptionGap,
        1,
      );
    }
    await test.info().attach(`note-far-label-${theme}`, {
      body: await node.screenshot(),
      contentType: 'image/png',
    });
  }
  for (const type of ['web', 'pdf', 'office'] as const) {
    await expect(
      shell(page, type).locator('[data-far-description-divider]'),
    ).toHaveCount(0);
  }
  await zoomTo(page, 0.3, 'note');
  await expect(divider).toHaveCount(0);
  expect(await page.evaluate(() => window.farZoomFixture.readState())).toEqual(
    before,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('ordinary Note, Web, PDF and Office fonts stay fixed during resize and scale only with the viewport', async ({
  page,
}) => {
  const audit = await mountNodes(page, { width: 400, height: 320, zoom: 0.5 });
  const selectors = {
    note: '.ProseMirror h1',
    web: '.preview-card__title',
    pdf: '.preview-card__title',
    office: '[data-office-content] .text-lg',
  };
  const expected = {
    note: NODE_TYPOGRAPHY.title.size,
    web: NODE_TYPOGRAPHY.cardTitle.size,
    pdf: NODE_TYPOGRAPHY.cardTitle.size,
    office: 18,
  };
  const baseline = new Map<string, number>();
  for (const width of [300, 600, 1000]) {
    await page.evaluate(async (width) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof StoreModule;
      store.setState({
        nodes: store
          .getState()
          .nodes.map((node) => ({ ...node, style: { ...node.style, width } })),
      });
    }, width);
    await frames(page);
    for (const type of TYPES) {
      await zoomTo(page, 0.5, type);
      const node = shell(page, type);
      await expectLayers(node, false);
      const title = node.locator(`.semantic-lod-content ${selectors[type]}`);
      await expect(title).toHaveCSS('font-size', `${expected[type]}px`);
      const textWidth = await title.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      });
      if (!baseline.has(type)) baseline.set(type, textWidth);
      expect(textWidth).toBeCloseTo(baseline.get(type) ?? textWidth, 1);
      if (type === 'web' || type === 'pdf') {
        await expect(node.locator('.preview-card__summary')).toHaveCSS(
          'font-size',
          `${NODE_TYPOGRAPHY.body.size}px`,
        );
        expect(
          await node
            .locator('.preview-card')
            .evaluate((el) =>
              getComputedStyle(el).getPropertyValue('--card-meta').trim(),
            ),
        ).toBe(`${NODE_TYPOGRAPHY.metadata.size}px`);
      }
      if (type === 'office') {
        await expect(node.locator('[data-office-content]')).toHaveCSS(
          'transform',
          'none',
        );
        await expect(node.locator('[data-office-content] p')).toHaveCSS(
          'font-size',
          '16px',
        );
      }
      await zoomTo(page, 0.75, type);
      await expect(title).toHaveCSS('font-size', `${expected[type]}px`);
      const zoomedWidth = await title.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      });
      expect(zoomedWidth / textWidth).toBeCloseTo(1.5, 2);
    }
  }
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

for (const [width, height] of [
  [400, 320],
  [800, 350],
]) {
  test(`media cards retain images and fixed screen glyphs at ${width}x${height}`, async ({
    page,
  }) => {
    const audit = await mountNodes(page, {
      width,
      height,
      zoom: 0.5,
      title: 'Huabu',
    });
    await expect(
      shell(page, 'web').locator('.preview-card__image'),
    ).toBeVisible();
    const before = await page.evaluate(() => window.farZoomFixture.readState());
    for (const type of ['web', 'pdf'] as const) {
      const node = shell(page, type);
      const image = await node.locator('.preview-card__image').elementHandle();
      const orientation = await node
        .locator('.preview-card')
        .getAttribute('data-orientation');
      const widths: number[] = [];
      const tint = await shell(page, 'note').evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      await expect(node.locator('.preview-card')).toHaveCSS(
        'background-color',
        tint,
      );
      await expect(node).toHaveCSS('background-color', tint);
      const noteBorder = await shell(page, 'note').evaluate(
        (el) => getComputedStyle(el).borderColor,
      );
      await expect(node).toHaveCSS('border-color', noteBorder);
      const coverBackground = await node
        .locator('.preview-card__cover')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(coverBackground).not.toBe(tint);
      for (const zoom of [0.24, 0.2, 0.213, 0.231, 0.27, 0.299, 0.24]) {
        await zoomTo(page, zoom, type);
        await expectLayers(node, true);
        const card = node.locator('.preview-card');
        await expect(card).toHaveCSS('background-color', tint);
        await expect(node.locator('.preview-card__cover')).toHaveCSS(
          'background-color',
          coverBackground,
        );
        await expect(card).toHaveAttribute('data-orientation', orientation!);
        await expect(node.locator('.preview-card__image')).toBeVisible();
        expect(
          await node
            .locator('.preview-card__image')
            .evaluate((el, original) => el === original, image),
        ).toBe(true);
        if (type === 'web')
          await expect(node.locator('.preview-card__metadata')).toHaveCount(0);
        const title = node.locator('.preview-card__title');
        await expect(title).toHaveCSS('font-size', `${FAR.labelFont}px`);
        await expect(title).toHaveCSS('line-height', `${FAR.labelLine}px`);
        widths.push(
          await title.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().width;
          }),
        );
        const box = await card.boundingBox();
        expect(box?.width).toBeCloseTo((width - 6) * zoom, 1);
        expect(box?.height).toBeCloseTo((height - 6) * zoom, 1);
      }
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.02);
      await zoomTo(page, 0.3, type);
      await expect(node.locator('.preview-card')).not.toHaveAttribute(
        'data-far',
        'true',
      );
      await expect(node.locator('.preview-card__title')).toHaveCSS(
        'font-size',
        `${NODE_TYPOGRAPHY.cardTitle.size}px`,
      );
      if (type === 'web')
        await expect(node.locator('.preview-card__metadata')).toBeVisible();
    }
    expect(
      await page.evaluate(() => window.farZoomFixture.readState()),
    ).toEqual(before);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('far media cards preserve images and hide summaries behind clipped titles', async ({
  page,
}) => {
  const audit = await mountNodes(page, {
    zoom: 0.5,
    title: 'A detailed research document with many important findings',
    description: 'Secondary information.',
  });
  await expect(
    shell(page, 'web').locator('.preview-card__image'),
  ).toBeVisible();
  for (const type of ['web', 'pdf'] as const) {
    await zoomTo(page, 0.24, type);
    const node = shell(page, type);
    await expect(node.locator('.preview-card__image')).toBeVisible();
    await expect(node.locator('.preview-card__summary')).toBeHidden();
    await expect(node.locator('.preview-card__title')).toBeVisible();
  }
  expect(audit.errors).toEqual([]);
  expect(audit.writes).toEqual([]);
});

test('diagnostic: compare screen-fixed and canvas-fixed far text', async ({
  browser,
}, testInfo) => {
  test.skip(
    process.env.FAR_ZOOM_BENCH !== '1',
    'Opt-in diagnostic, not a timing gate',
  );
  test.setTimeout(240_000);
  const results: unknown[] = [];
  for (const variant of [
    'screen-broad',
    'screen',
    'canvas',
    'canvas',
    'screen',
    'screen-broad',
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    // This isolated fixture needs no WebSocket traffic. Block it, including
    // HMR, so concurrent edits cannot destroy the fixture mid-sample.
    // All API writes remain blocked by mountNodes.
    await page.routeWebSocket('**/*', (socket) => socket.close());
    if (variant === 'screen-broad') {
      // Restore broad viewport subscriptions in hook consumers to isolate
      // subscription cost on the same current app, not an older app snapshot.
      await page.route(
        '**/src/hooks/useNodePresentation.ts*',
        async (route) => {
          const response = await route.fetch();
          if (route.request().url().includes('benchmark-original')) {
            await route.fulfill({ response });
            return;
          }
          await route.fulfill({
            response,
            contentType: 'application/javascript',
            body: `
          import {useViewport} from '/node_modules/.vite/deps/@xyflow_react.js';
          import {useNodePresentation as Original} from '/src/hooks/useNodePresentation.ts?benchmark-original';
          export function useNodePresentation(...args){useViewport();return Original(...args);}
        `,
          });
        },
      );
    }
    if (variant === 'canvas') {
      await page.route(
        '**/src/components/Nodes/semanticZoom/FarZoomLabel.tsx*',
        async (route) => {
          const response = await route.fetch();
          let source = await response.text();
          // Substitute a test-only module; never change the production source.
          const react = '/node_modules/.vite/deps/react.js';
          const labelPath =
            '/src/components/Nodes/semanticZoom/FarZoomLabel.tsx?benchmark-original';
          if (route.request().url().includes('benchmark-original')) {
            await route.fulfill({ response });
            return;
          }
          source =
            variant === 'canvas'
              ? `import React from '${react}'; import {FarZoomLabel as Original} from '${labelPath}';
             const Stable=React.memo(Original);
            export function FarZoomLabel(p){const anchor=.25;return React.createElement(Stable,{...p,zoom:anchor,width:Math.round((p.width+16)/p.zoom)*anchor-16,height:Math.round((p.height+12)/p.zoom)*anchor-12,lines:3});}`
              : `import React from '${react}';
             const Stable=React.memo(function({title,w,h,visible}){const s=Math.sqrt(w*h);const font=s<300?32:s<600?52:76;return React.createElement('div',{'data-benchmark-legacy':'',style:{position:'absolute',inset:0,padding:16,display:'flex',alignItems:'center',justifyContent:'center',opacity:visible?1:0,pointerEvents:'none'}},React.createElement('span',{style:{fontSize:font,lineHeight:1.2,textAlign:'center',overflow:'hidden',display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:Math.max(1,Math.min(6,Math.floor((h-32)/(font*1.2)))),overflowWrap:'break-word'}},title));});
             export function FarZoomLabel(p){return React.createElement(Stable,{title:p.title,w:Math.round((p.width+20)/p.zoom),h:Math.round((p.height+20)/p.zoom),visible:p.visible});}`;
          await route.fulfill({
            response,
            body: source,
            contentType: 'application/javascript',
          });
        },
      );
    }
    const audit = await mountNodes(page, {
      count: 48,
      zoom: 0.32,
      title: 'GenUI research 工作资料',
      description:
        'A useful existing description with several words and 中文内容。',
    });
    await expect(page.locator('#far-zoom-fixture .ProseMirror')).toHaveCount(
      12,
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    for (const phase of ['minimal', 'crossing'] as const) {
      const low = phase === 'minimal' ? 0.16 : 0.2;
      const high = phase === 'minimal' ? 0.24 : 0.34;
      await zoomTo(page, low);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      const before = await cdp.send('Performance.getMetrics');
      const sample = await page.evaluate(
        async ({ low, high }) => {
          const intervals: number[] = [];
          let previous = performance.now();
          for (let i = 0; i < 100; i++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            const now = performance.now();
            intervals.push(now - previous);
            previous = now;
            const t = i < 50 ? i / 49 : (99 - i) / 49;
            void window.farZoomFixture.rf.setViewport(
              { x: 30, y: 30, zoom: low + (high - low) * t },
              { duration: 0 },
            );
          }
          intervals.shift();
          intervals.sort((a, b) => a - b);
          return {
            median: intervals[Math.floor(intervals.length / 2)],
            p95: intervals[Math.floor(intervals.length * 0.95)],
            over25ms: intervals.filter((x) => x > 25).length,
          };
        },
        { low, high },
      );
      const after = await cdp.send('Performance.getMetrics');
      const { profile } = await cdp.send('Profiler.stop');
      const own = profile.nodes
        .filter((n) => n.callFrame.url.includes('/src/'))
        .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
        .slice(0, 8)
        .map((n) => ({
          name: n.callFrame.functionName,
          url: n.callFrame.url.split('/src/')[1],
          samples: n.hitCount,
        }));
      const delta = Object.fromEntries(
        [
          'TaskDuration',
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
          'LayoutCount',
        ].map((name) => [
          name,
          (after.metrics.find((m) => m.name === name)?.value ?? 0) -
            (before.metrics.find((m) => m.name === name)?.value ?? 0),
        ]),
      );
      results.push({ variant, phase, ...sample, ...delta, own });
    }
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
  await testInfo.attach('zoom-comparison.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
});

function shell(page: Page, type: NodeType) {
  return page.locator(
    `#far-zoom-fixture .react-flow__node-${type} .semantic-lod-node`,
  );
}

async function zoomTo(page: Page, zoom: number, focus?: NodeType) {
  await page.evaluate(
    async ({ zoom, focus }) => {
      const { rf } = window.farZoomFixture;
      if (focus) {
        const node = rf.getNode(`far-${focus}`);
        if (!node) throw new Error('Missing focus node');
        await rf.setViewport(
          {
            x: 60 - node.position.x * zoom,
            y: 60 - node.position.y * zoom,
            zoom,
          },
          { duration: 0 },
        );
      } else {
        await rf.zoomTo(zoom, { duration: 0 });
        await rf.setViewport({ x: 60, y: 60, zoom }, { duration: 0 });
      }
    },
    { zoom, focus },
  );
  await frames(page);
}

async function expectLayers(node: Locator, minimal: boolean) {
  const media =
    (await node
      .locator('.preview-card, [data-pdf-reading-surface], iframe')
      .count()) > 0;
  if (media) {
    await expect(node).toHaveAttribute('data-lod', 'full');
    const body = node.locator(':scope > .semantic-lod-content');
    expect(await body.evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await expect(body).toHaveCSS('visibility', 'visible');
    await expect(
      node.locator(':scope > .semantic-lod-placeholder'),
    ).toHaveCount(0);
    if (minimal)
      await expect(node.locator('.preview-card')).toHaveAttribute(
        'data-far',
        'true',
      );
    return;
  }
  await expect(node).toHaveAttribute('data-lod', minimal ? 'minimal' : 'full');
  const body = node.locator(':scope > .semantic-lod-content');
  const placeholder = node.locator(':scope > .semantic-lod-placeholder');
  expect(await body.evaluate((el) => (el as HTMLElement).inert)).toBe(minimal);
  await expect(body).toHaveCSS('opacity', minimal ? '0' : '1');
  await expect(body).toHaveCSS('visibility', minimal ? 'hidden' : 'visible');
  await expect(placeholder).toHaveCSS('opacity', minimal ? '1' : '0');
  await expect(placeholder).toHaveAttribute('aria-hidden', String(!minimal));
  for (const layer of [body, placeholder]) {
    await expect(layer).toHaveCSS('transition-duration', '0s');
    await expect(layer).toHaveCSS('transition-property', 'none');
  }
  if (minimal) await expect(body).toHaveCSS('pointer-events', 'none');
  else expect(await body.getAttribute('aria-hidden')).toBeNull();
}

async function geometry(node: Locator) {
  return node.evaluate((element) => {
    const el = element as HTMLElement;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const body = el.querySelector<HTMLElement>('.semantic-lod-content');
    if (!body) throw new Error('Missing production body');
    return {
      width: el.offsetWidth,
      height: el.offsetHeight,
      screenWidth: rect.width,
      screenHeight: rect.height,
      radius: style.borderRadius,
      border: style.borderWidth,
      borderColor: style.borderColor,
      background: style.backgroundColor,
      innerRadius: getComputedStyle(body).borderRadius,
    };
  });
}

async function labelGeometry(node: Locator) {
  return node.evaluate((element) => {
    const shell = element as HTMLElement;
    const label = shell.querySelector<HTMLElement>('[data-study-label]');
    const title = label?.querySelector<HTMLElement>('[data-study-title]');
    const probe = label?.querySelector<HTMLElement>('[data-title-probe]');
    if (!label || !title || !probe) throw new Error('Missing production label');
    const description = label.querySelector<HTMLElement>(
      '[data-study-description]',
    );
    const shellRect = shell.getBoundingClientRect();
    const scale = shellRect.width / shell.offsetWidth;
    const titleRect = title.getBoundingClientRect();
    const probeRect = probe.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const labelScale = new DOMMatrixReadOnly(getComputedStyle(label).transform)
      .a;
    const typography = (el: HTMLElement) => {
      const css = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        font: parseFloat(css.fontSize) * scale * labelScale,
        line: parseFloat(css.lineHeight) * scale * labelScale,
        height: rect.height,
        width: rect.width,
        clamp: Number(css.webkitLineClamp),
        top: rect.top,
        bottom: rect.bottom,
      };
    };
    return {
      scale,
      title: typography(title),
      probe: typography(probe),
      description: description ? typography(description) : null,
      label: { width: labelRect.width, height: labelRect.height },
      availableHeight: Math.max(0, (shell.offsetHeight - 6) * scale - 12),
      availableWidth: Math.max(0, (shell.offsetWidth - 6) * scale - 16),
      insets: {
        left: labelRect.left - shellRect.left,
        top: labelRect.top - shellRect.top,
        right: shellRect.right - labelRect.right,
        bottom: shellRect.bottom - labelRect.bottom,
      },
      probeWidthDelta: probeRect.width - titleRect.width,
      words: Array.from(
        title.querySelectorAll<HTMLElement>('[data-study-word]'),
        (word) => ({
          width: word.getBoundingClientRect().width,
          height: word.getBoundingClientRect().height,
          overflow: getComputedStyle(word).textOverflow,
          whiteSpace: getComputedStyle(word).whiteSpace,
        }),
      ),
    };
  });
}

async function expectLabelFit(
  node: Locator,
  zoom: number,
  hasDescription = true,
) {
  await expect(node.locator('[data-study-label]')).toHaveCSS('opacity', '1');
  const box = await labelGeometry(node);
  expect(box.scale).toBeCloseTo(zoom, 4);
  expect(box.title.font).toBeCloseTo(FAR.labelFont, 3);
  expect(box.title.line).toBeCloseTo(FAR.labelLine, 3);
  expect(box.probe.font).toBeCloseTo(FAR.labelFont, 3);
  expect(box.probe.line).toBeCloseTo(FAR.labelLine, 3);
  expect(box.probeWidthDelta).toBeCloseTo(0, 2);
  expect(box.probe.height / FAR.labelLine).toBeCloseTo(
    Math.round(box.probe.height / FAR.labelLine),
    2,
  );
  expect(box.title.height).toBeCloseTo(
    Math.min(box.probe.height, box.title.clamp * FAR.labelLine),
    1,
  );
  // Screen-space layout rounds to Chromium's 1/64 CSS-pixel layout unit.
  expect(Math.abs(box.label.width - box.availableWidth)).toBeLessThan(0.02);
  expect(box.label.height).toBeLessThanOrEqual(box.availableHeight + 0.1);
  expect(Math.abs(box.insets.left - (8 + 3 * zoom))).toBeLessThan(0.02);
  expect(box.insets.top).toBeCloseTo(6 + 3 * zoom, 2);
  expect(box.insets.right).toBeGreaterThanOrEqual(8 + 3 * zoom - 0.1);
  expect(box.insets.bottom).toBeGreaterThanOrEqual(6 + 3 * zoom - 0.1);
  for (const word of box.words) {
    expect(word.width).toBeLessThanOrEqual(box.availableWidth + 0.1);
    expect(word.overflow).toBe('clip');
    expect(word.whiteSpace).toBe('normal');
  }
  const lines = Math.max(
    0,
    Math.floor(
      (box.availableHeight - box.title.height - FAR.descriptionGap) /
        FAR.descriptionLine,
    ),
  );
  if (
    hasDescription &&
    lines > 0 &&
    box.probe.height <= box.title.height + 0.1
  ) {
    expect(
      box.description,
      'A fitting description must not be suppressed by an unscaled title probe',
    ).not.toBeNull();
    if (!box.description) throw new Error('Missing fitting description');
    expect(box.description.font).toBeCloseTo(FAR.descriptionFont, 3);
    expect(box.description.line).toBeCloseTo(FAR.descriptionLine, 3);
    expect(box.description.clamp).toBe(lines);
    expect(box.description.top - box.title.bottom).toBeCloseTo(4, 2);
    expect(box.description.height).toBeLessThanOrEqual(
      lines * FAR.descriptionLine + 0.1,
    );
    expect(box.description.height / FAR.descriptionLine).toBeCloseTo(
      Math.round(box.description.height / FAR.descriptionLine),
      2,
    );
  } else {
    expect(box.description).toBeNull();
  }
  return box;
}

test('narrow titles keep colons and spaced dashes with the preceding word', async ({
  page,
}) => {
  const title = 'Jupyter: Operations - Research';
  const audit = await mountNodes(page, {
    title,
    width: 320,
    height: 700,
    zoom: 0.16,
  });
  const node = shell(page, 'note');
  for (const zoom of [0.16, 0.2, 0.24]) {
    await zoomTo(page, zoom);
    const words = node.locator('[data-study-title] [data-study-word]');
    await expect(words).toHaveText(['Jupyter:', 'Operations -', 'Research']);
    const lonePunctuation = await node
      .locator('[data-study-title]')
      .evaluate((el) =>
        [...el.childNodes].some(
          (child) =>
            child.nodeType === Node.TEXT_NODE &&
            /\S/.test(child.textContent ?? ''),
        ),
      );
    expect(lonePunctuation).toBe(false);
    await expectLabelFit(node, zoom);
  }
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('words move intact to the next line and only overwide words break internally', async ({
  page,
}) => {
  const title = 'Go Jupyter: Supercalifragilisticexpialidocious - Research';
  const audit = await mountNodes(page, {
    title,
    // Keep this a wrap-boundary fixture with the current 10px title font.
    width: 320,
    height: 700,
    zoom: 0.2,
  });
  const node = shell(page, 'note');
  const probeWords = node.locator('[data-title-probe] [data-study-word]');
  const fragments = (index: number) =>
    probeWords
      .nth(index)
      .evaluate((el) =>
        [...el.getClientRects()]
          .filter((r) => r.width > 0)
          .map((r) => ({ top: r.top, width: r.width })),
      );
  const first = await fragments(0);
  const ordinary = await fragments(1);
  // Nested punctuation spans can produce multiple fragments on the same line.
  const lineCount = (rects: { top: number }[]) =>
    new Set(rects.map((r) => Math.round(r.top))).size;
  expect(lineCount(ordinary)).toBe(1);
  expect(ordinary[0].top).toBeGreaterThan(first[0].top);
  expect(lineCount(await fragments(2))).toBeGreaterThan(1);
  await zoomTo(page, 0.14);
  expect(lineCount(await fragments(1))).toBeGreaterThan(1);
  const punctuation = node.locator(
    '[data-title-probe] [data-study-punctuation]',
  );
  for (const group of await punctuation.all()) {
    await expect(group).toHaveCSS('white-space', 'nowrap');
    expect(await group.evaluate((el) => el.getClientRects().length)).toBe(1);
  }
  await expect(node.locator('[data-study-title]')).toHaveText(title);
  await expect(node.locator('[data-study-title]')).toHaveCSS(
    '-webkit-line-clamp',
    '6',
  );
  for (const word of await node
    .locator('[data-study-title] [data-study-word]')
    .all()) {
    await expect(word).toHaveCSS('text-overflow', 'clip');
    await expect(word).toHaveCSS('display', 'inline');
  }
  const box = await expectLabelFit(node, 0.14);
  expect(box.probe.height).toBeGreaterThan(box.title.height);
  await test.info().attach('narrow-word-wrapping', {
    body: await node.screenshot(),
    contentType: 'image/png',
  });
  expect(audit.errors).toEqual([]);
  expect(audit.writes).toEqual([]);
});

test('continuous zoom keeps word metrics stable in both directions', async ({
  page,
}) => {
  await mountNodes(page, {
    width: 400,
    height: 700,
    title: 'Huabu',
    zoom: 0.2,
  });
  const node = shell(page, 'note');
  const widths: number[] = [];
  for (const zoom of [
    0.2, 0.202, 0.207, 0.213, 0.221, 0.231, 0.241, 0.231, 0.221, 0.213, 0.207,
    0.202, 0.2,
  ]) {
    await zoomTo(page, zoom);
    await expectLayers(node, true);
    const word = node.locator('[data-study-title] [data-study-word]').first();
    await expect(word).toHaveCSS('font-size', `${FAR.labelFont}px`);
    widths.push(await word.evaluate((el) => el.getBoundingClientRect().width));
    const box = await expectLabelFit(node, zoom);
    expect(box.title.height).toBeCloseTo(FAR.labelLine, 2);
  }
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.02);
});

for (const type of TYPES) {
  test(`${type}: real 400×320 node switches immediately at .24/.5 without geometry or history changes`, async ({
    page,
  }) => {
    const audit = await mountNodes(page);
    const node = shell(page, type);
    await expectLayers(node, true);
    await expect(node).toHaveAttribute('data-presentation', 'minimal');
    const before = await page.evaluate(() => window.farZoomFixture.readState());
    const initial = await geometry(node);
    expect(initial).toMatchObject({
      width: 400,
      height: 320,
      radius: '12px',
      border: '3px',
      innerRadius: '9px',
    });
    expect(initial.screenWidth).toBeCloseTo(96, 3);
    expect(initial.screenHeight).toBeCloseTo(76.8, 3);
    const media = type === 'pdf' || type === 'web';
    if (!media) await expectLabelFit(node, 0.24);
    await expect(
      node.locator(media ? '.preview-card__title' : '[data-study-title]'),
    ).toHaveText(
      type === 'pdf' ? 'PDF' : type[0].toUpperCase() + type.slice(1),
    );
    expect(audit.requests).toEqual([]);

    for (const zoom of [0.5, 0.24, 0.5]) {
      await zoomTo(page, zoom);
      await expectLayers(node, zoom === 0.24);
      await expect(node).toHaveAttribute(
        'data-presentation',
        zoom === 0.24 ? 'minimal' : 'overview',
      );
      const current = await geometry(node);
      expect(current).toEqual({
        ...initial,
        screenWidth: current.screenWidth,
        screenHeight: current.screenHeight,
      });
      expect(current.screenWidth).toBeCloseTo(400 * zoom, 3);
      expect(current.screenHeight).toBeCloseTo(320 * zoom, 3);
      if (zoom === 0.24 && !media) await expectLabelFit(node, zoom);
      else if (type === 'note')
        await expect(node.locator('.ProseMirror')).toBeVisible();
      else if (type === 'office')
        await expect(node.locator('.semantic-lod-content')).toContainText(
          'Word',
        );
      else await expect(node.locator('.preview-card__title')).toBeVisible();
      expect(
        await page.evaluate(() => window.farZoomFixture.readState()),
      ).toEqual(before);
    }
    const history = (await page.evaluate(() =>
      window.farZoomFixture.verifyHistory(),
    )) as {
      before: { canUndo: boolean; canRedo: boolean };
      undo: unknown;
      redo: unknown;
      exhausted: boolean;
      sentinel: unknown;
    };
    expect(history.before).toEqual({ canUndo: true, canRedo: true });
    expect(history.undo).toEqual(history.sentinel);
    expect(history.exhausted).toBe(true);
    expect(history.redo).toEqual((before as { store: unknown }).store);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

for (const [language, title, description] of [
  [
    'English',
    'A deliberately long research title with Supercalifragilisticexpialidocious and more words',
    'Detailed evidence and supporting context. '.repeat(30),
  ],
  [
    'Chinese',
    '这是一个用于验证真实画布缩放时标题换行和内容边界的很长中文标题',
    '补充说明应当只占用标题之后完整可用的行高，不应越过卡片的边界。'.repeat(20),
  ],
] as const) {
  test(`tall narrow ${language} titles and descriptions fit using the rendered zoom probe`, async ({
    page,
  }, testInfo) => {
    const audit = await mountNodes(page, {
      width: 240,
      height: 1000,
      title,
      description,
    });
    for (const zoom of [0.25, 0.27, 0.29, 0.25]) {
      await zoomTo(page, zoom);
      for (const type of ['note', 'office'] as const) {
        const node = shell(page, type);
        await expectLayers(node, true);
        const box = await expectLabelFit(node, zoom);
        expect(box.title.clamp).toBe(
          Math.floor(box.availableHeight / FAR.labelLine),
        );
        expect(box.title.height).toBeGreaterThan(3 * FAR.labelLine);
      }
      if (zoom === 0.27)
        await testInfo.attach(`${language}-35-percent`, {
          body: await page.locator('#far-zoom-fixture').screenshot(),
          contentType: 'image/png',
        });
    }
    expect(audit.requests).toEqual([]);
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('tiny labels hide but all four minimal shells retain their authored footprint', async ({
  page,
}) => {
  const audit = await mountNodes(page);
  const before = await page.evaluate(() => window.farZoomFixture.readState());
  for (const zoom of [0.08, 0.05, 0.25]) {
    await zoomTo(page, zoom);
    for (const type of TYPES) {
      const node = shell(page, type);
      await expectLayers(node, true);
      if (type === 'note' || type === 'office') {
        await expect(node.locator('[data-study-label]')).toHaveAttribute(
          'aria-hidden',
          String(zoom < 0.25),
        );
        await expect(node.locator('[data-study-label]')).toHaveCSS(
          'opacity',
          zoom < 0.25 ? '0' : '1',
        );
      }
      await expect(node).toHaveCSS('opacity', '1');
      const box = await geometry(node);
      expect(box.screenWidth).toBeCloseTo(400 * zoom, 3);
      expect(box.screenHeight).toBeCloseTo(320 * zoom, 3);
      expect(box.border).toBe('3px');
      expect(box.background).not.toBe('rgba(0, 0, 0, 0)');
      if (type === 'web' || type === 'pdf') continue;
      if (zoom < 0.25)
        await expect(node.locator('[data-study-description]')).toHaveCount(0);
      else await expectLabelFit(node, zoom);
    }
    expect(
      await page.evaluate(() => window.farZoomFixture.readState()),
    ).toEqual(before);
  }
  expect(audit.requests).toEqual([]);
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('embedded PDF double-click selects a word without activating the node; overview still activates', async ({
  page,
}) => {
  const audit = await mountNodes(page, { width: 700, height: 500, zoom: 1 });
  await zoomTo(page, 1, 'pdf');
  const pdf = shell(page, 'pdf');
  await pdf.click({ position: { x: 300, y: 200 } });
  const reader = pdf.locator('[data-pdf-reader="embedded"]');
  await expect(reader).not.toHaveAttribute('inert');
  const text = reader
    .locator('.react-pdf__Page__textContent span')
    .filter({ hasText: 'Review document text' });
  await expect(text).toBeVisible();
  const word = await text.evaluate((element) => {
    const range = document.createRange();
    if (!element.firstChild) throw new Error('Missing PDF text');
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 'Review'.length);
    const bounds = range.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.dblclick(word.x, word.y);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('Review');
  expect(await page.evaluate(() => window.farZoomFixture.doubleClicks)).toEqual(
    [],
  );

  await zoomTo(page, 0.5, 'pdf');
  await expect(pdf).toHaveAttribute('data-presentation', 'overview');
  await pdf.locator('.preview-card__title').dblclick();
  expect(await page.evaluate(() => window.farZoomFixture.doubleClicks)).toEqual(
    ['far-pdf'],
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('embedded PDF keyboard navigation scrolls the focused viewport without moving the node', async ({
  page,
}) => {
  await page.routeWebSocket('**', (socket) => socket.close());
  const audit = await mountNodes(page, {
    width: 700,
    height: 500,
    zoom: 1,
    pdfHeight: 1600,
  });
  await zoomTo(page, 1, 'pdf');
  const pdf = shell(page, 'pdf');
  await pdf.click({ position: { x: 300, y: 200 } });
  const reader = pdf.locator('[data-pdf-reader="embedded"]');
  const viewport = reader.locator('[data-pdf-scroll-viewport]');
  await expect(reader).not.toHaveAttribute('inert');
  await expect(reader.locator('.react-pdf__Page canvas')).toBeVisible();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(100);
  await viewport.focus();
  await expect(viewport).toBeFocused();
  const before = await page.evaluate(() => window.farZoomFixture.readState());
  const camera = await page.evaluate(() =>
    window.farZoomFixture.rf.getViewport(),
  );
  const initialScroll = await viewport.evaluate((el) => el.scrollTop);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(initialScroll);
  await frames(page);
  await expect(viewport).toBeFocused();
  expect(await page.evaluate(() => window.farZoomFixture.readState())).toEqual(
    before,
  );
  expect(
    await page.evaluate(() => window.farZoomFixture.rf.getViewport()),
  ).toEqual(camera);
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

test('minimal mount skips Web preview and uncached PDF work; Office never becomes a reader', async ({
  page,
}) => {
  const audit = await mountNodes(page, { cover: false });
  for (const type of TYPES) await expectLayers(shell(page, type), true);
  await expect(
    page.locator(
      '#far-zoom-fixture iframe, #far-zoom-fixture [data-pdf-reading-surface], #far-zoom-fixture .react-pdf__Document',
    ),
  ).toHaveCount(0);
  expect(audit.requests).toEqual([]);
  await zoomTo(page, 0.5);
  await expect
    .poll(() => audit.requests.some((url) => url.includes('/api/web/preview')))
    .toBe(true);
  await expect
    .poll(() => audit.requests.some((url) => url.endsWith('/document.pdf')))
    .toBe(true);
  await expect(
    shell(page, 'pdf').locator('.preview-card__image'),
  ).toBeVisible();
  await zoomTo(page, 0.24);
  const requestCount = audit.requests.length;
  await zoomTo(page, 0.2);
  expect(audit.requests).toHaveLength(requestCount);
  for (const zoom of [2, 5, 0.24]) {
    await zoomTo(page, zoom, 'office');
    const node = shell(page, 'office');
    await expectLayers(node, zoom === 0.24);
    await expect(node).toHaveAttribute(
      'data-presentation',
      zoom === 0.24 ? 'minimal' : 'overview',
    );
    await expect(
      node.locator('iframe, [data-pdf-reading-surface]'),
    ).toHaveCount(0);
    if (zoom > 1)
      await expect(node.locator('.semantic-lod-content')).toContainText('Word');
  }
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});

for (const [width, height] of [
  [200, 160],
  [1000, 200],
  [2000, 1600],
]) {
  test(`all four types use 25/30 percent hysteresis at ${width}x${height}`, async ({
    page,
  }) => {
    const audit = await mountNodes(page, {
      width,
      height,
      zoom: 0.25,
    });
    for (const [zoom, minimal] of [
      [0.25, false],
      [0.249, true],
      [0.25, true],
      [0.299, true],
      [0.3, false],
      [0.27, false],
      [0.24, true],
    ] as const) {
      await zoomTo(page, zoom);
      for (const type of TYPES) await expectLayers(shell(page, type), minimal);
    }
    expect(audit.writes).toEqual([]);
    expect(audit.errors).toEqual([]);
  });
}

test('shallow far Notes sacrifice vertical whitespace before hiding their title', async ({
  page,
}) => {
  const audit = await mountNodes(page, {
    width: 320,
    height: 86,
    zoom: 0.24,
    title: 'Short title',
  });
  const before = await page.evaluate(() => window.farZoomFixture.readState());
  for (const [zoom, minimal] of [
    [0.24, true],
    [0.2, true],
    [0.19, true],
    [0.2, true],
    [0.29, true],
    [0.3, false],
    [0.27, false],
    [0.24, true],
  ] as const) {
    await zoomTo(page, zoom);
    const node = shell(page, 'note');
    await expectLayers(node, minimal);
    if (minimal) {
      const visible = 80 * zoom >= FAR.labelLine;
      await expect(node.locator('[data-study-label]')).toHaveAttribute(
        'aria-hidden',
        String(!visible),
      );
      if (visible) {
        const box = await labelGeometry(node);
        const inset = Math.min(6, (80 * zoom - FAR.labelLine) / 2);
        expect(box.insets.top).toBeCloseTo(inset + 3 * zoom, 2);
        expect(box.title.height).toBeCloseTo(FAR.labelLine, 2);
        expect(box.title.font).toBeCloseTo(FAR.labelFont, 2);
        expect(box.insets.bottom).toBeGreaterThanOrEqual(3 * zoom - 0.1);
        expect(box.description).toBeNull();
      }
    }
  }
  expect(await page.evaluate(() => window.farZoomFixture.readState())).toEqual(
    before,
  );
  expect(audit.writes).toEqual([]);
  expect(audit.errors).toEqual([]);
});
