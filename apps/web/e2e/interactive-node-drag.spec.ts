// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { oneFingerDrag, readViewportTransform } from './helpers';

import type {
  CreateCanvasResponse,
  GetCanvasResponse,
  NodeData,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

// Real Canvas, storage, drag callbacks and pointer router; only remote documents
// are served locally. Never inject a store or replace production components.
function tallPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 1600] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('Expected visible node/control');
  return rect;
}

type FixtureType =
  | 'video'
  | 'web'
  | 'pdf'
  | 'text'
  | 'note'
  | 'image'
  | 'office'
  | 'question'
  | 'sketch'
  | 'frame'
  | 'spacePreview';

async function seed(
  page: Page,
  type: FixtureType,
  zoom: number,
  { missingSource = false, emptyLabel = false, labelText = '' } = {},
) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('https://node-drag.example.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.svg')
        ? {
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="teal"/></svg>',
          }
        : route.request().url().endsWith('.pdf')
          ? { contentType: 'application/pdf', body: tallPdf() }
          : {
              contentType: 'text/html',
              body: '<!doctype html><html><body style="margin:0;font:18px sans-serif"><header style="padding:20px;background:lightcyan">Original website header</header><button onclick="this.textContent=\'Clicked\'">Website control</button><p style="height:2000px">Scrollable original website</p></body></html>',
            },
    ),
  );
  await page.route('**/api/web/preview?**', (route) =>
    route.fulfill({
      json: { label: 'Website', summary: 'Original interactive website' },
    }),
  );
  const created = await page.request.post('/api/canvas', {
    data: { title: `Interactive ${type} drag` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  let src = `https://node-drag.example.test/${type === 'pdf' ? 'document.pdf' : 'website'}`;
  if (type === 'video' && !missingSource) {
    await page.goto('/');
    // Reuse the native MediaRecorder approach from video-inline; no fake player.
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing recording context');
      context.fillStyle = 'teal';
      context.fillRect(0, 0, 320, 180);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const recorded = new Promise<Blob>((resolve) => {
        recorder.onstop = () =>
          resolve(new Blob(chunks, { type: 'video/webm' }));
      });
      recorder.start();
      const paint = setInterval(() => context.fillRect(0, 0, 320, 180), 80);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      recorder.stop();
      const result = Array.from(
        new Uint8Array(await (await recorded).arrayBuffer()),
      );
      clearInterval(paint);
      stream.getTracks().forEach((track) => track.stop());
      return result;
    });
    const upload = await page.request.post(
      `/api/canvas/${canvasId}/artifact/video`,
      {
        multipart: {
          file: {
            name: 'drag.webm',
            mimeType: 'video/webm',
            buffer: Buffer.from(bytes),
          },
        },
      },
    );
    expect(upload.ok(), await upload.text()).toBe(true);
    src = (await upload.json()).uri;
  }
  const isReader = type === 'video' || type === 'web' || type === 'pdf';
  const size = isReader
    ? {
        width: 600 / zoom,
        height: (type === 'video' ? 337.5 : 380) / zoom,
      }
    : { width: 400, height: 240 };
  const label = emptyLabel ? '' : labelText || `Interactive ${type}`;
  // The headless Canvas executor accepts user-created types too, unlike the
  // agent tool's narrower schema. Use actual required data, not renderer mocks.
  let data: NodeData;
  switch (type) {
    case 'text':
    case 'note':
    case 'question':
      data = { type, label, content: 'Toolbar drag preserves this content.' };
      break;
    case 'frame':
      data = { type, label, layoutMode: 'free', sizing: 'manual' };
      break;
    case 'sketch':
      data = {
        type,
        label,
        initialSize: size,
        strokes: [
          {
            id: 'stroke-toolbar-drag',
            points: [
              [20, 20, 0.5],
              [180, 100, 0.5],
              [360, 220, 0.5],
            ],
            color: 'teal',
            size: 8,
            createdAt: 1,
          },
        ],
      };
      break;
    case 'spacePreview': {
      const target = await page.request.post('/api/canvas', {
        data: { title: 'Toolbar drag preview target' },
      });
      expect(target.ok(), await target.text()).toBe(true);
      const { canvasId: targetCanvasId } =
        (await target.json()) as CreateCanvasResponse;
      data = { type, label, targetCanvasId };
      break;
    }
    case 'office':
      data = { type, label, src: '', format: 'docx' };
      break;
    case 'image':
      data = {
        type,
        label,
        src: missingSource ? '' : 'https://node-drag.example.test/image.svg',
      };
      break;
    default:
      data = { type, label, src: missingSource ? '' : src };
  }
  const inserted = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: type,
              data,
              selectOnCreate: false,
              position: { x: 80 / zoom, y: 140 / zoom },
              size,
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-interactive-node-drag' },
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  if (emptyLabel) {
    // Creation supplies a fallback label; model a legacy empty-label load to
    // exercise the production backfill/ingestion lifecycle without store writes.
    await page.route(`**/api/canvas/${canvasId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const record = await response.json();
      for (const node of record.state.nodes) node.data.label = '';
      await route.fulfill({ response, json: record });
    });
  }
  await page.addInitScript(
    ({ canvasId, zoom }) => {
      if (window !== window.top) return;
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 120, y: 40, zoom }),
      );
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({ state: { inputModePreference: 'pen' }, version: 0 }),
      );
    },
    { canvasId, zoom },
  );
  await page.goto(`/canvas/${canvasId}`);
  const node = page.locator(`.react-flow__node-${type}`);
  await expect(node).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.click(1100, 650);
  await expect(node).not.toHaveClass(/selected/);
  async function persisted() {
    const response = await page.request.get(`/api/canvas/${canvasId}`);
    expect(response.ok(), await response.text()).toBe(true);
    const record = (await response.json()) as GetCanvasResponse;
    return (record.state as { nodes: Node[] }).nodes[0];
  }
  return { node, persisted, canvasId };
}

for (const type of ['web', 'pdf', 'question'] as const) {
  for (const zoom of type === 'question' ? [0.15, 0.2] : [1, 2]) {
    test(`${type} connection boundary keeps visible ports hittable at ${zoom} zoom`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60_000);
      await page.routeWebSocket('**', (socket) => socket.close());
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { node } = await seed(page, type, zoom, {
        labelText:
          type === 'question'
            ? 'Compare the evidence and explain the differences. '.repeat(15)
            : '',
      });
      await node.click({ position: { x: 15, y: 15 } });
      await expect(node).toHaveClass(/selected/);
      const id = await node.getAttribute('data-id');
      const boundary =
        type === 'question'
          ? page.locator(
              `[data-takeover-node="${id}"] [data-question-takeover-mark]`,
            )
          : node.locator('[data-node-surface]');
      await expect(boundary).toBeVisible();
      if (type !== 'question') {
        await expect(boundary).toHaveAttribute('data-presentation', 'reading');
        await expect(boundary).toHaveCSS('border-top-width', '0px');
      } else {
        await expect(page.locator(`[data-takeover-node="${id}"]`)).toHaveCSS(
          'opacity',
          '1',
        );
      }
      await page.mouse.move(1100, 700);
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const dot = page.locator(`[data-connection-port-dot="${id}:${side}"]`);
        await expect(dot).toBeVisible();
        await expect
          .poll(async () => {
            const rect = await box(boundary);
            const anchor = await node
              .locator(`[data-handleid="${side}-source"]`)
              .evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return {
                  x: bounds.x + bounds.width / 2,
                  y: bounds.y + bounds.height / 2,
                };
              });
            const expected = {
              x:
                side === 'left'
                  ? rect.x
                  : side === 'right'
                    ? rect.x + rect.width
                    : rect.x + rect.width / 2,
              y:
                side === 'top'
                  ? rect.y
                  : side === 'bottom'
                    ? rect.y + rect.height
                    : rect.y + rect.height / 2,
            };
            return Math.max(
              Math.abs(anchor.x - expected.x),
              Math.abs(anchor.y - expected.y),
            );
          })
          .toBeLessThan(1);
        expect(
          await dot.evaluate((element, side) => {
            const rect = element.getBoundingClientRect();
            return (
              document
                .elementFromPoint(
                  rect.x + rect.width / 2,
                  rect.y + rect.height / 2,
                )
                ?.closest('[data-handleid]')
                ?.getAttribute('data-handleid') === `${side}-source`
            );
          }, side),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`${type}-${zoom}-ports.png`),
      });
      const rightDot = await box(
        page.locator(`[data-connection-port-dot="${id}:right"]`),
      );
      await page.mouse.click(
        rightDot.x + rightDot.width / 2,
        rightDot.y + rightDot.height / 2,
      );
      await expect(
        page
          .getByRole('group', { name: 'Create connected node', exact: true })
          .getByRole('button', { name: 'New note', exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

for (const type of ['web', 'pdf'] as const) {
  for (const zoom of [0.5, 1]) {
    test(`${type} native-content grip moves the real Canvas node at ${zoom} zoom`, async ({
      page,
      baseURL,
    }, testInfo) => {
      test.setTimeout(90_000);
      expect(new URL(baseURL ?? '').port).toBe(
        process.env.E2E_WEB_PORT ?? '5273',
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // Other agents edit this worktree concurrently; Vite HMR must not replace
      // a gesture's document. Production canvas synchronization uses SSE.
      await page.routeWebSocket('**', (socket) => socket.close());
      const { node, persisted, canvasId } = await seed(page, type, zoom);
      const grip = page.locator(
        '.node-floating-toolbar [data-node-drag-handle]',
      );
      await expect(grip).toHaveCount(0);
      await node.click({ position: { x: 80, y: 80 } });
      await expect(node).toHaveClass(/selected/);
      await expect(grip).toBeVisible();
      await expect(grip).toHaveAttribute(
        'aria-label',
        `${type} · Drag to move`,
      );
      await expect(grip).toHaveJSProperty('tagName', 'BUTTON');
      await expect(grip.locator('svg')).toHaveCount(1);
      await expect(
        page.locator('.node-floating-toolbar .lucide-grip-vertical'),
      ).toHaveCount(0);
      const initial = await persisted();
      const viewport = await readViewportTransform(page);
      const gripBox = await box(grip);
      expect(gripBox.width).toBeCloseTo(28, 0);
      await expect(node.locator('[data-node-drag-handle]')).toHaveCount(0);
      expect(
        await grip.evaluate((el) => ({
          toolbar: !!el.closest('.node-floating-toolbar'),
          hit:
            document.elementFromPoint(
              el.getBoundingClientRect().x + 14,
              el.getBoundingClientRect().y + 14,
            ) === el,
        })),
      ).toEqual({ toolbar: true, hit: true });

      // Native content must still own its controls, dragging, and wheel events.
      if (type === 'web') {
        const iframe = node.locator('iframe');
        const button = iframe
          .contentFrame()
          .getByRole('button', { name: 'Website control' });
        await button.click();
        await expect(
          iframe.contentFrame().getByRole('button', { name: 'Clicked' }),
        ).toBeVisible();
        await iframe.hover();
        await page.mouse.wheel(0, 120);
        await expect
          .poll(() =>
            iframe
              .contentFrame()
              .locator('body')
              .evaluate(() => scrollY),
          )
          .toBeGreaterThan(0);
      } else {
        const reader = node.locator('[data-pdf-scroll-viewport]');
        await expect(
          node.locator('.react-pdf__Page canvas').first(),
        ).toBeVisible();
        await reader.hover();
        await page.mouse.wheel(0, 160);
        await expect
          .poll(() => reader.evaluate((el) => el.scrollTop))
          .toBeGreaterThan(0);
      }
      const body = await box(node);
      await page.mouse.move(body.x + 110, body.y + 100);
      await page.mouse.down();
      await page.mouse.move(body.x + 145, body.y + 125, { steps: 8 });
      await page.mouse.up();
      expect(await box(node)).toEqual(body);
      expect((await persisted()).position).toEqual(initial.position);
      expect(await readViewportTransform(page)).toBe(viewport);

      for (const pointer of zoom === 0.5
        ? (['mouse', 'touch', 'pen'] as const)
        : (['mouse'] as const)) {
        const before = await persisted();
        const startBox = await box(node);
        const control = await box(grip);
        const start = {
          x: control.x + control.width / 2,
          y: control.y + control.height / 2,
        };
        const identity = await grip.elementHandle();
        if (pointer === 'mouse') {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x + 60, start.y + 35, { steps: 10 });
          await expect(grip).toBeVisible();
          expect(await identity?.evaluate((el) => el.isConnected)).toBe(true);
          await page.mouse.up();
        } else {
          const cdp = await page.context().newCDPSession(page);
          if (pointer === 'touch') await oneFingerDrag(cdp, start, 60, 35);
          else {
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: start.x,
              y: start.y,
              button: 'left',
              buttons: 1,
              clickCount: 1,
              pointerType: 'pen',
            });
            for (let i = 1; i <= 10; i++)
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: start.x + 6 * i,
                y: start.y + 3.5 * i,
                button: 'left',
                buttons: 1,
                pointerType: 'pen',
              });
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: start.x + 60,
              y: start.y + 35,
              button: 'left',
              buttons: 0,
              clickCount: 1,
              pointerType: 'pen',
            });
          }
          await cdp.detach();
        }
        await expect
          .poll(async () => (await persisted()).position.x - before.position.x)
          .toBeGreaterThan(40 / zoom);
        const after = await persisted();
        const endBox = await box(node);
        expect(endBox.x - startBox.x).toBeCloseTo(
          (after.position.x - before.position.x) * zoom,
          0,
        );
        expect(endBox.y - startBox.y).toBeCloseTo(
          (after.position.y - before.position.y) * zoom,
          0,
        );
        expect(after.style).toEqual(before.style);
        expect(await readViewportTransform(page)).toBe(viewport);
        expect(await identity?.evaluate((el) => el.isConnected)).toBe(true);
        await identity?.dispose();
        // One undo restores the complete drag, not one position tick.
        await page.keyboard.press('ControlOrMeta+z');
        await expect
          .poll(async () => (await persisted()).position)
          .toEqual(before.position);
      }
      await assertToolbarCancelAndControls(page, node, persisted);
      // Type-button activation is also the parent-page exit from a cross-origin site.
      if (type === 'web') {
        await node
          .locator('iframe')
          .contentFrame()
          .getByRole('button', { name: 'Clicked' })
          .click();
        await expect(node.locator('iframe')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(node.locator('iframe')).toBeFocused();
        await grip.click();
        await expect(page.locator('[data-canvas-root]')).toBeFocused();
      } else {
        await node.locator('[data-pdf-scroll-viewport]').evaluate((el) => {
          el.tabIndex = -1;
          el.focus();
        });
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-canvas-root]')).toBeFocused();
      }
      await expect(node).toHaveClass(/selected/);
      await page.mouse.move(1100, 650);
      await grip.focus();
      await grip.hover();
      await expect(grip).toBeFocused();
      // A visible tooltip must not add a third step to canvas focus exit.
      const tooltip = page.getByRole('tooltip', {
        name: `${type} · Drag to move`,
        exact: true,
      });
      await expect(tooltip).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
      await expect(page.locator('[data-canvas-root]')).toBeFocused();
      await expect(node).toHaveClass(/selected/);
      await page.keyboard.press('Escape');
      await expect(node).not.toHaveClass(/selected/);
      await expect(grip).toHaveCount(0);
      // Restore selection for the remaining reader and toolbar checks.
      await node.click({ position: { x: 80, y: 80 } });
      await expect(node).toHaveClass(/selected/);
      await expect(grip).toBeVisible();
      if (type === 'web') {
        await node
          .locator('iframe')
          .contentFrame()
          .locator('body')
          .evaluate(() => scrollTo(0, 0));
        await expect(
          node
            .locator('iframe')
            .contentFrame()
            .getByText('Original website header'),
        ).toBeVisible();
      }
      await testInfo.attach(`${type}-${zoom}-drag-grip`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.screenshot({
        path: testInfo.outputPath(`${type}-${zoom}-drag-grip.png`),
      });
      await page.mouse.click(1100, 650);
      await expect(node).not.toHaveClass(/selected/);
      await expect(grip).toHaveCount(0);

      // Selected type buttons remain available at overview/minimal too.
      await page.evaluate(
        ({ canvasId, zoom }) =>
          localStorage.setItem(
            `huabu.viewport.${canvasId}`,
            JSON.stringify({ x: 120, y: 40, zoom: zoom * 0.4 }),
          ),
        { canvasId, zoom },
      );
      // Init script intentionally restores the fixture zoom on reload; override with a later one.
      await page.addInitScript(
        ({ canvasId, zoom }) => {
          if (window !== window.top) return;
          localStorage.setItem(
            `huabu.viewport.${canvasId}`,
            JSON.stringify({ x: 120, y: 40, zoom: zoom * 0.4 }),
          );
        },
        { canvasId, zoom },
      );
      await page.reload();
      await node.click({ position: { x: 35, y: 35 } });
      await expect(node).toHaveClass(/selected/);
      await expect(grip).toBeVisible();
      await assertToolbarDragAndUndo(page, node, grip, persisted, zoom * 0.4);
      expect(errors).toEqual([]);
    });
  }
}

for (const zoom of [0.5, 1]) {
  test(`video poster drag and explicit play on the real Canvas at ${zoom} zoom`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.routeWebSocket('**', (socket) => socket.close());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { node, persisted } = await seed(page, 'video', zoom);
    const video = node.locator('video');
    const play = node.getByRole('button', { name: 'Play video', exact: true });
    const viewport = await readViewportTransform(page);
    await expect(node.locator('[data-video-player] svg')).toHaveCount(0);
    await expect(node.locator('svg.lucide-play')).toHaveCount(1);
    // Both unselected and selected poster gestures belong to native node dragging.
    for (const selected of [false, true]) {
      if (selected) await expect(node).toHaveClass(/selected/);
      const before = await persisted();
      const start = await box(node);
      await page.mouse.move(start.x + 80, start.y + 80);
      await page.mouse.down();
      await page.mouse.move(start.x + 140, start.y + 105, { steps: 10 });
      await page.mouse.up();
      await expect
        .poll(async () => (await persisted()).position.x - before.position.x)
        .toBeGreaterThan(40 / zoom);
      expect((await persisted()).style).toEqual(before.style);
      await expect(video).toHaveCount(0);
      await expect(play).toBeVisible();
      await expect(node.locator('[data-node-drag-handle]')).toHaveCount(0);
      expect(await readViewportTransform(page)).toBe(viewport);
    }
    await page.screenshot({
      path: testInfo.outputPath(`video-${zoom}-poster.png`),
    });
    // One click from an unselected node must select and actually start playback.
    await page.mouse.click(1100, 650);
    await expect(node).not.toHaveClass(/selected/);
    const beforePlay = await persisted();
    const beforeBox = await box(node);
    await play.click();
    await expect(node).toHaveClass(/selected/);
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
    await expect
      .poll(() => video.evaluate((el) => el.currentTime))
      .toBeGreaterThan(0);
    expect(await box(node)).toEqual(beforeBox);
    expect((await persisted()).position).toEqual(beforePlay.position);
    await page.screenshot({
      path: testInfo.outputPath(`video-${zoom}-playing.png`),
    });
    await video.focus();
    await page.keyboard.press('Backspace');
    await expect(node).toHaveCount(1);
    await video.hover();
    await page.mouse.wheel(0, 120);
    await video.dispatchEvent('wheel', {
      ctrlKey: true,
      deltaY: -80,
      bubbles: true,
      cancelable: true,
    });
    const bounds = await box(video);
    await page.mouse.move(bounds.x + 60, bounds.y + 60);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 90, bounds.y + 75, { steps: 8 });
    await page.mouse.up();
    expect(await box(node)).toEqual(beforeBox);
    expect(await readViewportTransform(page)).toBe(viewport);
    // A toolbar drag must preserve the mounted player and its explicit activation.
    await video.evaluate(async (element) => {
      element.loop = true;
      await element.play();
    });
    const playerIdentity = await video.elementHandle();
    const grip = page.locator('.node-floating-toolbar [data-node-drag-handle]');
    const gripBox = await box(grip);
    await page.mouse.move(
      gripBox.x + gripBox.width / 2,
      gripBox.y + gripBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      gripBox.x + gripBox.width / 2 + 60,
      gripBox.y + gripBox.height / 2 + 30,
      { steps: 10 },
    );
    await expect(grip).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(async () => (await persisted()).position.x - beforePlay.position.x)
      .toBeGreaterThan(40 / zoom);
    expect(await playerIdentity?.evaluate((el) => el.isConnected)).toBe(true);
    expect(await video.evaluate((element) => element.paused)).toBe(false);
    await expect(play).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`video-${zoom}-toolbar-drag.png`),
    });
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await persisted()).position)
      .toEqual(beforePlay.position);
    await playerIdentity?.dispose();
    await assertToolbarCancelAndControls(page, node, persisted);
    await video.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-canvas-root]')).toBeFocused();
    await expect(node).toHaveClass(/selected/);
    await expect(video).toHaveCount(1);
    expect(await video.evaluate((el) => el.paused)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(node).not.toHaveClass(/selected/);
    await expect(video).toHaveCount(0);
    await node.click({ position: { x: 70, y: 70 } });
    await expect(node).toHaveClass(/selected/);
    await expect(video).toHaveCount(0);
    // Native keyboard button activation shares the same selection/play path.
    await play.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
    await page.mouse.click(1100, 650);
    await expect(video).toHaveCount(0);
    await play.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
    expect((await persisted()).position).toEqual(beforePlay.position);
    expect(errors).toEqual([]);
  });
}

async function assertToolbarDragAndUndo(
  page: Page,
  node: Locator,
  grip: Locator,
  persisted: () => Promise<Node>,
  zoom: number,
) {
  await expect(grip).toBeVisible();
  await expect(grip).toHaveAccessibleName(/ · Drag to move$/);
  const before = await persisted();
  const initialBox = await box(node);
  const viewport = await readViewportTransform(page);
  const control = await box(grip);
  const identity = await grip.elementHandle();
  const start = {
    x: control.x + control.width / 2,
    y: control.y + control.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 30, { steps: 10 });
  await expect(grip).toBeVisible();
  expect(await identity?.evaluate((el) => el.isConnected)).toBe(true);
  await page.mouse.up();
  await expect(page.locator('[data-canvas-root]')).not.toBeFocused();
  await expect
    .poll(async () => (await persisted()).position.x - before.position.x)
    .toBeGreaterThan(40 / zoom);
  await expect
    .poll(async () => (await persisted()).position.y - before.position.y)
    .toBeGreaterThan(15 / zoom);
  const after = await persisted();
  const movedBox = await box(node);
  expect(movedBox.x - initialBox.x).toBeCloseTo(
    (after.position.x - before.position.x) * zoom,
    0,
  );
  expect(movedBox.y - initialBox.y).toBeCloseTo(
    (after.position.y - before.position.y) * zoom,
    0,
  );
  expect(after.id).toBe(before.id);
  expect(after.type).toBe(before.type);
  expect(after.data.type).toBe(before.data.type);
  expect(after.data.content).toEqual(before.data.content);
  expect(after.data.strokes).toEqual(before.data.strokes);
  expect(after.style).toEqual(before.style);
  expect(await readViewportTransform(page)).toBe(viewport);
  await identity?.dispose();
  // The persisted final position must roll back in one undo, not one move tick.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await persisted()).position)
    .toEqual(before.position);
  await expect.poll(() => box(node)).toEqual(initialBox);
  expect((await persisted()).type).toBe(before.type);
}

for (const zoom of [0.5, 1]) {
  test(`PDF keyboard navigation retains native scrolling without node movement or Space pan at ${zoom} zoom`, async ({
    page,
  }) => {
    await page.routeWebSocket('**', (socket) => socket.close());
    const { node, persisted } = await seed(page, 'pdf', zoom);
    await node.click({ position: { x: 80, y: 80 } });
    await expect(node).toHaveClass(/selected/);
    const reader = node.locator('[data-pdf-scroll-viewport]');
    await expect(node.locator('.react-pdf__Page canvas')).toBeVisible();
    await expect
      .poll(() => reader.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(500);
    const initial = await persisted();
    const initialBox = await box(node);
    const viewport = await readViewportTransform(page);
    const canvas = page.locator('[data-canvas-root]');
    const pan = page.getByRole('button', { name: /^Pan \(/ });
    const pane = canvas.locator('.react-flow__pane');
    // React Flow can own Space before the app updates the tool label. Check
    // actual pan eligibility as well as the application's temporary tool.
    await expect(pane).not.toHaveClass(/\bdraggable\b/);
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await page.keyboard.down('Space');
    try {
      await expect(pane).toHaveClass(/\bdraggable\b/);
    } finally {
      await page.keyboard.up('Space');
    }
    await expect(pane).not.toHaveClass(/\bdraggable\b/);
    await expect(pan).toHaveCount(0);
    await reader.focus();
    await expect(reader).toBeFocused();
    for (const key of ['ArrowDown', 'Space']) {
      const before = await reader.evaluate((el) => el.scrollTop);
      // Space must scroll a page-sized distance, not merely finish the
      // preceding ArrowDown's native smooth-scroll animation.
      const minimumScroll =
        key === 'Space'
          ? await reader.evaluate((el) => el.clientHeight / 2)
          : 0;
      await page.keyboard.down(key);
      try {
        await expect
          .poll(() => reader.evaluate((el) => el.scrollTop))
          .toBeGreaterThan(before + minimumScroll);
        await expect(pan).toHaveCount(0);
        await expect(pane).not.toHaveClass(/\bdraggable\b/);
        await expect(reader).toBeFocused();
        expect(await box(node)).toEqual(initialBox);
        expect(await readViewportTransform(page)).toBe(viewport);
      } finally {
        await page.keyboard.up(key);
      }
      expect((await persisted()).position).toEqual(initial.position);
      await expect(node).toHaveClass(/selected/);
    }
    // The navigation shield must not consume the existing two-step Escape.
    await page.keyboard.press('Escape');
    await expect(canvas).toBeFocused();
    await expect(node).toHaveClass(/selected/);
    await page.keyboard.press('Escape');
    await expect(node).not.toHaveClass(/selected/);
    expect((await persisted()).position).toEqual(initial.position);
  });
}

test('toolbar keyboard navigation shields arrows while native activation, Escape and shell movement remain available', async ({
  page,
}) => {
  await page.routeWebSocket('**', (socket) => socket.close());
  const { node, persisted } = await seed(page, 'image', 1);
  await node.click({ position: { x: 10, y: 10 } });
  await expect(node).toHaveClass(/selected/);
  const button = page.locator('.node-floating-toolbar [data-node-drag-handle]');
  const canvas = page.locator('[data-canvas-root]');
  const initial = await persisted();
  const initialBox = await box(node);
  const viewport = await readViewportTransform(page);
  await button.focus();
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(key);
    await expect(button).toBeFocused();
    expect(await box(node)).toEqual(initialBox);
    expect((await persisted()).position).toEqual(initial.position);
    expect(await readViewportTransform(page)).toBe(viewport);
  }
  for (const key of ['Space', 'Enter']) {
    await button.focus();
    await page.keyboard.down(key);
    try {
      if (key === 'Space') {
        // Native buttons activate Space on keyup, not keydown.
        await expect(button).toBeFocused();
        await expect(canvas.locator('.react-flow__pane')).not.toHaveClass(
          /\bdraggable\b/,
        );
        await expect(page.getByRole('button', { name: /^Pan \(/ })).toHaveCount(
          0,
        );
      }
    } finally {
      await page.keyboard.up(key);
    }
    await expect(canvas).toBeFocused();
    await expect(node).toHaveClass(/selected/);
    expect(await box(node)).toEqual(initialBox);
    expect((await persisted()).position).toEqual(initial.position);
    expect(await readViewportTransform(page)).toBe(viewport);
  }
  await button.focus();
  await button.hover();
  const tooltip = page.getByRole('tooltip', {
    name: 'image · Drag to move',
    exact: true,
  });
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(node).toHaveClass(/selected/);
  await page.keyboard.press('Escape');
  await expect(node).not.toHaveClass(/selected/);
  await expect(button).toHaveCount(0);
  await node.click({ position: { x: 10, y: 10 } });
  // Focus the actual React Flow shell: its keyboard movement must stay enabled.
  await node.focus();
  await expect(node).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await box(node)).x)
    .toBeGreaterThan(initialBox.x);
  // This control checks the existing React Flow keyboard gesture, not the
  // separate persistence lifecycle (which this change does not alter).
  expect((await box(node)).y).toBe(initialBox.y);
  expect(await readViewportTransform(page)).toBe(viewport);
});

test('Escape clears a mouse-selected node without requiring content focus', async ({
  page,
}) => {
  await page.routeWebSocket('**', (socket) => socket.close());
  const { node } = await seed(page, 'image', 1);
  await node.click({ position: { x: 10, y: 10 } });
  await expect(node).toHaveClass(/selected/);
  // No focus() or type-button activation: this is the ordinary pointer path.
  await page.keyboard.press('Escape');
  await expect(node).not.toHaveClass(/selected/);
  await expect(page.locator('.node-floating-toolbar')).toHaveCount(0);
});

for (const type of ['text', 'note'] as const) {
  test(`${type} current toolbar type retains native focus exit during ingestion`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.routeWebSocket('**', (socket) => socket.close());
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the real load-time backfill request, not the store or toolbar.
    await page.route('**/nodes/*/preprocess', async (route) => {
      await pending;
      await route.continue();
    });
    try {
      const { node, persisted } = await seed(page, type, 1, {
        emptyLabel: true,
      });
      await node.click({ position: { x: 20, y: 12 } });
      const toolbar = page.locator('.node-floating-toolbar');
      const current = toolbar.locator(
        '[data-node-drag-handle][aria-pressed="true"]',
      );
      const alternate = toolbar.getByRole('button', {
        name: 'Ingestion in progress',
      });
      await expect(current).toBeEnabled();
      await expect(alternate).toBeDisabled();
      const before = await persisted();
      for (const activation of ['click', 'Enter', 'Space']) {
        await current.focus();
        if (activation === 'click') await current.click();
        else await page.keyboard.press(activation);
        await expect(page.locator('[data-canvas-root]')).toBeFocused();
        await expect(node).toHaveClass(/selected/);
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
        await expect(node).toContainText(
          'Toolbar drag preserves this content.',
        );
        await expect(alternate).toBeDisabled();
        const after = await persisted();
        expect(after.id).toBe(before.id);
        expect(after.type).toBe(type);
        expect(after.data.type).toBe(type);
        expect(after.data.content).toEqual(before.data.content);
        expect(after.position).toEqual(before.position);
      }
      await assertToolbarDragAndUndo(page, node, current, persisted, 1);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test(`${type} toolbar buttons drag without conversion; click, Enter and Space activate`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.routeWebSocket('**', (socket) => socket.close());
    const { node, persisted } = await seed(page, type, 1);
    await node.click({ position: { x: 20, y: 12 } });
    await expect(node).toHaveClass(/selected/);
    const toolbar = page.locator('.node-floating-toolbar');
    await expect(toolbar.locator('[data-node-drag-handle]')).toHaveCount(2);
    const initial = await persisted();
    const current = toolbar.locator(
      '[data-node-drag-handle][aria-pressed="true"]',
    );
    await expect(node).toContainText('Toolbar drag preserves this content.');
    const initialBox = await box(node);
    const viewport = await readViewportTransform(page);
    for (const activation of ['click', 'Enter', 'Space']) {
      await current.focus();
      await expect(current).toBeFocused();
      if (activation === 'click') await current.click();
      else if (activation === 'Space') {
        await page.keyboard.down('Space');
        await expect(current).toBeFocused();
        await expect(page.getByRole('button', { name: /^Pan \(/ })).toHaveCount(
          0,
        );
        await page.keyboard.up('Space');
      } else await page.keyboard.press(activation);
      await expect(page.locator('[data-canvas-root]')).toBeFocused();
      await expect(node).toHaveClass(/selected/);
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
      await expect(current).toHaveAttribute('aria-pressed', 'true');
      await expect(node).toContainText('Toolbar drag preserves this content.');
      expect(await box(node)).toEqual(initialBox);
      expect(await readViewportTransform(page)).toBe(viewport);
      const retained = await persisted();
      expect(retained.id).toBe(initial.id);
      expect(retained.type).toBe(type);
      expect(retained.data.type).toBe(type);
      expect(retained.position).toEqual(initial.position);
      expect(retained.style).toEqual(initial.style);
      expect(retained.data.content).toEqual(initial.data.content);
    }
    // Both the current and alternate type button move the same whole node.
    for (const pressed of ['true', 'false']) {
      const grip = toolbar.locator(
        `[data-node-drag-handle][aria-pressed="${pressed}"]`,
      );
      await assertToolbarDragAndUndo(page, node, grip, persisted, 1);
      await expect(node).toHaveCount(1);
    }
    const alternate = type === 'text' ? 'note' : 'text';
    await toolbar
      .locator('[data-node-drag-handle][aria-pressed="false"]')
      .click();
    const converted = page.locator(`.react-flow__node-${alternate}`);
    await expect(converted).toHaveClass(/selected/);
    await expect.poll(async () => (await persisted()).type).toBe(alternate);
    expect((await persisted()).id).toBe(initial.id);
    expect((await persisted()).position).toEqual(initial.position);
    expect((await persisted()).data.content).toEqual(initial.data.content);
    // Convert back using a real keyboard activation on the alternate button.
    await toolbar
      .locator('[data-node-drag-handle][aria-pressed="false"]')
      .focus();
    await page.keyboard.press('Enter');
    await expect(node).toHaveClass(/selected/);
    await expect.poll(async () => (await persisted()).type).toBe(type);
    expect((await persisted()).id).toBe(initial.id);
    expect((await persisted()).position).toEqual(initial.position);
    expect((await persisted()).data.content).toEqual(initial.data.content);
    // Space must retain native button activation on the conversion path too.
    for (const expectedType of [alternate, type]) {
      const toggle = toolbar.locator(
        '[data-node-drag-handle][aria-pressed="false"]',
      );
      await expect(toggle).toBeEnabled();
      await toggle.focus();
      await page.keyboard.down('Space');
      await expect(page.getByRole('button', { name: /^Pan \(/ })).toHaveCount(
        0,
      );
      await page.keyboard.up('Space');
      await expect
        .poll(async () => (await persisted()).type)
        .toBe(expectedType);
      expect((await persisted()).id).toBe(initial.id);
      expect((await persisted()).position).toEqual(initial.position);
      expect((await persisted()).data.content).toEqual(initial.data.content);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${type}-type-buttons.png`),
    });
    await page.reload();
    await expect(node).toBeVisible();
    expect((await persisted()).type).toBe(type);
    expect((await persisted()).position).toEqual(initial.position);
  });
}

for (const type of [
  'image',
  'office',
  'question',
  'sketch',
  'frame',
  'spacePreview',
] as const) {
  test(`${type} type button moves the real Canvas node with one persisted undo`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.routeWebSocket('**', (socket) => socket.close());
    const { node, persisted } = await seed(page, type, 1);
    // Sketch blank space intentionally passes through; select a painted stroke.
    // Other nodes use their shell/header, never a preview or agent action.
    await node.click({
      position: type === 'sketch' ? { x: 180, y: 100 } : { x: 10, y: 10 },
    });
    await expect(node).toHaveClass(/selected/);
    const grip = page.locator('.node-floating-toolbar [data-node-drag-handle]');
    await expect(grip).toHaveCount(1);
    await assertToolbarDragAndUndo(page, node, grip, persisted, 1);
    await page.screenshot({
      path: testInfo.outputPath(`${type}-type-drag.png`),
    });
    const restored = await persisted();
    await page.reload();
    await expect(node).toBeVisible();
    expect((await persisted()).position).toEqual(restored.position);
    expect((await persisted()).type).toBe(type);
  });
}

for (const type of ['image', 'video', 'web', 'pdf'] as const) {
  test(`${type} missing-source overview still offers type-button dragging`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.routeWebSocket('**', (socket) => socket.close());
    const { node, persisted } = await seed(page, type, 0.2, {
      missingSource: true,
    });
    await node.click({ position: { x: 15, y: 15 } });
    await expect(node).toHaveClass(/selected/);
    expect((await persisted()).data.src ?? '').toBe('');
    await expect(node.locator('iframe, video, .react-pdf__Page')).toHaveCount(
      0,
    );
    const grip = page.locator('.node-floating-toolbar [data-node-drag-handle]');
    await assertToolbarDragAndUndo(page, node, grip, persisted, 0.2);
  });
}

async function assertToolbarCancelAndControls(
  page: Page,
  node: Locator,
  persisted: () => Promise<Node>,
) {
  const grip = page.locator('.node-floating-toolbar [data-node-drag-handle]');
  const before = await persisted();
  const initialBox = await box(node);
  // Other toolbar controls remain independent of the draggable type button.
  const toolbar = page.locator('.node-floating-toolbar');
  const copy = toolbar.getByRole('button', { name: /copy.*link/i });
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('/canvas/');
  expect(await box(node)).toEqual(initialBox);
  for (const cancellation of [
    'Escape',
    'blur',
    'pointercancel',
    'lostpointercapture',
  ]) {
    const bounds = await box(grip);
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 + 45,
      bounds.y + bounds.height / 2 + 20,
      { steps: 8 },
    );
    await expect(grip).toBeVisible();
    expect((await box(node)).x).toBeGreaterThan(initialBox.x + 20);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'blur')
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else
      await grip.dispatchEvent(cancellation, {
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
      });
    await page.mouse.up();
    await expect.poll(() => box(node)).toEqual(initialBox);
    expect((await persisted()).position).toEqual(before.position);
    await expect(grip).toBeVisible();
  }
  // The next gesture still works and creates exactly one undo entry.
  const bounds = await box(grip);
  await page.mouse.move(bounds.x + 14, bounds.y + 14);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 74, bounds.y + 44, { steps: 8 });
  await page.keyboard.down('ControlOrMeta');
  await expect(grip).toBeVisible();
  await page.keyboard.up('ControlOrMeta');
  await page.mouse.up();
  await expect
    .poll(async () => (await persisted()).position.x)
    .toBeGreaterThan(before.position.x + 20);
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await persisted()).position)
    .toEqual(before.position);
}

test('posterless video has one play icon at 200% zoom', async ({
  page,
}, testInfo) => {
  await page.routeWebSocket('**', (socket) => socket.close());
  const { node } = await seed(page, 'video', 2);
  await expect(node.locator('[data-video-player] svg')).toHaveCount(0);
  await expect(node.locator('svg.lucide-play')).toHaveCount(1);
  const button = await box(
    node.getByRole('button', { name: 'Play video', exact: true }),
  );
  expect(button.width).toBeCloseTo(96, 0);
  await page.screenshot({
    path: testInfo.outputPath('video-2-single-play.png'),
  });
});
