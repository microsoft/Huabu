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

import { editsPerCommand } from './helpers';

import type * as CanvasStore from '../src/store/canvasStore';
import type { CreateCanvasResponse } from '@huabu/shared';

/**
 * Node content between pages.
 *
 * Two real browser contexts ("devices") open the same Space against the real
 * server, storage and Canvas Sync stream. Nothing is mocked and no store is
 * written from the test; the store is only read for evidence.
 *
 * A body or title saved on one page must show on the other without a reload,
 * in the card and in an open preview, and receiving it must not make the
 * receiving page save anything. The plain body case and "B then edits the
 * same note" are case (f) of `multi-page-sync-baseline.spec.ts`.
 *
 * One editor at a time: while one page is editing a node, the other cannot
 * start editing its body or title and is told why; it still can move it. When
 * the first page finishes, the other has its text and may edit.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const X = 'node-content-x';
const Y = 'node-content-y';
const AUTO = 'node-content-auto';
const TEXT = 'node-content-text';
const LOCKED_HINT = /is editing this\. You can edit it when they finish\./;
const SEED = {
  [X]: { x: 380, y: 90 },
  [Y]: { x: 380, y: 340 },
} as const;

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call this page made, without the Space id. */
  calls: string[];
  /** Calls the server refused with 409. */
  conflicts: string[];
}

async function seedSpace(request: APIRequestContext, title: string) {
  const created = await request.post('/api/canvas', { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand([
        {
          type: 'CREATE_NODES',
          nodes: [
            ...[X, Y].map((id) => ({
              id,
              nodeType: 'note',
              data: {
                type: 'note',
                label: `Label ${id}`,
                // A user title, so no page renames the note from its body.
                labelSource: 'user',
                content: `Seed body ${id}`,
              },
              selectOnCreate: false,
              position: SEED[id as keyof typeof SEED],
              size: { width: 300, height: 200 },
            })),
            {
              id: AUTO,
              nodeType: 'note',
              data: {
                type: 'note',
                label: 'Auto',
                labelSource: 'user',
                content: 'One line.',
              },
              selectOnCreate: false,
              position: { x: 820, y: 90 },
              size: { width: 300, height: 'auto' },
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
      ]),
      originator: { tabId: 'e2e-content-sync-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return canvasId;
}

interface ServerNode {
  id: string;
  position: { x: number; y: number };
  style?: { height?: number };
  data: { content?: string; label?: string };
}

async function serverRecord(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    version: number;
    state: { nodes: ServerNode[] };
  };
  return {
    version: record.version,
    node: (id: string) => record.state.nodes.find((node) => node.id === id),
  };
}

async function openDevice(browser: Browser, canvasId: string): Promise<Device> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ canvasId }) => {
      if (window !== window.top) return;
      localStorage.setItem('huabu.language', 'en');
      localStorage.setItem(
        `huabu.viewport.${canvasId}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
      if (!localStorage.getItem('huabu-sketch-tools')) {
        localStorage.setItem(
          'huabu-sketch-tools',
          JSON.stringify({
            version: 4,
            state: {
              inputModePreference: 'mouse',
              mouseToolPreference: 'select',
            },
          }),
        );
      }
    },
    { canvasId },
  );
  const page = await context.newPage();
  const calls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' || !path.startsWith('/api/canvas/')) return;
    calls.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
  });
  const conflicts: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 409 && path.startsWith('/api/canvas/'))
      conflicts.push(`${response.request().method()} ${path}`);
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator(`[data-id="${X}"]`)).toBeVisible();
  // A reload replaces the document; this marker proves one did not happen.
  await page.evaluate(() => {
    (
      window as unknown as { __contentSyncLoaded: boolean }
    ).__contentSyncLoaded = true;
  });
  return { context, page, calls, conflicts };
}

async function storeState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store, hasUnsavedCanvasEdits } = (await import(
      path
    )) as typeof CanvasStore;
    const state = store.getState();
    const field = (key: string) =>
      Object.fromEntries(
        state.nodes.map((node) => [
          node.id,
          (node.data as Record<string, unknown>)[key] as string | undefined,
        ]),
      );
    return {
      version: state.version,
      // Nothing queued for the server: no command batch, no content save.
      unsaved: hasUnsavedCanvasEdits(),
      canUndo: state.canUndo,
      content: field('content'),
      label: field('label'),
      pendingContent: state.pendingContentNodeIds(),
      reloaded:
        (window as unknown as { __contentSyncLoaded?: boolean })
          .__contentSyncLoaded !== true,
    };
  });
}

/** Both pages have loaded the same version and nothing is waiting to save. */
async function openBoth(
  browser: Browser,
  request: APIRequestContext,
  title: string,
) {
  const canvasId = await seedSpace(request, title);
  const a = await openDevice(browser, canvasId);
  const b = await openDevice(browser, canvasId);
  // Outlast the load-time measurement of the auto-height note.
  await a.page.waitForTimeout(2_000);
  await expect(async () => {
    const { version } = await serverRecord(request, canvasId);
    for (const device of [a, b]) {
      const state = await storeState(device.page);
      expect(state.unsaved).toBe(false);
      expect(state.pendingContent).toEqual([]);
      expect(state.version).toBe(version);
    }
  }).toPass();
  a.calls.length = 0;
  b.calls.length = 0;
  return { canvasId, a, b };
}

const previewEditor = (page: Page) =>
  page.locator('[data-search-scope="node"] .ProseMirror');
const editablePreview = (page: Page) =>
  page.locator(
    '[data-search-scope="node"] .ProseMirror[contenteditable="true"]',
  );

async function openPreview(page: Page, id: string) {
  await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .click({ position: { x: 150, y: 12 } });
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(previewEditor(page)).toHaveCount(1);
}

async function closePreview(page: Page) {
  await page
    .getByRole('tab', { selected: true })
    .getByRole('button', { name: /^Close / })
    .click();
  await expect(previewEditor(page)).toHaveCount(0);
}

/** Rendered body text of a note card on the Canvas. */
const cardBody = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"] .ProseMirror`);

/** Requests a page made that are not presence reports. */
const writes = (device: Device) =>
  device.calls.filter((call) => !call.includes('/presence'));

test('a title and a body saved on page A show in page B, in the card and in its open preview', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Content title');

  // B has X open in the preview and is not typing in it.
  await openPreview(b.page, X);
  await b.page
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 500 } });
  await expect(previewEditor(b.page)).toHaveText(`Seed body ${X}`);
  b.calls.length = 0;

  // A rewrites the body, then renames the note.
  await openPreview(a.page, X);
  await editablePreview(a.page).fill('Body written by page A');
  // F2 on the preview tab starts renaming the note.
  await a.page.getByRole('tab', { selected: true }).focus();
  await a.page.keyboard.press('F2');
  const title = a.page.getByRole('textbox', { name: 'Rename node' });
  await title.fill('Title from page A');
  await title.press('Enter');
  await closePreview(a.page);
  await expect
    .poll(async () => {
      const node = (await serverRecord(request, canvasId)).node(X);
      return [node?.data.label, node?.data.content?.trim()];
    })
    .toEqual(['Title from page A', 'Body written by page A']);

  // B shows both, in the card, the store and the open preview.
  await expect(cardBody(b.page, X)).toHaveText('Body written by page A');
  await expect(previewEditor(b.page)).toHaveText('Body written by page A');
  await expect(b.page.getByRole('tab', { selected: true })).toContainText(
    'Title from page A',
  );
  await expect
    .poll(async () => (await storeState(b.page)).label[X])
    .toBe('Title from page A');

  // Receiving them made B send nothing, and left nothing to save or undo.
  await b.page.waitForTimeout(1_500);
  const state = await storeState(b.page);
  expect(writes(b)).toEqual([]);
  expect(state.pendingContent).toEqual([]);
  expect(state.canUndo).toBe(false);
  expect(state.reloaded).toBe(false);
  expect(state.version).toBe((await serverRecord(request, canvasId)).version);

  await a.context.close();
  await b.context.close();
});

test('a body that changes an auto-height note is measured on both pages without the pages writing in turns', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Content height');
  const shown = (page: Page) =>
    page.evaluate(
      (id) =>
        document
          .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
          ?.getBoundingClientRect().height ?? null,
      AUTO,
    );
  const before = await shown(b.page);

  await openPreview(a.page, AUTO);
  await editablePreview(a.page).fill(
    Array.from(
      { length: 10 },
      (_, line) => `Paragraph ${line + 1} that makes the note taller.`,
    ).join('\n\n'),
  );
  await closePreview(a.page);

  // Both pages grow the note to the same height, and the server has it.
  await expect.poll(() => shown(b.page)).toBeGreaterThan((before ?? 0) + 100);
  await expect(async () => {
    const saved = (await serverRecord(request, canvasId)).node(AUTO)?.style
      ?.height;
    expect(await shown(a.page)).toBe(saved);
    expect(await shown(b.page)).toBe(saved);
  }).toPass();

  // Then both pages are quiet: no page keeps answering the other's report.
  await a.page.waitForTimeout(1_500);
  const settled = (await serverRecord(request, canvasId)).version;
  a.calls.length = 0;
  b.calls.length = 0;
  await a.page.waitForTimeout(3_000);
  expect(writes(a)).toEqual([]);
  expect(writes(b)).toEqual([]);
  expect((await serverRecord(request, canvasId)).version).toBe(settled);
  // B never saved content or the whole Space; at most it reported a height.
  expect((await storeState(b.page)).reloaded).toBe(false);

  await a.context.close();
  await b.context.close();
});

test("while page A is editing a note, page B cannot edit its body or title, and can once A finishes, starting from A's text", async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Content lock');

  // A opens X and types; its caret stays in the editor.
  await openPreview(a.page, X);
  await editablePreview(a.page).fill('Typed by page A');
  await expect(editablePreview(a.page)).toBeFocused();

  // B is shown that X is being edited.
  await expect(
    b.page.locator(`[data-presence-outline-label="${X}"]`),
  ).toContainText('editing');

  // Structure stays free: B moves X while A edits it.
  const card = b.page.locator(`.react-flow__node[data-id="${X}"]`);
  const box = await card.boundingBox();
  if (!box) throw new Error('X is not visible on B');
  await b.page.mouse.move(box.x + box.width / 2, box.y + 12);
  await b.page.mouse.down();
  await b.page.mouse.move(box.x + box.width / 2, box.y + 12 - 60, {
    steps: 10,
  });
  await b.page.mouse.up();
  await expect
    .poll(
      async () => (await serverRecord(request, canvasId)).node(X)?.position.y,
    )
    .toBeLessThan(SEED[X].y - 30);
  await expect(b.page.getByText(LOCKED_HINT)).toHaveCount(0);

  // B opens X: the preview is read-only, says why, and shows A's text.
  await openPreview(b.page, X);
  await expect(b.page.locator('[data-edit-locked-notice]')).toHaveText(
    LOCKED_HINT,
  );
  await expect(editablePreview(b.page)).toHaveCount(0);
  await expect(previewEditor(b.page)).toHaveText('Typed by page A');
  // Trying to type there does nothing but show the hint.
  await previewEditor(b.page).click();
  await b.page.keyboard.type('typed by B while locked');
  await expect(b.page.getByText(LOCKED_HINT)).toHaveCount(2);
  await expect(previewEditor(b.page)).toHaveText('Typed by page A');
  // The title cannot be edited either.
  await b.page.getByRole('tab', { selected: true }).focus();
  await b.page.keyboard.press('F2');
  await expect(
    b.page.getByRole('textbox', { name: 'Rename node' }),
  ).toHaveCount(0);
  // B saved no content while it was locked out, and A is still the editor.
  expect(b.calls.filter((call) => call.includes('/content'))).toEqual([]);
  expect((await storeState(b.page)).pendingContent).toEqual([]);
  await expect(editablePreview(a.page)).toBeFocused();

  // A finishes. B is told nothing more, may edit, and has A's text.
  await closePreview(a.page);
  await expect(b.page.locator('[data-edit-locked-notice]')).toHaveCount(0);
  // A still has X selected, but is no longer shown as editing it.
  await expect(
    b.page.locator(`[data-presence-outline="${X}"]`),
  ).toHaveAttribute('data-presence-activity', 'selected');
  await expect(editablePreview(b.page)).toHaveCount(1);
  await expect(editablePreview(b.page)).toHaveText('Typed by page A');
  await editablePreview(b.page).fill('Typed by page A, then by page B');
  await closePreview(b.page);
  await expect
    .poll(async () =>
      (await serverRecord(request, canvasId)).node(X)?.data.content?.trim(),
    )
    .toBe('Typed by page A, then by page B');

  // B's save descended from A's: nothing was refused, nobody has to choose.
  await expect(cardBody(a.page, X)).toHaveText(
    'Typed by page A, then by page B',
  );
  expect(a.conflicts).toEqual([]);
  expect(b.conflicts).toEqual([]);
  for (const device of [a, b]) {
    await expect(
      device.page.getByRole('button', { name: /^(Keep mine|Load latest)$/ }),
    ).toHaveCount(0);
    expect((await storeState(device.page)).reloaded).toBe(false);
  }

  await a.context.close();
  await b.context.close();
});

test('page B cannot start editing a text node in place while page A is editing it, and the lock ends when A closes the page', async ({
  browser,
  request,
}) => {
  const { a, b } = await openBoth(browser, request, 'Content lock text');
  const textOn = (page: Page) =>
    page.locator(`.react-flow__node[data-id="${TEXT}"]`);

  await textOn(a.page).dblclick();
  await expect(textOn(a.page).locator('textarea')).toBeFocused();
  await expect(
    b.page.locator(`[data-presence-outline-label="${TEXT}"]`),
  ).toContainText('editing');

  await textOn(b.page).dblclick();
  await expect(b.page.getByText(LOCKED_HINT)).toHaveCount(1);
  // The field stays the read-only mirror it is outside editing.
  await expect(textOn(b.page).locator('textarea')).not.toBeFocused();
  await expect(textOn(b.page).locator('textarea')).not.toBeEditable();

  // A goes away without leaving the editor: the lock goes with the page.
  await a.context.close();
  await expect(
    b.page.locator(`[data-presence-outline-label="${TEXT}"]`),
  ).toHaveCount(0);
  await textOn(b.page).dblclick();
  await expect(textOn(b.page).locator('textarea')).toBeFocused();

  await b.context.close();
});

test("page A renames a note while page B's body conflict is open: Keep mine on B saves B's body and A's title stands", async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Keep mine');
  const contentUrl = `/api/canvas/${canvasId}/nodes/${X}/content`;

  // B types into X. Its save is held on the way out, so that another
  // writer's body reaches the server first.
  const saves: Record<string, unknown>[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await b.page.route(`**${contentUrl}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    saves.push(route.request().postDataJSON() as Record<string, unknown>);
    if (saves.length === 1) await held;
    await route.continue();
  });
  await openPreview(b.page, X);
  await editablePreview(b.page).fill('Body typed on page B');
  await expect.poll(() => saves.length).toBe(1);

  // A third client saves another body on the revision the server holds.
  const stored = (await (await request.get(contentUrl)).json()) as {
    rev: string;
  };
  const other = await request.put(contentUrl, {
    data: {
      nodeType: 'note',
      content: 'Body from a third client',
      expectRev: stored.rev,
    },
  });
  expect(other.ok(), await other.text()).toBe(true);
  await expect(cardBody(a.page, X)).toHaveText('Body from a third client');

  // B's save arrives second and is refused: B is asked, and keeps its text.
  release();
  const keepMine = b.page.getByRole('button', { name: 'Keep mine' });
  await expect(keepMine).toBeVisible();
  expect(b.conflicts).toHaveLength(1);
  await expect(previewEditor(b.page)).toHaveText('Body typed on page B');

  // B leaves the editor with the choice still open; A renames the note.
  await closePreview(b.page);
  await openPreview(a.page, X);
  const title = a.page.getByRole('textbox', { name: 'Rename node' });
  await expect(async () => {
    await a.page.getByRole('tab', { selected: true }).focus();
    await a.page.keyboard.press('F2');
    await expect(title).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await title.fill('Title from page A');
  await title.press('Enter');
  await closePreview(a.page);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ label: 'Title from page A' });

  // B shows A's title beside its own unsaved body, and is still asked.
  await expect
    .poll(async () => (await storeState(b.page)).label[X])
    .toBe('Title from page A');
  expect((await storeState(b.page)).content[X]?.trim()).toBe(
    'Body typed on page B',
  );
  await expect(keepMine).toBeVisible();

  // Keep mine sends B's body on the server's revision — and no title.
  await keepMine.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({ nodeType: 'note' });
  expect(String(saves[1]?.content).trim()).toBe('Body typed on page B');
  expect(saves[1]).toHaveProperty('expectRev');
  expect(saves[1]).not.toHaveProperty('label');
  expect(saves[1]).not.toHaveProperty('labelSource');

  // The server holds B's body under A's title, and both pages show that.
  await expect
    .poll(async () => {
      const node = (await serverRecord(request, canvasId)).node(X);
      return [node?.data.label, node?.data.content?.trim()];
    })
    .toEqual(['Title from page A', 'Body typed on page B']);
  await expect(cardBody(a.page, X)).toHaveText('Body typed on page B');
  for (const device of [a, b]) {
    await expect
      .poll(async () => {
        const state = await storeState(device.page);
        return [state.label[X], state.content[X]?.trim(), state.pendingContent];
      })
      .toEqual(['Title from page A', 'Body typed on page B', []]);
    await expect(
      device.page.getByRole('button', { name: /^(Keep mine|Load latest)$/ }),
    ).toHaveCount(0);
    expect((await storeState(device.page)).reloaded).toBe(false);
  }
  // The one refusal was B's first save; nothing was refused after it.
  expect(a.conflicts).toEqual([]);
  expect(b.conflicts).toHaveLength(1);

  await a.context.close();
  await b.context.close();
});

/** Open X in the preview and rename it from its tab (F2), as a person does. */
async function renameFromPreview(page: Page, id: string, next: string) {
  await openPreview(page, id);
  const title = page.getByRole('textbox', { name: 'Rename node' });
  await expect(async () => {
    await page.getByRole('tab', { selected: true }).focus();
    await page.keyboard.press('F2');
    await expect(title).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await title.fill(next);
  await title.press('Enter');
}

/** Pause every request of `page` that `matches`, until `release` is called. */
async function holdRequests(
  page: Page,
  url: string,
  matches: (method: string) => boolean,
) {
  const seen: Record<string, unknown>[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${url}`, async (route) => {
    const request = route.request();
    if (!matches(request.method())) return route.continue();
    seen.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
    await held;
    await route.continue();
  });
  return { seen, release };
}

test('a rename is not checked against the body: page A renames a note whose new body, saved by page B, it has not received yet', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Rename, body');
  const contentUrl = `/api/canvas/${canvasId}/nodes/${X}/content`;

  // A's reads of the node are slow: it will not have B's body in time.
  const reads = await holdRequests(a.page, contentUrl, (m) => m === 'GET');
  const renames: Record<string, unknown>[] = [];
  a.page.on('request', (sent) => {
    if (sent.method() === 'PUT' && sent.url().endsWith(contentUrl))
      renames.push(sent.postDataJSON() as Record<string, unknown>);
  });

  // B rewrites the body and leaves the editor; the server has it.
  await openPreview(b.page, X);
  await editablePreview(b.page).fill('Body typed on page B');
  await closePreview(b.page);
  await expect
    .poll(async () =>
      (await serverRecord(request, canvasId)).node(X)?.data.content?.trim(),
    )
    .toBe('Body typed on page B');
  // A was told and asked, and still shows the body it loaded.
  await expect.poll(() => reads.seen.length).toBeGreaterThan(0);
  expect((await storeState(a.page)).content[X]).toBe(`Seed body ${X}`);

  // A renames the note. Nothing is refused and nobody is asked.
  await renameFromPreview(a.page, X, 'Title from page A');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ label: 'Title from page A' });
  expect(renames).toHaveLength(1);
  expect(renames[0]).toMatchObject({
    nodeType: 'note',
    label: 'Title from page A',
    labelSource: 'user',
  });
  // The rename carries neither a body nor a revision of one.
  expect(renames[0]).not.toHaveProperty('expectRev');
  expect(renames[0]).not.toHaveProperty('content');
  expect(a.conflicts).toEqual([]);

  // A's reads arrive: both pages and the server hold B's body under A's
  // title, and neither page was asked anything.
  reads.release();
  await closePreview(a.page);
  await expect
    .poll(async () => {
      const node = (await serverRecord(request, canvasId)).node(X);
      return [node?.data.label, node?.data.content?.trim()];
    })
    .toEqual(['Title from page A', 'Body typed on page B']);
  for (const device of [a, b]) {
    await expect
      .poll(async () => {
        const state = await storeState(device.page);
        return [state.label[X], state.content[X]?.trim(), state.pendingContent];
      })
      .toEqual(['Title from page A', 'Body typed on page B', []]);
    await expect(
      device.page.getByRole('button', { name: /^(Keep mine|Load latest)$/ }),
    ).toHaveCount(0);
    expect(device.conflicts).toEqual([]);
    expect((await storeState(device.page)).reloaded).toBe(false);
  }

  await a.context.close();
  await b.context.close();
});

test('page A renames a note while page B has an unsaved body in it: both are saved and nobody is asked', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Rename, typing');
  const contentUrl = `/api/canvas/${canvasId}/nodes/${X}/content`;

  // B types into X and leaves the editor; its save is still on its way.
  const saves = await holdRequests(b.page, contentUrl, (m) => m === 'PUT');
  await openPreview(b.page, X);
  await editablePreview(b.page).fill('Body typed on page B');
  await expect.poll(() => saves.seen.length).toBe(1);
  await closePreview(b.page);
  expect((await storeState(b.page)).pendingContent).toEqual([X]);

  // A renames the note meanwhile.
  await renameFromPreview(a.page, X, 'Title from page A');
  await closePreview(a.page);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ label: 'Title from page A' });
  // B shows A's title beside its own unsaved body.
  await expect
    .poll(async () => (await storeState(b.page)).label[X])
    .toBe('Title from page A');
  expect((await storeState(b.page)).content[X]?.trim()).toBe(
    'Body typed on page B',
  );

  // B's body arrives after the rename and is accepted.
  saves.release();
  await expect
    .poll(async () => {
      const node = (await serverRecord(request, canvasId)).node(X);
      return [node?.data.label, node?.data.content?.trim()];
    })
    .toEqual(['Title from page A', 'Body typed on page B']);
  for (const device of [a, b]) {
    await expect
      .poll(async () => {
        const state = await storeState(device.page);
        return [state.label[X], state.content[X]?.trim(), state.pendingContent];
      })
      .toEqual(['Title from page A', 'Body typed on page B', []]);
    await expect(
      device.page.getByRole('button', { name: /^(Keep mine|Load latest)$/ }),
    ).toHaveCount(0);
    expect(device.conflicts).toEqual([]);
    expect((await storeState(device.page)).reloaded).toBe(false);
  }
  // B's body save carried no title: it could not undo A's rename.
  expect(saves.seen).toHaveLength(1);
  expect(saves.seen[0]).not.toHaveProperty('label');

  await a.context.close();
  await b.context.close();
});

test('two pages rename the same note at once: the later rename wins on the server and on both pages, and nobody is asked', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Two renames');
  const contentUrl = `/api/canvas/${canvasId}/nodes/${X}/content`;

  // A's rename is slow on its way to the server.
  const fromA = await holdRequests(a.page, contentUrl, (m) => m === 'PUT');
  await renameFromPreview(a.page, X, 'Title from page A');
  await expect.poll(() => fromA.seen.length).toBe(1);
  await closePreview(a.page);

  // B renames the same note meanwhile; its rename reaches the server first.
  await renameFromPreview(b.page, X, 'Title from page B');
  await closePreview(b.page);
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ label: 'Title from page B' });
  // A keeps showing the title it is saving.
  await a.page.waitForTimeout(1_000);
  expect((await storeState(a.page)).label[X]).toBe('Title from page A');

  // A's rename arrives last: it is the title everywhere.
  fromA.release();
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(X)?.data)
    .toMatchObject({ label: 'Title from page A' });
  for (const device of [a, b]) {
    await expect
      .poll(async () => {
        const state = await storeState(device.page);
        return [state.label[X], state.pendingContent];
      })
      .toEqual(['Title from page A', []]);
    await expect(
      device.page.locator(`.react-flow__node[data-id="${X}"]`),
    ).toContainText('Title from page A');
    await expect(
      device.page.getByRole('button', { name: /^(Keep mine|Load latest)$/ }),
    ).toHaveCount(0);
    expect(device.conflicts).toEqual([]);
    expect((await storeState(device.page)).reloaded).toBe(false);
  }
  // Neither rename quoted a revision; the body was never part of it.
  expect(fromA.seen[0]).not.toHaveProperty('expectRev');
  expect(
    (await serverRecord(request, canvasId)).node(X)?.data.content?.trim(),
  ).toBe(`Seed body ${X}`);

  await a.context.close();
  await b.context.close();
});
