// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * A reload the sync layer asks for does not take the page away from the
 * person using it.
 *
 * A text node keeps what is typed in its control until the control loses
 * focus, so nothing is "unsaved" yet as far as the content queue knows. This
 * spec types into one, then makes the page fall behind the server (its
 * stream is cut while another client moves a note, so the reconnect snapshot
 * does not match) and checks that
 *
 *  - the reload waits while the control has focus: the typed text and the
 *    caret stay, and the Space is not fetched;
 *  - when the control is left, the text is saved and the reload then runs
 *    **in place**: the canvas element is the same element throughout (the
 *    page is never swapped for the loading surface), the viewport is where
 *    the person left it, and the other client's move is shown.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const NOTE = 'node-reload-note';
const TEXT = 'node-reload-text';
const VIEWPORT = { x: 40, y: 30, zoom: 1 };

async function seedSpace(request: APIRequestContext): Promise<string> {
  const created = await request.post('/api/canvas', {
    data: { title: 'Reload while editing' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: NOTE,
              nodeType: 'note',
              data: {
                type: 'note',
                label: 'A note',
                labelSource: 'user',
                content: 'Seed body',
              },
              selectOnCreate: false,
              position: { x: 420, y: 90 },
              size: { width: 300, height: 200 },
            },
            {
              id: TEXT,
              nodeType: 'text',
              data: { type: 'text', content: 'Seed text' },
              selectOnCreate: false,
              position: { x: 60, y: 420 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-reload-editing-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

/** Cut and restore the page's sync stream, as a lost connection does. */
async function interceptSyncStream(context: BrowserContext) {
  await context.addInitScript(() => {
    if (window !== window.top) return;
    const realFetch = window.fetch.bind(window);
    const open = new Set<AbortController>();
    const control = {
      blocked: false,
      drop: () => {
        control.blocked = true;
        for (const controller of open) controller.abort();
        open.clear();
      },
      restore: () => {
        control.blocked = false;
      },
    };
    (window as unknown as { __syncStream: typeof control }).__syncStream =
      control;
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes('/sync/stream')) return realFetch(input, init);
      if (control.blocked)
        return Promise.reject(new TypeError('Failed to fetch'));
      const controller = new AbortController();
      init?.signal?.addEventListener('abort', () => controller.abort());
      open.add(controller);
      return realFetch(input, { ...init, signal: controller.signal });
    };
  });
}

interface Device {
  context: BrowserContext;
  page: Page;
  /** `GET /api/canvas/:id` requests: loads of the whole Space. */
  spaceLoads: () => number;
}

async function openDevice(browser: Browser, canvasId: string): Promise<Device> {
  const context = await browser.newContext();
  await interceptSyncStream(context);
  await context.addInitScript(
    ({ canvasId, viewport }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify(viewport),
      );
    },
    { canvasId, viewport: VIEWPORT },
  );
  const page = await context.newPage();
  let spaceLoads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === `/api/canvas/${canvasId}`
    )
      spaceLoads += 1;
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${TEXT}"]`)).toBeVisible();
  // Remember the canvas element, and notice if it ever leaves the document
  // or reports itself busy: either is the loading surface taking its place.
  await page.evaluate(() => {
    const root = document.querySelector('[data-canvas-root]');
    const seen = { root, detached: false, busy: false };
    (window as unknown as { __canvas: typeof seen }).__canvas = seen;
    new MutationObserver(() => {
      if (!root?.isConnected) seen.detached = true;
      if (root?.getAttribute('aria-busy') === 'true') seen.busy = true;
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy'],
    });
  });
  return { context, page, spaceLoads: () => spaceLoads };
}

async function canvasElement(page: Page) {
  return page.evaluate(() => {
    const seen = (
      window as unknown as {
        __canvas: { root: Element | null; detached: boolean; busy: boolean };
      }
    ).__canvas;
    return {
      detached: seen.detached,
      busy: seen.busy,
      same: document.querySelector('[data-canvas-root]') === seen.root,
    };
  });
}

async function shown(page: Page) {
  return page.evaluate(
    async ({ note, text }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasStore;
      const state = store.getState();
      const find = (id: string) => state.nodes.find((node) => node.id === id);
      return {
        version: state.version,
        isLoading: state.isLoading,
        viewport: state.viewport,
        notePosition: find(note)?.position,
        textContent: (find(text)?.data as { content?: string } | undefined)
          ?.content,
      };
    },
    { note: NOTE, text: TEXT },
  );
}

async function serverRecord(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    version: number;
    state: {
      nodes: Array<{
        id: string;
        position: { x: number; y: number };
        data: { content?: string };
      }>;
    };
  };
  return {
    version: record.version,
    node: (id: string) => record.state.nodes.find((node) => node.id === id),
  };
}

test('a reload wanted while a text node is being typed into waits for the control, then refreshes the Space in place', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const canvasId = await seedSpace(request);
  const device = await openDevice(browser, canvasId);
  const { page } = device;
  // Let load-time measurement reports settle.
  await page.waitForTimeout(1_500);
  await expect
    .poll(async () => (await shown(page)).version)
    .toBe((await serverRecord(request, canvasId)).version);
  const loadsBefore = device.spaceLoads();

  // The person starts typing into the text node and does not leave it.
  const text = page.locator(`.react-flow__node[data-id="${TEXT}"]`);
  await text.dblclick();
  const control = text.locator('textarea');
  await expect(control).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' — typed and not left');
  const typed = await control.inputValue();
  expect(typed).toContain('typed and not left');
  // Nothing of it is in the store yet: it lives in the control.
  expect((await shown(page)).textContent).toBe('Seed text');

  // The page falls behind: its stream is down while another client moves
  // the note, and the reconnect snapshot names a version it does not have.
  const dropped = page.waitForEvent('console', {
    predicate: (message) =>
      message.text().includes('[canvasSync] reconnecting after stream failure'),
  });
  await page.evaluate(() =>
    (
      window as unknown as { __syncStream: { drop: () => void } }
    ).__syncStream.drop(),
  );
  await dropped;
  const moved = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: NOTE, position: { x: 420, y: 520 } }],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-reload-editing-other' },
    },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  const reconnected = page.waitForResponse(
    (response) => response.url().includes('/sync/stream') && response.ok(),
  );
  await page.evaluate(() =>
    (
      window as unknown as { __syncStream: { restore: () => void } }
    ).__syncStream.restore(),
  );
  await reconnected;

  // The reload is wanted now. It waits: the control keeps focus and text,
  // the Space is not fetched, and the page is not replaced.
  await page.waitForTimeout(3_000);
  await expect(control).toBeFocused();
  expect(await control.inputValue()).toBe(typed);
  expect(device.spaceLoads()).toBe(loadsBefore);
  expect(await canvasElement(page)).toEqual({
    detached: false,
    busy: false,
    same: true,
  });
  expect((await shown(page)).notePosition).toEqual({ x: 420, y: 90 });
  // Typing goes on working meanwhile.
  await page.keyboard.type('!');
  expect(await control.inputValue()).toBe(`${typed}!`);

  // The person leaves the control: the text is committed and saved, and
  // only then is the Space refreshed.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(TEXT)?.data.content,
      { timeout: 15_000 },
    )
    .toBe(`${typed}!`);
  await expect
    .poll(async () => (await shown(page)).notePosition, { timeout: 15_000 })
    .toEqual({ x: 420, y: 520 });
  expect(device.spaceLoads()).toBe(loadsBefore + 1);

  // In place: the same canvas element, never detached, never busy; the
  // view has not jumped; the typed text is what the page shows.
  const after = await shown(page);
  expect(after.isLoading).toBe(false);
  expect(after.textContent).toBe(`${typed}!`);
  expect(after.viewport).toEqual(VIEWPORT);
  expect(after.version).toBe((await serverRecord(request, canvasId)).version);
  expect(await canvasElement(page)).toEqual({
    detached: false,
    busy: false,
    same: true,
  });
  await expect(text).toBeVisible();
  await expect(page.locator(`[data-id="${NOTE}"]`)).toBeVisible();

  await device.context.close();
});
