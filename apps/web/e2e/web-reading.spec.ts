// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as StoreModule from '../src/store/canvasStore';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type { Page } from '@playwright/test';

async function setViewport(page: Page, zoom: number, x = 0) {
  await page.evaluate(
    async ({ zoom, x }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof StoreModule;
      const rf = store.getState().rfInstance;
      if (!rf) throw new Error('Missing canvas instance');
      await rf.setViewport({ x, y: 0, zoom });
    },
    { zoom, x },
  );
}

for (const interactive of [false, true]) {
  test(`${interactive ? 'Interactive View' : 'ordinary HTML'} retains structured overview and opens at the same zoom threshold`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const summary =
      'December weekend, departure Friday.\n\n- Friday: arrive in Jiangshan\n- Saturday: climb Jianglang Mountain\n- Sunday: return home\n- Confirm train times and park access';
    const definition = {
      protocolVersion: 1,
      ownerThreadId: 'e2e-web-reading',
      state: {
        schema: {
          type: 'object',
          properties: { day: { type: 'string', maxLength: 20 } },
          required: ['day'],
          additionalProperties: false,
        },
        value: { day: 'Friday' },
      },
      bindings: [],
      actions: [{ actionId: 'save', kind: 'state.replace' }],
    };
    let nodeId = '';
    let runtimeRequests = 0;
    let saves = 0;
    let revision = 'view-1';
    let failNextRuntime = interactive;
    await page.route('**/api/web/preview**', (route) =>
      route.fulfill({ json: { label: 'Weekend guide', summary } }),
    );
    await page.route('**/api/web/page**', (route) =>
      route.fulfill({
        json: {
          kind: 'html',
          src: interactive
            ? `/api/interactive-views/fixture/${nodeId}/renderer`
            : '/api/canvas/fixture/artifact/reading-fixture.html',
        },
      }),
    );
    const resource = () => ({
      nodeId,
      rendererArtifact: 'reading-fixture.html',
      revision,
      definition,
    });
    await page.route('**/api/interactive-views/*/*/runtime', (route) => {
      runtimeRequests += 1;
      if (failNextRuntime) {
        failNextRuntime = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Runtime temporarily unavailable' },
        });
      }
      return route.fulfill({ json: { resource: resource(), data: {} } });
    });
    await page.route('**/api/interactive-views/*/*/state', async (route) => {
      expect(route.request().method()).toBe('PUT');
      expect(route.request().postDataJSON()).toEqual({
        revision,
        value: { day: 'Saturday' },
      });
      saves += 1;
      definition.state.value.day = 'Saturday';
      revision = `view-${saves + 1}`;
      await route.fulfill({ json: resource() });
    });
    const html = `<!doctype html><html><body>
      <h1>Full weekend itinerary</h1>
      <p id="state">Waiting for host</p>
      <button id="save">Choose Saturday</button>
      <script>
        let port, view;
        window.addEventListener('message', (event) => {
          if (event.source !== parent || event.data?.type !== 'huabu.view.connect') return;
          port = event.ports[0];
          port.onmessage = ({ data }) => {
            if (data.type === 'huabu.view.bootstrap') {
              view = data;
              document.querySelector('#state').textContent = data.state.day;
            } else if (data.type === 'huabu.view.outcome' && data.status === 'success') {
              document.querySelector('#state').textContent = data.result.state.day;
            }
          };
          port.start();
        });
        document.querySelector('#save').onclick = () => {
          if (!${interactive}) {
            document.querySelector('#state').textContent = 'Saturday';
            return;
          }
          port.postMessage({
            type: 'huabu.view.intent', protocolVersion: 1, nodeId: view.nodeId,
            requestId: 'save-day', actionId: 'save',
            input: { revision: view.revision, value: { day: 'Saturday' } }
          });
        };
      </script>
    </body></html>`;
    await page.route('**/api/interactive-views/*/*/renderer', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.route('**/artifact/reading-fixture.html', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'web',
                  data: {
                    label: 'Weekend guide',
                    src: 'reading-fixture.html',
                    summary,
                    ...(interactive ? { interactiveView: definition } : {}),
                  },
                  position: { x: 100, y: 100 },
                  size: { width: 508, height: 401 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-web-reading' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const node = page.locator('.react-flow__node-web');
    await expect(node).toBeVisible();
    nodeId = (await node.getAttribute('data-id')) ?? '';
    expect(nodeId).not.toBe('');
    await setViewport(page, 1);
    await expect(node.locator('.preview-card')).toHaveAttribute(
      'data-orientation',
      'text',
    );
    await expect(node.locator('.preview-card__summary li')).toHaveCount(4);
    await expect(node.locator('iframe')).toHaveCount(0);
    expect(runtimeRequests).toBe(0);
    expect(await node.boundingBox()).toMatchObject({ width: 508, height: 401 });
    const summaryBounds = await node
      .locator('.preview-card__summary')
      .boundingBox();
    const cardBounds = await node.boundingBox();
    if (!summaryBounds || !cardBounds) throw new Error('Missing card bounds');
    expect(summaryBounds.y + summaryBounds.height).toBeLessThanOrEqual(
      cardBounds.y + cardBounds.height,
    );
    await node.screenshot({
      path: testInfo.outputPath('structured-overview.png'),
    });

    await setViewport(page, 1.1);
    await expect(node.locator('iframe')).toHaveCount(0);
    await setViewport(page, 1.11);
    await expect(node.locator('[data-web-reading]')).toBeVisible();
    if (interactive) {
      await expect(node.getByRole('status')).toHaveText(
        'Could not initialize page interactions. Try again.',
      );
      await expect(node.locator('iframe')).toHaveCount(0);
      await node.screenshot({
        path: testInfo.outputPath('bootstrap-error.png'),
      });
      await node.getByRole('button', { name: 'Retry', exact: true }).click();
    }
    const frame = node.frameLocator('iframe');
    await expect(
      frame.getByRole('heading', { name: 'Full weekend itinerary' }),
    ).toBeVisible();
    await expect(node.locator('iframe')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms',
    );
    await expect(node.locator('iframe')).toHaveAttribute('inert', '');
    if (interactive) await expect(frame.locator('#state')).toHaveText('Friday');
    expect(runtimeRequests).toBe(interactive ? 2 : 0);

    await node.locator('[data-web-interaction-shield]').click();
    await expect(node.locator('iframe')).not.toHaveAttribute('inert');
    await frame.getByRole('button', { name: 'Choose Saturday' }).click();
    await expect(frame.locator('#state')).toHaveText('Saturday');
    expect(saves).toBe(interactive ? 1 : 0);
    await setViewport(page, 1.95);
    await expect(frame.locator('#state')).toHaveText('Saturday');
    expect(runtimeRequests).toBe(interactive ? 2 : 0);
    await node.screenshot({ path: testInfo.outputPath('reading.png') });

    await setViewport(page, 1.95, -5000);
    await expect(node.locator('iframe')).toHaveCount(0);
    await setViewport(page, 1.95);
    await expect(node.locator('iframe')).toHaveCount(1);
    if (interactive)
      await expect(frame.locator('#state')).toHaveText('Saturday');
    await setViewport(page, 1);
    // Reading hysteresis is retained until width drops below 480.
    await expect(node.locator('iframe')).toHaveCount(1);
    await setViewport(page, 0.9);
    await expect(node.locator('.preview-card')).toBeVisible();
    await expect(node.locator('iframe')).toHaveCount(0);
    await setViewport(page, 0.19);
    await expect(node.locator('.preview-card')).toHaveAttribute(
      'data-far',
      'true',
    );
    await expect(node.locator('.preview-card__summary ul')).toHaveCount(0);
    if (interactive) {
      failNextRuntime = true;
      await page.evaluate(async (id) => {
        const path = '/src/store/previewWorkspace/actions.ts';
        const { openPreviewNode } = (await import(
          path
        )) as typeof PreviewActions;
        openPreviewNode(id, { transient: false });
      }, nodeId);
      const preview = page.locator('[data-preview-active="true"]');
      await expect(preview.getByRole('status')).toHaveText(
        'Could not initialize page interactions. Try again.',
      );
      await expect(preview.locator('iframe')).toHaveCount(0);
      await preview.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(preview.frameLocator('iframe').locator('#state')).toHaveText(
        'Saturday',
      );
    }
    expect(errors).toEqual([]);
  });
}

test('bounds the lifecycle of twelve DOM-heavy interactive pages on one canvas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2800, height: 1600 });
  const definition = {
    protocolVersion: 1,
    ownerThreadId: 'e2e-web-load',
    state: {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      value: {},
    },
    bindings: [],
    actions: [],
  };
  let runtimeRequests = 0;
  await page.route('**/api/web/preview**', (route) =>
    route.fulfill({
      json: {
        label: 'Heavy page',
        summary: '- Overview only\n- Open to interact',
      },
    }),
  );
  await page.route('**/api/web/page**', (route) => {
    const nodeId = new URL(route.request().url()).searchParams.get('nodeId');
    return route.fulfill({
      json: {
        kind: 'html',
        src: `/api/interactive-views/fixture/${nodeId}/renderer`,
      },
    });
  });
  await page.route('**/api/interactive-views/*/*/runtime', (route) => {
    runtimeRequests += 1;
    const nodeId = route.request().url().split('/').at(-2);
    return route.fulfill({
      json: {
        resource: {
          nodeId,
          rendererArtifact: 'heavy.html',
          revision: 'v1',
          definition,
        },
        data: {},
      },
    });
  });
  await page.route('**/api/interactive-views/*/*/renderer', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><button id="counter">Count: 0</button>
        <div id="items">${'<div>Rendered item <span>Details</span></div>'.repeat(750)}</div>
        <script>
          let count = 0;
          document.querySelector('#counter').onclick = (event) => { event.target.textContent = 'Count: ' + ++count; };
          let tick = 0;
          function animate() {
            document.querySelector('#items').style.transform = 'translateX(' + (++tick % 5) + 'px)';
            requestAnimationFrame(animate);
          }
          requestAnimationFrame(animate);
        </script></body></html>`,
    }),
  );
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: Array.from({ length: 12 }, (_, index) => ({
            nodeType: 'web',
            data: {
              label: `Heavy page ${index}`,
              src: 'heavy.html',
              interactiveView: definition,
            },
            position: {
              x: 180 + (index % 4) * 600,
              y: 100 + Math.floor(index / 4) * 400,
            },
            size: { width: 580, height: 370 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-web-load' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await setViewport(page, 1);
  const frames = page.locator('[data-web-reading] iframe');
  await expect(frames).toHaveCount(12);
  for (let index = 0; index < 12; index += 1) {
    await expect(
      frames.nth(index).contentFrame().locator('#items > div'),
    ).toHaveCount(750);
  }
  await expect.poll(() => runtimeRequests).toBe(12);
  const intervals = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        let previous = performance.now();
        function sample(now: number) {
          samples.push(now - previous);
          previous = now;
          if (samples.length === 90) resolve(samples.sort((a, b) => a - b));
          else requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }),
  );
  const p95 = intervals[Math.floor(intervals.length * 0.95)];
  expect(p95).toBeLessThan(100);
  const timingPath = testInfo.outputPath('frame-timing.json');
  await writeFile(
    timingPath,
    JSON.stringify({
      pages: 12,
      contentElements: 18000,
      samples: 90,
      p95Ms: p95,
      responsivenessBudgetMs: 100,
    }),
  );
  await testInfo.attach('frame-timing.json', {
    path: timingPath,
    contentType: 'application/json',
  });
  const firstId = await page
    .locator('.react-flow__node-web')
    .first()
    .getAttribute('data-id');
  const first = page.locator(`.react-flow__node-web[data-id="${firstId}"]`);
  await first.locator('[data-web-interaction-shield]').click();
  await expect(first.locator('iframe')).not.toHaveAttribute('inert');
  const counter = first
    .frameLocator('iframe')
    .getByRole('button', { name: 'Count: 0' });
  await first.screenshot({ path: testInfo.outputPath('heavy-page.png') });
  await counter.click();
  await expect(first.frameLocator('iframe').getByRole('button')).toHaveText(
    'Count: 1',
  );
  await setViewport(page, 1, -10000);
  await expect(frames).toHaveCount(0);
  await setViewport(page, 0.5);
  await expect(frames).toHaveCount(0);
  await expect(page.locator('.preview-card')).toHaveCount(12);
  expect(runtimeRequests).toBe(12);
});
