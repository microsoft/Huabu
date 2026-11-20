// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Route,
} from '@playwright/test';

import { openNewCanvas, paneCenter, personEdits } from './helpers';

import type { ArtifactUploadResponse, GetCanvasResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

// Real UI and persistence; only explicitly gated preprocessing responses are
// synthetic. Never import the store or invoke lifecycle methods from the page.
const writes = new WeakMap<Page, { pending: Set<Request>; last: number }>();
const errors = new WeakMap<Page, string[]>();
const injectedFailures = new WeakMap<Page, Set<Request>>();
const expectedDiagnostics = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, context }, testInfo) => {
  const state = { pending: new Set<Request>(), last: Date.now() };
  writes.set(page, state);
  errors.set(page, []);
  injectedFailures.set(page, new Set());
  expectedDiagnostics.set(page, []);
  page.on('request', (request) => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method())) {
      state.pending.add(request);
      state.last = Date.now();
    }
  });
  const finished = (request: Request) => {
    if (state.pending.delete(request)) state.last = Date.now();
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  page.on('pageerror', (error) => errors.get(page)?.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const injected = [...(injectedFailures.get(page) ?? [])].some(
      (request) => request.url() === message.location().url,
    );
    const injectedSaveFailure = [...(injectedFailures.get(page) ?? [])].some(
      (request) => {
        const nodeId = new URL(request.url()).pathname
          .split('/nodes/')[1]
          ?.split('/')[0];
        return (
          !!nodeId &&
          message
            .text()
            .startsWith(
              `Node content save failed: ${nodeId} ApiError: Failed to save node content`,
            ) &&
          message
            .location()
            .url.includes('/store/canvasStore/save/nodeContentQueue.ts')
        );
      },
    );
    if (
      injectedSaveFailure ||
      (injected &&
        message.text() ===
          'Failed to load resource: the server responded with a status of 503 (Service Unavailable)')
    ) {
      expectedDiagnostics.get(page)?.push(message.text());
    } else errors.get(page)?.push(message.text());
  });
  page.on('response', (response) => {
    if (
      response.status() === 503 &&
      injectedFailures.get(page)?.has(response.request())
    ) {
      expectedDiagnostics.get(page)?.push(`Injected 503 ${response.url()}`);
      return;
    }
    if (response.status() >= 400)
      errors.get(page)?.push(`${response.status()} ${response.url()}`);
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== new URL(String(testInfo.project.use.baseURL)).origin ||
      (route.request().method() === 'POST' &&
        url.pathname !== '/api/agent/threads/titles/query' &&
        /^\/api\/(agent(?:\/|$)|acp\/.*(?:prompt|run|invoke))/.test(
          url.pathname,
        ))
    ) {
      errors.get(page)?.push(`Forbidden request: ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await context.addInitScript(() => {
    if (location.protocol.startsWith('http'))
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
      );
  });
});

test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach('browser-errors', {
    body: JSON.stringify(errors.get(page)),
    contentType: 'application/json',
  });
  await testInfo.attach('expected-fault-diagnostics', {
    body: JSON.stringify(expectedDiagnostics.get(page)),
    contentType: 'application/json',
  });
  expect(errors.get(page)).toEqual([]);
});

async function quiet(page: Page) {
  const start = Date.now();
  await expect
    .poll(() => {
      const state = writes.get(page);
      return (
        !!state &&
        state.pending.size === 0 &&
        Date.now() - Math.max(start, state.last) > 1800
      );
    })
    .toBe(true);
}

async function observeNoNewRequests(count: () => number, expected: number) {
  const start = Date.now();
  await expect
    .poll(() => {
      expect(count()).toBe(expected);
      return Date.now() - start;
    })
    .toBeGreaterThan(1800);
}

function idOf(page: Page) {
  return new URL(page.url()).pathname.split('/canvas/')[1];
}

function pending(node: Locator) {
  return node.locator('.absolute.right-1\\.5.bottom-1\\.5');
}

async function body(page: Page, nodeId: string) {
  const response = await page.request.get(
    `/api/canvas/${idOf(page)}/nodes/${nodeId}/content`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).content as string;
}

async function noteFixture(page: Page) {
  await openNewCanvas(page);
  const center = await paneCenter(page);
  await page.mouse.move(center.x, center.y);
  // Existing acceptance suites use a browser clipboard event for paste.
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'Lifecycle original\n\nInitial body');
    document.body.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const note = page.locator('.react-flow__node-note').last();
  await expect(note).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await quiet(page);
  const nodeId = await note.getAttribute('data-id');
  if (!nodeId) throw new Error('Missing node identity');
  return { note, nodeId };
}

async function editNote(
  page: Page,
  note: Locator,
  text: string,
  settle = true,
) {
  await note.dblclick();
  const editor = page.locator(
    '[data-search-scope="node"] .ProseMirror[contenteditable="true"]',
  );
  await expect(editor).toBeVisible();
  await editor.fill(text);
  if (settle) await closeNote(page);
}

async function closeNote(page: Page) {
  await page
    .getByRole('tab', { selected: true })
    .getByRole('button', { name: /^Close / })
    .click();
}

async function remove(page: Page, node: Locator) {
  await node.click();
  await expect(node).toHaveClass(/selected/);
  await page.keyboard.press('Backspace');
  await expect(node).toHaveCount(0);
}

async function holdPreprocessing(page: Page, nodeId: string) {
  const held: Route[] = [];
  await page.route(`**/nodes/${nodeId}/preprocess`, (route) => {
    held.push(route);
  });
  return held;
}

async function succeed(route: Route, label: string) {
  await route.fulfill({ json: { success: true, suggestedLabel: label } });
}

test('Note close settles, typing invalidates a delayed result, and later settle survives reload', async ({
  page,
}) => {
  const { note, nodeId } = await noteFixture(page);
  const held = await holdPreprocessing(page, nodeId);
  await editNote(page, note, 'Lifecycle input A');
  await expect.poll(() => held.length).toBe(1);
  expect(held[0].request().postDataJSON().snapshot.content).toContain(
    'Lifecycle input A',
  );
  await expect(pending(note)).toBeVisible();
  await editNote(page, note, 'Lifecycle input B', false);
  await expect.poll(() => body(page, nodeId)).toContain('Lifecycle input B');
  await succeed(held[0], 'OBSOLETE RESULT A');
  await expect(pending(note)).toHaveCount(0);
  await expect(note).not.toContainText('OBSOLETE RESULT A');
  await observeNoNewRequests(() => held.length, 1);
  await closeNote(page);
  await expect.poll(() => held.length).toBe(2);
  expect(held[1].request().postDataJSON().snapshot.content).toContain(
    'Lifecycle input B',
  );
  await succeed(held[1], 'Current result B');
  await expect(pending(note)).toHaveCount(0);
  await expect(note).toContainText('Current result B');
  await quiet(page);
  await page.reload();
  await expect(page.locator(`[data-id="${nodeId}"]`)).toContainText(
    'Lifecycle input B',
  );
  expect(await body(page, nodeId)).toContain('Lifecycle input B');
});

test('new Note settle while the restore is being sent waits and resumes with latest body', async ({
  page,
}) => {
  const { note, nodeId } = await noteFixture(page);
  await remove(page, note);
  await quiet(page);
  // The undo brings the note back, body included, in one execute request.
  const restores: Route[] = [];
  await page.route('**/api/canvas/*/execute', async (route) => {
    if (route.request().method() === 'POST' && restores.length === 0)
      restores.push(route);
    else await route.continue();
  });
  const held = await holdPreprocessing(page, nodeId);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note).toBeVisible();
  await expect.poll(() => restores.length).toBe(1);
  expect(JSON.stringify(restores[0].request().postDataJSON())).toContain(
    'RESTORE_NODES',
  );
  await editNote(page, note, 'Edited while restore is saving');
  await expect(pending(note)).toBeVisible();
  // The server has no such node yet: nothing is preprocessed for it.
  await observeNoNewRequests(() => held.length, 0);
  await restores[0].continue();
  await expect.poll(() => held.length).toBe(1);
  expect(held[0].request().postDataJSON().snapshot.content).toContain(
    'Edited while restore is saving',
  );
  await succeed(held[0], 'Restored latest result');
  await expect(pending(note)).toHaveCount(0);
  await quiet(page);
  expect(await body(page, nodeId)).toContain('Edited while restore is saving');
  await page.reload();
  await expect(page.locator(`[data-id="${nodeId}"]`)).toContainText(
    'Edited while restore is saving',
  );
});

test('a failing restore retains fresh work until the restore is sent', async ({
  page,
}, testInfo) => {
  const { note, nodeId } = await noteFixture(page);
  await remove(page, note);
  await quiet(page);
  let failWrites = true;
  let failedWrites = 0;
  let successfulWrites = 0;
  await page.route('**/api/canvas/*/execute', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (failWrites) {
      injectedFailures.get(page)?.add(route.request());
      failedWrites += 1;
      await route.fulfill({
        status: 503,
        json: { error: 'Acceptance: restore temporarily unavailable' },
      });
    } else {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      successfulWrites += 1;
      await route.fulfill({ response });
    }
  });
  const held = await holdPreprocessing(page, nodeId);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note).toBeVisible();
  await expect.poll(() => failedWrites).toBeGreaterThan(0);
  // The page says so and keeps trying on its own; there is nothing to click.
  await expect(
    page.getByText('Your changes are not synced yet. Trying again…'),
  ).toBeVisible();
  await editNote(page, note, 'Latest body retained through save failure');
  await expect(pending(note)).toBeVisible();
  // Neither the body nor the preprocessing is sent for a node the server
  // does not have.
  await observeNoNewRequests(() => held.length, 0);
  expect(held).toHaveLength(0);
  expect(successfulWrites).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('blocked-before-restore.png'),
  });
  failWrites = false;
  await expect
    .poll(() => successfulWrites, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => held.length).toBe(1);
  expect(held[0].request().postDataJSON().snapshot.content).toContain(
    'Latest body retained through save failure',
  );
  await succeed(held[0], 'Retry recovered result');
  await expect(pending(note)).toHaveCount(0);
  await expect(
    page.getByText('Your changes are not synced yet. Trying again…'),
  ).toHaveCount(0);
  await quiet(page);
  expect(held).toHaveLength(1);
  expect(await body(page, nodeId)).toContain(
    'Latest body retained through save failure',
  );
  await page.reload();
  await expect(page.locator(`[data-id="${nodeId}"]`)).toContainText(
    'Latest body retained through save failure',
  );
  expect(await body(page, nodeId)).toContain(
    'Latest body retained through save failure',
  );
});

test('unfinished deletion drains old response and rapid undo/redo resumes only the final restoration', async ({
  page,
}) => {
  const { note, nodeId } = await noteFixture(page);
  const held = await holdPreprocessing(page, nodeId);
  await editNote(page, note, 'Unfinished deletion body');
  await expect.poll(() => held.length).toBe(1);
  await remove(page, note);
  await succeed(held[0], 'DELETED OLD RESULT');
  await quiet(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(note).toHaveCount(0);
  await quiet(page);
  expect(held).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note).toBeVisible();
  await expect.poll(() => held.length).toBe(2);
  expect(held[1].request().postDataJSON().snapshot.content).toContain(
    'Unfinished deletion body',
  );
  await expect(note).not.toContainText('DELETED OLD RESULT');
  await succeed(held[1], 'Final restored result');
  await expect(pending(note)).toHaveCount(0);
  await quiet(page);
  expect(await body(page, nodeId)).toContain('Unfinished deletion body');
});

test('geometry undo and redo preserve an issued task and its pending indicator', async ({
  page,
}) => {
  const { note, nodeId } = await noteFixture(page);
  const held = await holdPreprocessing(page, nodeId);
  await editNote(page, note, 'Geometry-independent processing');
  await expect.poll(() => held.length).toBe(1);
  const position = () =>
    note.evaluate((element) => (element as HTMLElement).style.transform);
  const before = await position();
  const box = await note.boundingBox();
  if (!box) throw new Error('Missing drag target');
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 68, { steps: 14 });
  await page.mouse.up();
  await expect.poll(position).not.toBe(before);
  const moved = await position();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(position).toBe(before);
  await expect(pending(note)).toBeVisible();
  await observeNoNewRequests(() => held.length, 1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(position).toBe(moved);
  await expect(pending(note)).toBeVisible();
  await succeed(held[0], 'Geometry preserved result');
  await expect(note).toContainText('Geometry preserved result');
  await expect(pending(note)).toHaveCount(0);
  await quiet(page);
  expect(held).toHaveLength(1);
});

test('Text creation and changed-content blur use the real preprocessing endpoint', async ({
  page,
}) => {
  await openNewCanvas(page);
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/preprocess'))
      requests.push(request);
  });
  const center = await paneCenter(page);
  await page
    .locator('[data-canvas-main-toolbar]')
    .getByRole('button', { name: /^Text/ })
    .click();
  await expect(page.locator('.canvas-pending-text').first()).toBeVisible();
  await page.mouse.click(center.x, center.y);
  await page.keyboard.type('Initial lifecycle text');
  await page.keyboard.press('Escape');
  const text = page.locator('.react-flow__node-text').last();
  await expect(text).toBeVisible();
  await quiet(page);
  const before = requests.length;
  await text.dblclick();
  await text.locator('textarea').fill('Changed lifecycle text');
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 100 } });
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  expect(requests.at(-1)?.postDataJSON().snapshot.content).toBe(
    'Changed lifecycle text',
  );
  await quiet(page);
  await expect(pending(text)).toHaveCount(0);
  const nodeId = await text.getAttribute('data-id');
  if (!nodeId) throw new Error('Missing Text identity');
  expect(await body(page, nodeId)).toBe('Changed lifecycle text');
  await page.reload();
  await expect(page.locator(`[data-id="${nodeId}"]`)).toContainText(
    'Changed lifecycle text',
  );
});

/** A one-page PDF with a text layer, small enough to build inline. */
function textPdf(text: string) {
  const stream = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('moving a PDF to another Grid cell requests no preprocessing; renaming it does', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const sources: string[] = [];
  for (const name of ['first', 'second']) {
    const upload = await page.request.post(
      `/api/canvas/${idOf(page)}/artifact/pdf`,
      {
        multipart: {
          file: {
            name: `${name}.pdf`,
            mimeType: 'application/pdf',
            buffer: Buffer.from(textPdf(`Grid ${name}`)),
          },
        },
      },
    );
    expect(upload.ok(), await upload.text()).toBe(true);
    sources.push(((await upload.json()) as ArtifactUploadResponse).uri);
  }
  const created = await page.request.post(`/api/canvas/${idOf(page)}/execute`, {
    data: {
      edits: personEdits([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-grid-frame',
              nodeType: 'frame',
              position: { x: 100, y: 100 },
              size: { width: 440, height: 300 },
              data: {
                label: 'Papers',
                labelSource: 'user',
                layoutMode: 'grid',
                gridCount: 2,
                sizing: 'hug',
              },
            },
            ...sources.map((src, index) => ({
              id: `node-grid-pdf-${index}`,
              nodeType: 'pdf',
              parentId: 'node-grid-frame',
              position: { x: 0, y: 0 },
              size: { width: 160, height: 160 },
              data: {
                label: `Paper ${index}`,
                labelSource: 'user',
                src,
                content: `Grid paper ${index}`,
                frameColumn: index,
                frameRow: 0,
              },
            })),
          ],
        },
      ]),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.addInitScript((id) => {
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 180, y: 80, zoom: 1 }),
    );
  }, idOf(page));
  await page.reload();
  const pdf = (index: number) =>
    page.locator(`.react-flow__node[data-id="node-grid-pdf-${index}"]`);
  await expect(pdf(0)).toBeVisible();
  await expect(pdf(1)).toBeVisible();
  await quiet(page);

  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/preprocess'))
      requested.push(new URL(request.url()).pathname);
  });
  const cells = async () => {
    const response = await page.request.get(`/api/canvas/${idOf(page)}`);
    const record = (await response.json()) as GetCanvasResponse;
    return (record.state as { nodes: Node[] }).nodes
      .filter((node) => node.parentId === 'node-grid-frame')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => `${node.data.frameColumn},${node.data.frameRow}`);
  };
  expect(await cells()).toEqual(['0,0', '1,0']);

  // Drop the first PDF on the cell the second one occupies.
  const from = await pdf(0).boundingBox();
  const onto = await pdf(1).boundingBox();
  if (!from || !onto) throw new Error('Missing PDF rectangle');
  await page.mouse.move(from.x + from.width / 2, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width / 2, onto.y + onto.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect.poll(cells).not.toEqual(['0,0', '1,0']);
  await expect(pending(pdf(0))).toHaveCount(0);
  await expect(pending(pdf(1))).toHaveCount(0);
  await observeNoNewRequests(() => requested.length, 0);
  await expect(pending(pdf(0))).toHaveCount(0);
  await expect(pending(pdf(1))).toHaveCount(0);

  // A title is preprocessing input: renaming still asks once, for the PDF
  // and for the Frame whose own title derives from its children's.
  const held = await holdPreprocessing(page, 'node-grid-pdf-0');
  await pdf(0).click();
  await page.getByRole('button', { name: 'Open Large View' }).click();
  const tab = page.getByRole('tab', { selected: true });
  await tab.focus();
  await tab.press('F2');
  const input = page.getByRole('tab').getByRole('textbox', {
    name: 'Rename node',
    exact: true,
  });
  await input.fill('Renamed paper');
  await input.press('Enter');
  await expect.poll(() => held.length).toBe(1);
  expect(held[0].request().postDataJSON().snapshot.title).toBe('Renamed paper');
  await expect(pending(pdf(0))).toBeVisible();
  await succeed(held[0], 'Renamed paper');
  await expect(pending(pdf(0))).toHaveCount(0);
  await quiet(page);
  expect(requested.filter((path) => path.includes('node-grid-pdf-1'))).toEqual(
    [],
  );
});
