// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { oneFingerDrag } from './helpers';

import type * as StoreModule from '../src/store/canvasStore';
import type * as PreviewModule from '../src/store/previewWorkspace/store';
import type * as FlowModule from '@xyflow/react';
import type * as ReactModule from 'react';
import type * as DomModule from 'react-dom/client';

declare global {
  interface Window {
    videoFixture: {
      rf: FlowModule.ReactFlowInstance;
      select: (selected: boolean, multiple?: boolean) => void;
      replaceSource: () => void;
      preview: () => void;
      readGeometry: () => unknown;
    };
    removedVideo?: HTMLVideoElement;
  }
}

async function mountVideo(page: Page) {
  await page.routeWebSocket('**', (socket) => socket.close());
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      writes.push(route.request().url());
      await route.fulfill({
        status: 409,
        json: { error: 'Read-only video fixture' },
      });
    } else await route.continue();
  });
  await page.goto('/playground/design');
  await page.evaluate(async () => {
    // Generate a real playable local WebM, independent of codecs in checked-in assets or remote hosts.
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas recording context');
    context.fillStyle = 'teal';
    context.fillRect(0, 0, 320, 180);
    const poster = canvas.toDataURL('image/png');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const recorded = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start();
    const paint = setInterval(() => context.fillRect(0, 0, 320, 180), 80);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    recorder.stop();
    const source = URL.createObjectURL(await recorded);
    clearInterval(paint);
    stream.getTracks().forEach((track) => track.stop());

    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const storePath = '/src/store/canvasStore.ts';
    const previewPath = '/src/store/previewWorkspace/store.ts';
    const videoPath = '/src/components/Nodes/video/VideoNode.tsx';
    const previewComponentPath = '/src/components/Nodes/video/VideoPreview.tsx';
    const gesturesPath = '/src/hooks/useCanvasGestures.ts';
    const shortcutsPath = '/src/hooks/shortcuts/useCanvasShortcuts.ts';
    const routerPath = '/src/hooks/useCanvasPointerRouter.ts';
    const cssPath = '/node_modules/@xyflow/react/dist/style.css';
    await import(cssPath);
    const React = (await import(reactPath)).default as typeof ReactModule;
    const { createElement: h, useRef } = React;
    const { createRoot } = (await import(domPath)).default as typeof DomModule;
    const { default: store } = (await import(storePath)) as typeof StoreModule;
    const { usePreviewWorkspaceStore: preview } = (await import(
      previewPath
    )) as typeof PreviewModule;
    const { VideoNode } = await import(videoPath);
    const { VideoPreview } = await import(previewComponentPath);
    const { useCanvasGestures } = await import(gesturesPath);
    const { useCanvasShortcuts } = await import(shortcutsPath);
    const { useCanvasPointerRouter } = await import(routerPath);
    const flowPath = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/@xyflow_react.js?v='));
    if (!flowPath) throw new Error('Missing React Flow context');
    const { ReactFlow } = (await import(flowPath)) as typeof FlowModule;
    const nodes = [
      {
        id: 'movie',
        type: 'video',
        position: { x: 80, y: 80 },
        style: { width: 400, height: 225 },
        data: {
          src: source,
          coverUrl: poster,
          coverSourceSrc: source,
          label: 'Local movie',
        },
      },
      {
        id: 'other',
        type: 'video',
        position: { x: 520, y: 80 },
        style: { width: 200, height: 112 },
        data: { label: 'Other', src: '' },
      },
    ];
    // Autosave checks the previous state, so establish the load barrier first.
    store.setState({ isLoading: true });
    store.setState({
      canvasId: 'video-fixture',
      nodes,
      edges: [],
    });
    preview.setState({ canvasId: 'video-fixture' });
    const host = document.createElement('div');
    host.id = 'video-fixture';
    host.setAttribute('data-canvas-root', '');
    host.className = 'bg-bg-default';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999';
    document.body.append(host);
    const rfRef: ReactModule.MutableRefObject<FlowModule.ReactFlowInstance | null> =
      { current: null };
    function Interactions() {
      const wrapperRef = useRef(host);
      const mousePositionRef = useRef({ x: 0, y: 0 });
      useCanvasGestures(wrapperRef, rfRef);
      useCanvasShortcuts({ rfInstanceRef: rfRef, mousePositionRef });
      useCanvasPointerRouter(wrapperRef, rfRef, {
        inputMode: 'pen',
        interactivityLocked: false,
        explicitToolActive: false,
        onTouchTakeover: () => {},
        onEmptyCanvasTap: () => {},
        onNodeTap: () => {},
      });
      return null;
    }
    function Fixture() {
      const live = store((s) => s.nodes);
      return h(
        ReactFlow,
        {
          nodes: live,
          edges: [],
          nodeTypes: { video: VideoNode },
          onNodesChange: store.getState().onNodesChange,
          defaultViewport: { x: 40, y: 40, zoom: 0.5 },
          minZoom: 0.05,
          maxZoom: 5,
          onlyRenderVisibleElements: false,
          onInit: (rf: FlowModule.ReactFlowInstance) => {
            rfRef.current = rf;
            window.videoFixture = {
              rf,
              select: (selected, multiple = false) =>
                store.setState((s) => ({
                  nodes: s.nodes.map((node) => ({
                    ...node,
                    selected: node.id === 'movie' ? selected : multiple,
                  })),
                })),
              replaceSource: () =>
                store.setState((s) => ({
                  nodes: s.nodes.map((node) =>
                    node.id === 'movie'
                      ? {
                          ...node,
                          data: { ...node.data, src: `${source}#replacement` },
                        }
                      : node,
                  ),
                })),
              preview: () => {
                preview.getState().openPreviewTarget({
                  kind: 'node',
                  canvasId: 'video-fixture',
                  nodeId: 'movie',
                });
                const previewHost = document.createElement('div');
                previewHost.id = 'video-preview-fixture';
                previewHost.style.cssText =
                  'position:fixed;right:0;top:0;width:400px;height:300px;z-index:100000';
                document.body.append(previewHost);
                createRoot(previewHost).render(
                  h(VideoPreview, {
                    id: 'movie',
                    data: store.getState().nodes[0].data,
                  }),
                );
              },
              readGeometry: () =>
                store.getState().nodes.map(({ id, position, style }) => ({
                  id,
                  position,
                  style,
                })),
            };
          },
        },
        h(Interactions),
      );
    }
    createRoot(host).render(h(Fixture));
  });
  await expect(
    page.locator('#video-fixture .react-flow__node-video'),
  ).toHaveCount(2);
  return { errors, writes };
}

test('local inline video plays below reader size, isolates controls and pauses across presentation changes', async ({
  page,
}) => {
  const { errors, writes } = await mountVideo(page);
  const node = page.locator(
    '#video-fixture .react-flow__node[data-id="movie"]',
  );
  const video = node.locator('video');
  const poster = node.locator('img');
  const play = node.getByRole('button', { name: 'Play video', exact: true });
  await expect(poster).toBeVisible();
  await expect(video).toHaveCount(0);
  for (const zoom of [1, 0.5, 0.3]) {
    await page.evaluate((nextZoom) => {
      void window.videoFixture.rf.setViewport({ x: 40, y: 40, zoom: nextZoom });
    }, zoom);
    await expect
      .poll(() => play.evaluate((el) => el.getBoundingClientRect().width))
      .toBeCloseTo(48 * zoom, 0);
    await expect
      .poll(() => play.evaluate((el) => el.getBoundingClientRect().height))
      .toBeCloseTo(48 * zoom, 0);
  }
  await page.evaluate(() =>
    window.videoFixture.rf.setViewport({ x: 40, y: 40, zoom: 0.5 }),
  );
  const geometry = await page.evaluate(() =>
    window.videoFixture.readGeometry(),
  );
  await node.click({ position: { x: 20, y: 20 } });
  await expect(video).toHaveCount(0);
  await play.click();
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
  expect(
    await video.evaluate((el) => ({
      autoplay: el.autoplay,
      paused: el.paused,
      controls: el.controls,
      screenWidth: el.getBoundingClientRect().width,
      cssWidth: el.clientWidth,
    })),
  ).toMatchObject({
    autoplay: false,
    paused: false,
    controls: true,
    cssWidth: 200,
    screenWidth: 200,
  });
  const viewport = await page.evaluate(() =>
    window.videoFixture.rf.getViewport(),
  );
  await video.hover();
  await page.mouse.wheel(0, 80);
  await video.dispatchEvent('wheel', {
    ctrlKey: true,
    deltaY: -80,
    bubbles: true,
    cancelable: true,
  });
  await video.dblclick({ position: { x: 100, y: 40 } });
  const bounds = await video.boundingBox();
  if (!bounds) throw new Error('Missing video control bounds');
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 70, bounds.y + 50, { steps: 5 });
  await page.mouse.up();
  const cdp = await page.context().newCDPSession(page);
  await oneFingerDrag(cdp, { x: bounds.x + 40, y: bounds.y + 40 }, 30, 10);
  await cdp.detach();
  expect(
    await page.evaluate(() => window.videoFixture.rf.getViewport()),
  ).toEqual(viewport);
  expect(await page.evaluate(() => window.videoFixture.readGeometry())).toEqual(
    geometry,
  );

  // Controls retain keyboard ownership after the explicit application Play click.
  await video.focus();
  await page.keyboard.press('Backspace');
  await expect(node).toHaveCount(1);
  await video.evaluate((el) => {
    window.removedVideo = el;
  });
  await page.evaluate(() => window.videoFixture.select(false));
  await expect(video).toHaveCount(0);
  expect(await page.evaluate(() => window.removedVideo?.paused)).toBe(true);
  await page.evaluate(() => window.videoFixture.select(true));
  await expect(video).toHaveCount(0);
  await expect(play).toBeVisible();

  for (const reason of ['multi', 'far', 'offscreen'] as const) {
    await play.click();
    await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
    await video.evaluate((el) => {
      window.removedVideo = el;
    });
    await page.evaluate((reason) => {
      if (reason === 'multi') window.videoFixture.select(true, true);
      if (reason === 'far')
        void window.videoFixture.rf.setViewport({ x: 40, y: 40, zoom: 0.24 });
      if (reason === 'offscreen')
        void window.videoFixture.rf.setViewport({ x: -5000, y: 40, zoom: 0.5 });
    }, reason);
    await expect(video).toHaveCount(0);
    expect(await page.evaluate(() => window.removedVideo?.paused)).toBe(true);
    if (reason === 'far') {
      await expect(poster).toBeVisible();
      await expect(node.locator('[data-presentation]')).toHaveAttribute(
        'data-presentation',
        'minimal',
      );
      await expect(node.locator('.semantic-lod-placeholder')).toHaveCount(0);
      await expect(node.locator('[data-lod]')).toHaveAttribute(
        'data-lod',
        'full',
      );
    }
    await page.evaluate(() => {
      window.videoFixture.select(true);
      void window.videoFixture.rf.setViewport({ x: 40, y: 40, zoom: 0.5 });
    });
    await expect(video).toHaveCount(0);
    await expect(play).toBeVisible();
  }
  await play.click();
  await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
  await video.evaluate((el) => {
    window.removedVideo = el;
  });
  await page.evaluate(() => window.videoFixture.preview());
  await expect(video).toHaveCount(0);
  expect(await page.evaluate(() => window.removedVideo?.paused)).toBe(true);
  const expanded = page.locator('#video-preview-fixture video');
  await expect(expanded).toBeVisible();
  expect(
    await expanded.evaluate(
      (el) =>
        el.paused && !el.autoplay && el.poster.startsWith('data:image/png'),
    ),
  ).toBe(true);
  await page.evaluate(() => window.videoFixture.replaceSource());
  await expect(poster).toHaveCount(0);
  expect(await page.evaluate(() => window.videoFixture.readGeometry())).toEqual(
    geometry,
  );
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
