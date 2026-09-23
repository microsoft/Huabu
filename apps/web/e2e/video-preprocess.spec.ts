// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { readViewportTransform, scaleOf } from './helpers';

import type {
  ArtifactUploadResponse,
  CreateCanvasResponse,
  GetCanvasResponse,
  PreprocessNodeBody,
  PreprocessNodeResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

async function recordWebM(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    // Chromium encodes the fixture; the server must decode it with its default FFmpeg.
    const mimeType = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType))
      throw new Error('Chromium must support VP8 WebM recording');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas recording context');
    let frame = 0;
    const paint = () => {
      context.fillStyle = 'teal';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'white';
      context.fillRect((frame++ * 5) % 280, 60, 40, 60);
    };
    paint();
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    const recorded = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onerror = () => reject(new Error('WebM recording failed'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    const timer = setInterval(paint, 80);
    try {
      recorder.start();
      // This is fixture recording time, not a wait for application state.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      recorder.stop();
      return Array.from(new Uint8Array(await (await recorded).arrayBuffer()));
    } finally {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    }
  });
  return Buffer.from(bytes);
}

test('uploaded video gets a persisted JPEG cover, reuses it and plays natively at 50% zoom', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  // Fail before any request if redirected to the developer's live stack.
  const origin = new URL(baseURL ?? '');
  expect(['localhost', '127.0.0.1']).toContain(origin.hostname);
  expect(origin.port).toBe(process.env.E2E_WEB_PORT ?? '5273');
  expect(origin.port).not.toBe('5173');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.origin === origin.origin &&
      url.pathname.startsWith('/api/') &&
      response.status() >= 400
    ) {
      errors.push(`HTTP ${response.status()} ${url.pathname}`);
    }
  });

  // All mutations use the real isolated API; no routes, store injection or mocked media.
  const created = await page.request.post('/api/canvas', {
    data: { title: 'Video preprocessing E2E' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  expect(canvasId).toBeTruthy();
  await page.goto('/');
  const bytes = await recordWebM(page);
  expect(bytes.length).toBeGreaterThan(1000);
  const uploaded = await page.request.post(
    `/api/canvas/${canvasId}/artifact/video`,
    {
      multipart: {
        file: {
          name: 'playable-vp8.webm',
          mimeType: 'video/webm',
          buffer: bytes,
        },
      },
    },
  );
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const { uri: src } = (await uploaded.json()) as ArtifactUploadResponse;
  expect(src).toMatch(/^[^/\\:]+\.webm$/);
  const label = 'Uploaded VP8 video';
  const inserted = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'video',
              data: { src, label },
              position: { x: 240, y: 200 },
              size: { width: 400, height: 225 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-video-preprocess' },
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);

  async function persistedVideo() {
    const response = await page.request.get(`/api/canvas/${canvasId}`);
    expect(response.ok(), await response.text()).toBe(true);
    const record = (await response.json()) as GetCanvasResponse;
    const state = record.state as { nodes: Node[] };
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({
      type: 'video',
      data: { src, label },
    });
    return state.nodes[0];
  }

  const initial = await persistedVideo();
  expect(initial.data.coverUrl).toBeUndefined();
  await page.addInitScript((id) => {
    // Reuse the production persisted-viewport contract, not React Flow/store injection.
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 160, y: 100, zoom: 0.5 }),
    );
  }, canvasId);
  await page.goto(`/canvas/${canvasId}`);
  const node = page.locator(`.react-flow__node[data-id="${initial.id}"]`);
  await expect(node).toBeVisible();

  async function preprocess() {
    // No previousSnapshot or client-supplied cover: the second call must consult persisted cache.
    const body: PreprocessNodeBody = {
      nodeType: 'video',
      trigger: 'manual',
      snapshot: { src, label },
      options: { allowLLM: false, allowPersistence: true },
    };
    const response = await page.request.post(
      `/api/canvas/${canvasId}/nodes/${initial.id}/preprocess`,
      { data: body },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const result = (await response.json()) as PreprocessNodeResponse;
    expect(result, JSON.stringify(result)).toMatchObject({
      nodeId: initial.id,
      success: true,
      coverSourceSrc: src,
    });
    expect(result.error).toBeUndefined();
    expect(result.coverUrl).toMatch(/^cover_[^/\\:]+\.jpg$/);
    return result;
  }

  const first = await preprocess();
  const coverUrl = first.coverUrl;
  const coverPath = `/api/canvas/${canvasId}/artifact/${coverUrl}`;
  const cover = await page.request.get(coverPath);
  expect(cover.ok(), await cover.text()).toBe(true);
  expect(cover.headers()['content-type']).toContain('image/jpeg');
  const jpeg = await cover.body();
  expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
  const second = await preprocess();
  expect(second.coverUrl).toBe(coverUrl);
  const cachedCover = await page.request.get(coverPath);
  expect(cachedCover.ok()).toBe(true);
  expect(await cachedCover.body()).toEqual(jpeg);
  await testInfo.attach('preprocessing-results', {
    body: JSON.stringify({ canvasId, src, first, second }, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect.soft((await persistedVideo()).data).toMatchObject({
    coverUrl,
    coverSourceSrc: src,
  });

  // Reload must hydrate server metadata; the test never patches the response into the browser.
  await page.reload();
  await expect(node).toBeVisible();
  await expect
    .poll(async () => scaleOf(await readViewportTransform(page)))
    .toBeCloseTo(0.5, 4);
  const poster = node.locator('[data-video-player] img');
  const video = node.locator('video');
  await expect(poster).toBeVisible();
  await expect(poster).toHaveAttribute('src', coverPath);
  await expect
    .poll(() =>
      poster.evaluate((image: HTMLImageElement) => ({
        loaded: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
      })),
    )
    .toEqual({ loaded: true, width: 320, height: 180 });
  await expect(video).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('persisted-poster.png') });

  await node.click({ position: { x: 25, y: 25 } });
  await expect(node).toHaveClass(/selected/);
  await expect(video).toHaveCount(0);
  await node.getByRole('button', { name: 'Play video', exact: true }).click();
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('poster', coverPath);
  await expect(video).toHaveAttribute(
    'src',
    `/api/canvas/${canvasId}/artifact/${src}`,
  );
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);
  const media = await video.evaluate((el: HTMLVideoElement) => ({
    controls: el.controls,
    paused: el.paused,
    autoplay: el.autoplay,
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
    cssWidth: el.clientWidth,
  }));
  expect(media).toMatchObject({
    controls: true,
    paused: false,
    autoplay: false,
  });
  expect(media.width).toBeGreaterThan(0);
  expect(media.height).toBeGreaterThan(0);
  expect(media.width).toBeLessThan(560);
  expect(media.height).toBeLessThan(360);
  expect(media.width).toBeCloseTo(media.cssWidth, 0);
  const viewport = await readViewportTransform(page);
  // The real Play click starts native playback; never invoke play() from the test.
  await video.focus();
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(false);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(0.2);
  expect(await video.evaluate((el: HTMLVideoElement) => el.error)).toBeNull();
  expect(await readViewportTransform(page)).toBe(viewport);
  const playing = await video.evaluate((el: HTMLVideoElement) => ({
    currentTime: el.currentTime,
    paused: el.paused,
    readyState: el.readyState,
    error: el.error,
  }));
  expect(playing.paused).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('native-playing-50.png') });
  await page.keyboard.press('Space');
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('native-controls-50.png'),
  });

  expect((await persistedVideo()).data).toMatchObject({
    coverUrl,
    coverSourceSrc: src,
  });
  await testInfo.attach('native-media', {
    body: JSON.stringify({ media, playing, errors }, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
});
