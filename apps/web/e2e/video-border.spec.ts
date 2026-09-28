// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { writeFile } from 'node:fs/promises';

import { expect, test, type Locator } from '@playwright/test';

import type { CreateCanvasResponse, GetCanvasResponse } from '@huabu/shared';

async function readBounds(shell: Locator) {
  return shell.evaluate((element) => {
    const rect = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    const content = element.querySelector('.semantic-lod-content');
    const media = content?.querySelector('video, img');
    const player = content?.querySelector('[data-video-player]');
    if (!content || !media || !player) throw new Error('Missing video surface');
    const border = element.querySelector('[data-node-media-border]');
    const style = getComputedStyle(element);
    const scale = element.getBoundingClientRect().width / 400;
    const cornerHit = document.elementFromPoint(
      element.getBoundingClientRect().x + scale,
      element.getBoundingClientRect().y + scale,
    );
    return {
      shell: rect(element),
      content: rect(content),
      media: rect(media),
      player: rect(player),
      border: border ? rect(border) : null,
      layoutBorder: style.borderLeftWidth,
      padding: getComputedStyle(content).padding,
      shellRadius: style.borderTopLeftRadius,
      clipRadius: getComputedStyle(content).borderTopLeftRadius,
      playerRadius: getComputedStyle(player).borderTopLeftRadius,
      borderRadius: border && getComputedStyle(border).borderTopLeftRadius,
      borderColor: border && getComputedStyle(border).borderLeftColor,
      shellBorderColor: style.borderLeftColor,
      cornerInContent: content.contains(cornerHit),
      objectFit: getComputedStyle(media).objectFit,
      intrinsic:
        media instanceof HTMLVideoElement
          ? [media.videoWidth, media.videoHeight]
          : [
              (media as HTMLImageElement).naturalWidth,
              (media as HTMLImageElement).naturalHeight,
            ],
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const zoom of [0.24, 0.5, 1, 1.5]) {
    test(`video zero-layout boundary ${theme} at ${zoom} zoom`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: 1600, height: 1000 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.routeWebSocket('**', (socket) => socket.close());
      await page.goto('/');
      // Same native MediaRecorder fixture as video-inline, with known edge pixels
      // contrasting against teal. The PNG contains no intrinsic gray side bands.
      const fixture = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Missing recording context');
        const paint = () => {
          context.fillStyle = '#ffe000';
          context.fillRect(0, 0, 160, 180);
          context.fillStyle = '#cc44ee';
          context.fillRect(160, 0, 160, 180);
        };
        paint();
        const poster = canvas.toDataURL('image/png');
        const stream = canvas.captureStream(10);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const recorded = new Promise<Blob>((resolve) => {
          recorder.onstop = () =>
            resolve(new Blob(chunks, { type: 'video/webm' }));
        });
        recorder.start();
        const interval = setInterval(paint, 80);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        recorder.stop();
        const bytes = Array.from(
          new Uint8Array(await (await recorded).arrayBuffer()),
        );
        clearInterval(interval);
        stream.getTracks().forEach((track) => track.stop());
        return { bytes, poster };
      });
      const src = 'https://video-border.example.test/movie.webm';
      await page.route(src, (route) =>
        route.fulfill({
          contentType: 'video/webm',
          body: Buffer.from(fixture.bytes),
        }),
      );
      const created = await page.request.post('/api/canvas', {
        data: { title: `Video boundary ${theme} ${zoom}` },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { canvasId } = (await created.json()) as CreateCanvasResponse;
      const inserted = await page.request.post(
        `/api/canvas/${canvasId}/execute`,
        {
          data: {
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    nodeType: 'video',
                    data: {
                      label: 'Contrasting 16:9 movie',
                      src,
                      coverUrl: fixture.poster,
                      coverSourceSrc: src,
                      style: { accent: 'teal' },
                    },
                    position: { x: 180 / zoom, y: 180 / zoom },
                    size: { width: 400, height: 225 },
                  },
                ],
              },
            ],
            originator: { source: 'agent', threadId: 'e2e-video-border' },
          },
        },
      );
      expect(inserted.ok(), await inserted.text()).toBe(true);
      // Creation intentionally drops derived cover fields. Supply only the known
      // poster metadata at hydration; Canvas, media, selection and CSS stay real.
      await page.route(`**/api/canvas/${canvasId}`, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as GetCanvasResponse;
        for (const node of body.state.nodes) {
          if (node.type === 'video')
            Object.assign(node.data, {
              coverUrl: fixture.poster,
              coverSourceSrc: src,
            });
        }
        await route.fulfill({ response, json: body });
      });
      await page.addInitScript(
        ({ canvasId, zoom }) => {
          if (window !== window.top) return;
          localStorage.setItem(
            `huabu.viewport.${canvasId}`,
            JSON.stringify({ x: 60, y: 40, zoom }),
          );
        },
        { canvasId, zoom },
      );
      await page.goto(`/canvas/${canvasId}`);
      await page.keyboard.press('Escape');
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.classList.toggle('light', theme === 'light');
      }, theme);
      const node = page.locator('.react-flow__node-video');
      const shell = node.locator('.semantic-lod-node');
      const poster = shell.locator('img');
      await expect(poster).toBeVisible();
      await expect
        .poll(() => poster.evaluate((el) => el.naturalWidth))
        .toBe(320);
      // Use the real Canvas HUD, not a simulated selected CSS class.
      const outline = page.locator('.react-flow > div[style*="outline:"]');
      await page
        .locator('.react-flow__pane')
        .click({ position: { x: 40, y: 150 } });
      const assertBoundary = async (state: string, active = false) => {
        await page.mouse.move(20, 150);
        const bounds = await readBounds(shell);
        await writeFile(
          testInfo.outputPath(`${state}-geometry.json`),
          JSON.stringify(bounds, null, 2),
        );
        await testInfo.attach(`${state}-geometry`, {
          body: JSON.stringify(bounds, null, 2),
          contentType: 'application/json',
        });
        await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
        expect(bounds.shell.width).toBeCloseTo(400 * zoom, 2);
        expect(bounds.shell.height).toBeCloseTo(225 * zoom, 2);
        expect(bounds.layoutBorder).toBe('0px');
        expect(bounds.padding).toBe('0px');
        for (const box of [
          bounds.content,
          bounds.media,
          bounds.player,
          bounds.border,
        ]) {
          expect(box).not.toBeNull();
          if (!box) throw new Error('Missing media boundary overlay');
          for (const key of ['x', 'y', 'width', 'height'] as const)
            expect(box[key]).toBeCloseTo(bounds.shell[key], 2);
        }
        expect(bounds.intrinsic).toEqual([320, 180]);
        expect(bounds.objectFit).toBe('contain');
        expect(bounds.clipRadius).toBe(bounds.shellRadius);
        expect(bounds.borderRadius).toBe(bounds.shellRadius);
        expect(parseFloat(bounds.playerRadius)).toBeCloseTo(
          12 * (active ? zoom : 1),
          2,
        );
        expect(bounds.borderColor).toBe(bounds.shellBorderColor);
        expect(bounds.borderColor).not.toBe('rgba(0, 0, 0, 0)');
        // Chromium's hit test covers a whole CSS pixel, which can intersect a
        // 2.88px corner arc at 24% zoom. Check actual corner paint there instead.
        if (zoom >= 0.5) expect(bounds.cornerInContent).toBe(false);
        else if (state === 'unselected') {
          const screenshot = await page.screenshot();
          const cornerPaint = await page.evaluate(
            async ({ png, x, y }) => {
              const image = new Image();
              image.src = `data:image/png;base64,${png}`;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Missing screenshot context');
              context.drawImage(image, 0, 0);
              const pixel = (px: number, py: number) =>
                Array.from(context.getImageData(px, py, 1, 1).data);
              return { corner: pixel(x, y), background: pixel(x - 2, y - 2) };
            },
            {
              png: screenshot.toString('base64'),
              x: bounds.shell.x,
              y: bounds.shell.y,
            },
          );
          // Subpixel antialiasing may tint the cutout slightly; an unclipped
          // yellow source pixel would differ by hundreds of channel levels.
          for (let channel = 0; channel < 3; channel++)
            expect(
              Math.abs(
                cornerPaint.corner[channel] - cornerPaint.background[channel],
              ),
            ).toBeLessThanOrEqual(8);
        }
        const border = shell.locator('[data-node-media-border]');
        await expect(border).toHaveCSS('border-left-width', '3px');
        await expect(border).toHaveCSS('pointer-events', 'none');
      };
      await expect(node).not.toHaveClass(/selected/);
      await expect(outline).toHaveCount(0);
      await assertBoundary('unselected');
      await node.click({ position: { x: 15, y: 15 } });
      await expect(node).toHaveClass(/selected/);
      await expect(outline).toHaveCount(1);
      await expect(outline).toHaveCSS('outline-width', '1px');
      await assertBoundary('selected');
      if (zoom >= 0.3) {
        await node
          .getByRole('button', { name: 'Play video', exact: true })
          .click();
        const video = node.locator('video');
        await expect
          .poll(() =>
            video.evaluate((el) => !el.paused && el.videoWidth === 320),
          )
          .toBe(true);
        await video.evaluate((el) => {
          el.pause();
          el.currentTime = 0;
        });
        await expect(video).toHaveJSProperty('controls', true);
        await assertBoundary('player', true);
        await expect(outline).toHaveCount(1);
      } else {
        await expect(node.locator('video')).toHaveCount(0);
        await expect(
          node.getByRole('button', { name: 'Play video', exact: true }),
        ).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
  }
}
