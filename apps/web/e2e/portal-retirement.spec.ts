// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  expect,
  test as base,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

import { openNewCanvas, paneCenter } from './helpers';
import { parseHuabuClipboard } from '../src/utils/io/clipboard';

import type {
  GetCanvasResponse,
  GetNodeContentResponse,
  WorkspaceInfo,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

const retiredTypes = ['canvasRef', 'frameRef', 'nodeRef'];
const retiredControl = /\b(pin|unpin|pins|portal)\b/i;
const mutations = new WeakMap<Page, { pending: Set<Request>; last: number }>();

async function waitForWrites(page: Page) {
  // Canvas saves and preprocessing have independent debouncers; SSE prevents
  // using networkidle. Observe only completed mutations, without invoking saves.
  const started = Date.now();
  await expect
    .poll(() => {
      const state = mutations.get(page);
      return (
        (!state || state.pending.size === 0) &&
        Date.now() - Math.max(started, state?.last ?? 0) > 1800
      );
    })
    .toBe(true);
}

// Observe, rather than mock, every canvas request. Agent execution and remote
// browser requests are fail-closed; neither is needed by this acceptance suite.
const test = base.extend<{ audit: void }>({
  audit: [
    async ({ context }, use, testInfo) => {
      const errors: string[] = [];
      const requests: string[] = [];
      const forbidden: string[] = [];
      const failedResponses: unknown[] = [];
      const responseReads: Promise<void>[] = [];
      const baseURL = testInfo.project.use.baseURL;
      if (!baseURL) throw new Error('Acceptance requires an isolated baseURL');
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.origin !== new URL(baseURL).origin ||
          (request.method() === 'POST' &&
            url.pathname !== '/api/agent/threads/titles/query' &&
            /^\/api\/(agent(?:\/|$)|acp\/.*(?:prompt|run|invoke))/.test(
              url.pathname,
            ))
        ) {
          forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
          await route.abort();
          return;
        }
        if (url.pathname.startsWith('/api/'))
          requests.push(`${request.method()} ${url.pathname}`);
        if (
          /\/api\/canvas\/[^/]+\/(?:references|preview-scene)(?:\/|$)/.test(
            url.pathname,
          ) ||
          request.postData()?.includes('SET_PORTAL_NODE_PINS')
        )
          forbidden.push(request.url());
        await route.continue();
      });
      context.on('page', (page) => {
        const state = { pending: new Set<Request>(), last: Date.now() };
        mutations.set(page, state);
        page.on('request', (request) => {
          if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method())) {
            state.pending.add(request);
            state.last = Date.now();
          }
        });
        const finishRequest = (request: Request) => {
          if (state.pending.delete(request)) state.last = Date.now();
        };
        page.on('requestfinished', finishRequest);
        page.on('requestfailed', finishRequest);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('response', (response) => {
          if (response.status() >= 400) {
            errors.push(`${response.status()} ${response.url()}`);
            responseReads.push(
              response
                .text()
                .then((body) => {
                  failedResponses.push({
                    url: response.url(),
                    status: response.status(),
                    request: response.request().postData(),
                    body,
                  });
                })
                .catch(() => {}),
            );
          }
        });
      });
      await context.addInitScript(() => {
        if (location.protocol !== 'http:' && location.protocol !== 'https:')
          return;
        if (!localStorage.getItem('huabu-sketch-tools')) {
          localStorage.setItem(
            'huabu-sketch-tools',
            JSON.stringify({
              state: { inputModePreference: 'mouse' },
              version: 0,
            }),
          );
        }
      });
      await use();
      await Promise.all(responseReads);
      await testInfo.attach('browser-audit', {
        body: JSON.stringify(
          { requests, forbidden, errors, failedResponses },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      expect(
        forbidden,
        'No retired API, preview scene, remote service, or Agent execution',
      ).toEqual([]);
      expect(errors, 'No browser errors or failed HTTP responses').toEqual([]);
    },
    { auto: true },
  ],
});

function canvasId(page: Page): string {
  const id = new URL(page.url()).pathname.split('/canvas/')[1];
  expect(id).toBeTruthy();
  return id;
}

async function snapshot(page: Page, id: string) {
  const response = await page.request.get(`/api/canvas/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  const state = record.state as { nodes: Node[]; edges: unknown[] };
  expect(
    state.nodes.filter((node) => retiredTypes.includes(node.type ?? '')),
  ).toEqual([]);
  return { ...record, state };
}

async function workspaceInfo(page: Page) {
  const response = await page.request.get('/api/workspace');
  expect(response.ok()).toBe(true);
  return (await response.json()) as WorkspaceInfo;
}

async function goToWorld(page: Page) {
  await waitForWrites(page);
  const info = await workspaceInfo(page);
  expect(info.worldCanvasId).toBeTruthy();
  await page.goto(`/canvas/${info.worldCanvasId}`);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  return info.worldCanvasId!;
}

async function assertNoRetiredControls(page: Page) {
  await expect(page.getByRole('button', { name: retiredControl })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('menuitem', { name: retiredControl }),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '.react-flow__node-canvasRef, .react-flow__node-frameRef, .react-flow__node-nodeRef',
    ),
  ).toHaveCount(0);
}

async function pasteNote(page: Page, content: string) {
  const center = await paneCenter(page);
  await page.mouse.move(center.x, center.y);
  // Reuse the existing note-auto-height suite's browser ClipboardEvent path.
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    document.body.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, content);
  const note = page
    .locator('.react-flow__node-note')
    .filter({ hasText: content.split('\n')[0] })
    .last();
  await expect(note).toBeVisible();
  await expect(note.locator('.ProseMirror')).toContainText(
    content.split('\n')[0],
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await waitForWrites(page);
  return note;
}

async function contentOf(page: Page, id: string, nodeId: string) {
  const response = await page.request.get(
    `/api/canvas/${id}/nodes/${nodeId}/content`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as GetNodeContentResponse;
}

async function drag(
  page: Page,
  locator: Locator,
  dx: number,
  dy: number,
  offsetY?: number,
) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Drag target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + (offsetY ?? box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 14 });
  await page.mouse.up();
}

test('World membership, Open Space, shortcut metadata refresh, and test-Space deletion', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  const sourceId = canvasId(page);
  const note = await pasteNote(
    page,
    'Portal retirement source\n\nBefore refresh marker',
  );
  const noteId = (await note.getAttribute('data-id'))!;
  await expect
    .poll(async () => (await contentOf(page, sourceId, noteId)).content)
    .toContain('Before refresh marker');
  const sourceTitle = (await snapshot(page, sourceId)).title;
  await openNewCanvas(page);
  const secondId = canvasId(page);
  const worldId = await goToWorld(page);
  const world = await snapshot(page, worldId);
  const ordinary = await (await page.request.get('/api/canvas')).json();
  const targets = world.state.nodes.filter(
    (node) => node.type === 'spacePreview',
  );
  expect(targets.map((node) => node.data.targetCanvasId).sort()).toEqual(
    ordinary.canvases
      .map((space: { canvasId: string }) => space.canvasId)
      .sort(),
  );
  expect(new Set(targets.map((node) => node.data.targetCanvasId)).size).toBe(
    targets.length,
  );
  const previewId = targets.find(
    (node) => node.data.targetCanvasId === sourceId,
  )!.id;
  const preview = page.locator(`.react-flow__node[data-id="${previewId}"]`);
  const body = preview.locator('[data-space-shortcut]');
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await expect(body).toContainText(sourceTitle);
  await expect(body.locator('[data-space-shortcut-summary]')).toContainText(
    '1 node',
  );
  await expect(preview).not.toContainText('Before refresh marker');
  await expect(preview.locator('[data-preview-adaptive-text]')).toHaveCount(0);
  await expect(
    preview.locator(
      '.ProseMirror, textarea, [contenteditable="true"], .react-flow__node',
    ),
  ).toHaveCount(0);
  await assertNoRetiredControls(page);
  await page.getByRole('button', { name: 'Add Content', exact: true }).click();
  await expect(
    page.getByText('Add Space Shortcut', { exact: true }),
  ).toHaveCount(0);
  await assertNoRetiredControls(page);
  await page.keyboard.press('Escape');
  await body.click();
  await page.getByRole('button', { name: 'Open Space', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/canvas/${sourceId}$`));
  await expect(page.locator('.react-flow__node-note')).toContainText(
    'Before refresh marker',
  );

  // Refresh target metadata on focus without projecting source content.
  await goToWorld(page);
  const source = await page.context().newPage();
  await source.goto(`/canvas/${sourceId}`);
  await source.locator('.react-flow__node-note').dblclick();
  const editor = source.locator(
    '.ProseMirror[contenteditable="true"]:not([aria-readonly="true"])',
  );
  await expect(editor).toBeVisible();
  await editor.fill('After refresh marker: edited in the real source Note.');
  await expect
    .poll(async () => (await contentOf(source, sourceId, noteId)).content)
    .toContain('After refresh marker');
  await source.keyboard.press('Escape');
  await source
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 100 } });
  await pasteNote(source, 'Second source note\n\nMetadata refresh marker');
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(body.locator('[data-space-shortcut-summary]')).toContainText(
    '2 nodes',
  );
  await expect(preview).not.toContainText('After refresh marker');
  await expect(preview.locator('[data-preview-adaptive-text]')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('world-shortcut-metadata-update.png'),
  });
  await source.close();

  await waitForWrites(page);
  await page.goto('/');
  const card = page.locator(`a[href="/canvas/${sourceId}"]`).locator('..');
  await card.hover();
  await card.getByRole('button', { name: 'Delete Space', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.locator(`a[href="/canvas/${sourceId}"]`)).toHaveCount(0);
  await goToWorld(page);
  await expect(
    page.locator(`.react-flow__node[data-id="${previewId}"]`),
  ).toHaveCount(0);
  const remaining = (await snapshot(page, worldId)).state.nodes.filter(
    (node) => node.type === 'spacePreview',
  );
  expect(remaining.some((node) => node.data.targetCanvasId === sourceId)).toBe(
    false,
  );
  expect(
    remaining.filter((node) => node.data.targetCanvasId === secondId),
  ).toHaveLength(1);
  await waitForWrites(page);
  await page.reload();
  await expect(
    page.locator(`.react-flow__node[data-id="${previewId}"]`),
  ).toHaveCount(0);
  await assertNoRetiredControls(page);
  testInfo.annotations.push({
    type: 'functional-checks',
    description:
      'Membership, shortcut metadata, Open Space, source-content isolation, deletion and reload completed without scene requests.',
  });
});

test('World shortcut move, horizontal resize, reload, and source isolation', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  const sourceId = canvasId(page);
  await pasteNote(page, 'Geometry acceptance\n\nStatic scene marker');
  const worldId = await goToWorld(page);
  const initial = (await snapshot(page, worldId)).state.nodes.find(
    (node) => node.data.targetCanvasId === sourceId,
  )!;
  const sourceBefore = await snapshot(page, sourceId);
  const preview = page.locator(`.react-flow__node[data-id="${initial.id}"]`);
  const body = preview.locator('[data-space-shortcut]');
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  await page
    .getByRole('button', { name: /Canvas zoom .*Open zoom menu/ })
    .click();
  await page.getByRole('menuitem', { name: 'Reset zoom to 100%' }).click();
  await drag(page, body, 80, 45);
  await expect
    .poll(
      async () =>
        (await snapshot(page, worldId)).state.nodes.find(
          (node) => node.id === initial.id,
        )!.position,
    )
    .not.toEqual(initial.position);
  const moved = (await snapshot(page, worldId)).state.nodes.find(
    (node) => node.id === initial.id,
  )!;
  await body.click();
  await expect(preview.locator('.node-resize-edge')).toHaveCount(2);
  await expect(preview.locator('.node-resize-corner')).toHaveCount(0);
  const handle = preview.locator('.node-resize-edge.right');
  await expect(handle).toBeVisible();
  await drag(page, handle, 90, 0, 20);
  await expect
    .poll(
      async () =>
        (await snapshot(page, worldId)).state.nodes.find(
          (node) => node.id === initial.id,
        )!.style,
    )
    .not.toEqual(moved.style);
  const resized = (await snapshot(page, worldId)).state.nodes.find(
    (node) => node.id === initial.id,
  )!;
  expect(Number(resized.style!.width)).toBeGreaterThan(
    Number(moved.style!.width),
  );
  expect(resized.data.widthMode).toBe('fixed');
  expect(resized.style?.height).toBeUndefined();
  await waitForWrites(page);
  await page.reload();
  await expect(body).toHaveAttribute('data-target-status', 'ready');
  const persisted = (await snapshot(page, worldId)).state.nodes.find(
    (node) => node.id === initial.id,
  )!;
  expect({ position: persisted.position, style: persisted.style }).toEqual({
    position: resized.position,
    style: resized.style,
  });
  await expect(preview).toHaveCSS('width', `${resized.style!.width}px`);
  expect(
    await preview.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(138);
  await expect(preview.getByRole('application')).toHaveCount(0);
  await expect(preview.locator('[data-preview-adaptive-text]')).toHaveCount(0);
  expect(await snapshot(page, sourceId)).toEqual(sourceBefore);
  await assertNoRetiredControls(page);
  await page.screenshot({
    path: testInfo.outputPath('shortcut-persisted-geometry.png'),
  });
  testInfo.annotations.push({
    type: 'functional-checks',
    description:
      'Move, horizontal resize, fixed width reload, compact height and unchanged source state completed without a nested viewport.',
  });
});

test('ordinary Note and Frame create, move, copy/paste, delete/undo, reload', async ({
  page,
  context,
}, testInfo) => {
  await openNewCanvas(page);
  // A fresh automation context does not inherit the user's clipboard grant.
  // Limit permission to this test's disposable origin, not every browser site.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const id = canvasId(page);
  const note = await pasteNote(
    page,
    'Ordinary note acceptance\n\nCopy and undo marker',
  );
  const noteId = (await note.getAttribute('data-id'))!;
  await expect
    .poll(async () => (await snapshot(page, id)).state.nodes.length)
    .toBe(1);
  const initial = (await snapshot(page, id)).state.nodes[0];
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 100 } });
  await drag(page, note, -130, -90);
  await expect
    .poll(
      async () =>
        (await snapshot(page, id)).state.nodes.find(
          (node) => node.id === noteId,
        )!.position,
    )
    .not.toEqual(initial.position);
  await page.getByRole('button', { name: /^Frame/ }).click();
  await expect(page.locator('.canvas-pending-frame').first()).toBeVisible();
  const center = await paneCenter(page);
  // Start on empty canvas, away from the selected Note's floating toolbar.
  await page.mouse.move(center.x - 430, center.y - 230);
  await page.mouse.down();
  await page.mouse.move(center.x - 200, center.y - 70, { steps: 12 });
  await page.mouse.up();
  const frame = page.locator('.react-flow__node-frame');
  await expect(frame).toHaveCount(1);
  await page.keyboard.press('s');
  const frameId = (await frame.getAttribute('data-id'))!;
  await expect
    .poll(async () => (await snapshot(page, id)).state.nodes.length)
    .toBe(2);
  const frameBefore = (await snapshot(page, id)).state.nodes.find(
    (node) => node.id === frameId,
  )!;
  await drag(page, frame, 30, 70, 20);
  await expect
    .poll(
      async () =>
        (await snapshot(page, id)).state.nodes.find(
          (node) => node.id === frameId,
        )!.position,
    )
    .not.toEqual(frameBefore.position);
  await assertNoRetiredControls(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 100 } });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  // Reuse canvas-mouse.spec.ts's two-node marquee, not browser select-all.
  const noteBox = await note.boundingBox();
  const frameBox = await frame.boundingBox();
  if (!noteBox || !frameBox) throw new Error('Nodes have no bounding box');
  const left = Math.min(noteBox.x, frameBox.x) - 50;
  const top = Math.min(noteBox.y, frameBox.y) - 50;
  const right =
    Math.max(noteBox.x + noteBox.width, frameBox.x + frameBox.width) + 50;
  const bottom =
    Math.max(noteBox.y + noteBox.height, frameBox.y + frameBox.height) + 50;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 14 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  // Clear stale clipboard data only; the application must produce the payload.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('');
  await page.keyboard.press('ControlOrMeta+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Ordinary note acceptance\n\nCopy and undo marker\n\nFrame');
  // The native write is atomic: readable text and the node-bearing HTML share
  // one ClipboardItem. Require HTML, rather than accepting the denied fallback.
  const encodedPayload = await page.evaluate(async () => {
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('text/html')) continue;
      const html = await (await item.getType('text/html')).text();
      return new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('[data-huabu-nodes]')
        ?.getAttribute('data-huabu-nodes');
    }
    return null;
  });
  if (!encodedPayload) throw new Error('Native copy has no Huabu HTML payload');
  const clipboardText = Buffer.from(encodedPayload, 'base64').toString('utf8');
  expect(parseHuabuClipboard(clipboardText)).toMatchObject({
    srcCanvasId: id,
    nodes: expect.arrayContaining([
      expect.objectContaining({ id: noteId, type: 'note' }),
      expect.objectContaining({ id: frameId, type: 'frame' }),
    ]),
  });
  expect(parseHuabuClipboard(clipboardText)?.nodes).toHaveLength(2);
  expect(clipboardText).toContain('Copy and undo marker');
  await testInfo.attach('native-selection-clipboard', {
    body: clipboardText,
    contentType: 'application/json',
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
  await expect(page.locator('.react-flow__node-frame')).toHaveCount(2);
  await expect
    .poll(async () => (await snapshot(page, id)).state.nodes.length)
    .toBe(4);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await waitForWrites(page);
  const copied = await snapshot(page, id);
  for (const node of copied.state.nodes.filter(
    (node) => node.type === 'note',
  )) {
    await expect
      .poll(async () => (await contentOf(page, id, node.id)).content)
      .toContain('Copy and undo marker');
  }
  testInfo.annotations.push({
    type: 'clipboard-checks',
    description:
      'Origin-scoped clipboard permissions; focused native copy produced the current Space and exact selected Note/Frame payload after clearing stale data; native paste created two Notes/two Frames, selected the copied pair, and persisted both Note bodies before deletion.',
  });
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect
    .poll(async () =>
      (await snapshot(page, id)).state.nodes.map((node) => node.id).sort(),
    )
    .toEqual([noteId, frameId].sort());
  await waitForWrites(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect
    .poll(async () =>
      (await snapshot(page, id)).state.nodes.map((node) => node.id).sort(),
    )
    .toEqual(copied.state.nodes.map((node) => node.id).sort());
  await waitForWrites(page);
  const beforeReload = await snapshot(page, id);
  await page.reload();
  await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
  await expect(page.locator('.react-flow__node-frame')).toHaveCount(2);
  await assertNoRetiredControls(page);
  await page.screenshot({
    path: testInfo.outputPath('ordinary-frame-note-roundtrip.png'),
  });
  testInfo.annotations.push({
    type: 'functional-steps',
    description:
      'Note/Frame create, move, marquee select, native keyboard copy/paste, persisted copied Note bodies, delete, undo and reload executed; final geometry/content assertions follow.',
  });
  for (const node of beforeReload.state.nodes) {
    const current = (await snapshot(page, id)).state.nodes.find(
      (candidate) => candidate.id === node.id,
    )!;
    expect({
      type: current.type,
      position: current.position,
      style: current.style,
    }).toEqual({ type: node.type, position: node.position, style: node.style });
    if (node.type === 'note') {
      const content = await contentOf(page, id, node.id);
      await testInfo.attach(`reloaded-note-${node.id}`, {
        body: JSON.stringify(content, null, 2),
        contentType: 'application/json',
      });
      expect(
        content.content,
        `Reloaded Note ${node.id} retains its body`,
      ).toContain('Copy and undo marker');
    }
  }
  testInfo.annotations.push({
    type: 'functional-checks',
    description:
      'Note/Frame creation, movement, native keyboard copy/paste, delete/undo, content and geometry reload completed.',
  });
});

test('isolation evidence points to this worktree and disposable storage', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const meta = testInfo.config.metadata;
  const info = await workspaceInfo(page);
  const registry = JSON.parse(
    readFileSync(join(meta.dataDir, 'storage/disk/workspaces.json'), 'utf8'),
  );
  expect(JSON.stringify(registry)).toContain(meta.workspace);
  const world = JSON.parse(
    readFileSync(join(meta.workspace, '.world/space.json'), 'utf8'),
  );
  expect(world.canvasId).toBe(info.worldCanvasId);
  const processes = [meta.serverPort, meta.webPort].map((port: string) => {
    const pid = execFileSync('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
    const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    expect(cwd.split('\n')).toContain(
      `n${realpathSync(
        join(
          meta.repoRoot,
          port === meta.serverPort ? 'apps/server' : 'apps/web',
        ),
      )}`,
    );
    return { port, pid, cwd };
  });
  await testInfo.attach('isolation-proof', {
    body: JSON.stringify(
      { ...meta, workspaceInfo: info, registry, processes },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
