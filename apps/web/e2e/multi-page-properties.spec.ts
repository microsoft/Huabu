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
import type {
  ArtifactUploadResponse,
  CreateCanvasResponse,
} from '@huabu/shared';

/**
 * PDF notes and node properties between pages.
 *
 * Two real browser contexts ("devices") open the same Space against the real
 * server, storage and Canvas Sync stream. Nothing is mocked and no store is
 * written from the test; the store is only read for evidence.
 *
 * - A PDF's Note is created by one `INITIALIZE_PDF_NOTE` command through the
 *   send queue, with the id the creating page already shows; the other page
 *   receives the Note and the link as an update.
 * - Properties (tags and other values) are saved with the node's content
 *   (`PUT …/nodes/:id/content`) and reach the other page as a node-scoped
 *   fetch. No page ever saves the whole Space, and a receiving page neither
 *   writes nor reloads.
 * - Editing a node's properties is editing the node: while one page has a
 *   property editor open, the other shows the properties read-only.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });

const PDF = 'node-prop-pdf';
const NOTE = 'node-prop-note';
const SAVE_FAILED = 'Could not save property changes. This edit was reverted.';

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call this page made, without the Space id. */
  calls: string[];
  /** Commands of every `execute` request this page sent. */
  commands: Array<Record<string, unknown>>;
  /** Calls the server refused with 409. */
  conflicts: string[];
}

function textPdf() {
  const stream =
    'BT /F1 18 Tf 40 700 Td (A paper two pages read together) Tj ET';
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
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function seedSpace(request: APIRequestContext, title: string) {
  const created = await request.post('/api/canvas', { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { canvasId } = (await created.json()) as CreateCanvasResponse;
  const upload = await request.post(`/api/canvas/${canvasId}/artifact/pdf`, {
    multipart: {
      file: {
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(textPdf()),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const { uri } = (await upload.json()) as ArtifactUploadResponse;
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: PDF,
              nodeType: 'pdf',
              data: {
                type: 'pdf',
                label: 'Paper',
                // A user title, so no page renames the node.
                labelSource: 'user',
                src: uri,
                content: 'A paper two pages read together',
              },
              selectOnCreate: false,
              position: { x: 380, y: 90 },
              size: { width: 300, height: 380 },
            },
            {
              id: NOTE,
              nodeType: 'note',
              data: {
                type: 'note',
                label: 'Reading list',
                labelSource: 'user',
                content: 'Seed body',
                properties: { tags: ['seed'], status: 'new' },
                propertyDisplayKeys: ['tags', 'status'],
              },
              selectOnCreate: false,
              position: { x: 760, y: 90 },
              size: { width: 300, height: 200 },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'e2e-properties-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  expect(
    ((await seeded.json()) as { results: Array<{ applied: boolean }> }).results,
  ).toEqual([expect.objectContaining({ applied: true })]);
  return canvasId;
}

interface ServerNode {
  id: string;
  type: string;
  hidden?: boolean;
  data: {
    content?: string;
    label?: string;
    noteNodeId?: string;
    properties?: Record<string, unknown>;
    propertyDisplayKeys?: string[];
  };
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
    ids: record.state.nodes.map((node) => node.id),
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
  const commands: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' || !path.startsWith('/api/canvas/')) return;
    calls.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
    if (path.endsWith('/execute')) {
      const body = request.postDataJSON() as {
        commands?: Array<Record<string, unknown>>;
      } | null;
      commands.push(...(body?.commands ?? []));
    }
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
  await expect(page.locator(`[data-id="${NOTE}"]`)).toBeVisible();
  // A reload replaces the document; this marker proves one did not happen.
  await page.evaluate(() => {
    (window as unknown as { __propertiesLoaded: boolean }).__propertiesLoaded =
      true;
  });
  return { context, page, calls, commands, conflicts };
}

async function storeState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store, hasUnsavedCanvasEdits } = (await import(
      path
    )) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      // Nothing queued for the server: no command batch, no content save.
      unsaved: hasUnsavedCanvasEdits(),
      canUndo: state.canUndo,
      pendingContent: state.pendingContentNodeIds(),
      ids: state.nodes.map((node) => node.id),
      nodes: Object.fromEntries(
        state.nodes.map((node) => {
          const data = node.data as Record<string, unknown>;
          return [
            node.id,
            {
              type: node.type,
              hidden: node.hidden === true,
              noteNodeId: data.noteNodeId as string | undefined,
              content: data.content as string | undefined,
              properties: data.properties as
                | Record<string, unknown>
                | undefined,
              propertyDisplayKeys: data.propertyDisplayKeys as
                | string[]
                | undefined,
            },
          ];
        }),
      ),
      reloaded:
        (window as unknown as { __propertiesLoaded?: boolean })
          .__propertiesLoaded !== true,
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
  // Outlast load-time measurement and the PDF's first preprocessing.
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
  for (const device of [a, b]) {
    device.calls.length = 0;
    device.commands.length = 0;
  }
  return { canvasId, a, b };
}

/** Requests a page made that are not presence reports or preprocessing. */
const writes = (device: Device) =>
  device.calls.filter(
    (call) => !call.includes('/presence') && !call.includes('/preprocess'),
  );

/** The preview panel of one node. */
const panel = (page: Page, id: string) =>
  page.locator(`[data-search-scope="node"][data-search-node-id="${id}"]`);

async function openPreview(page: Page, id: string) {
  await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .click({ position: { x: 150, y: 12 } });
  // The toolbar of a note says "Expand", that of a PDF "Open Large View".
  await page
    .getByRole('button', { name: /^(Expand|Open Large View)$/ })
    .click();
  await expect(panel(page, id)).toBeVisible();
}

/** Take focus out of every editor, so this page edits nothing. */
async function blur(page: Page) {
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 40, y: 560 } });
}

/**
 * Hold this page's next content save on its way to the server. `request`
 * settles with its body once the page has sent it; `release` lets it through.
 * Later saves are not held.
 */
async function holdNextContentSave(page: Page) {
  let pass: (() => void) | undefined;
  const passed = new Promise<void>((resolve) => (pass = resolve));
  let sent: ((body: Record<string, unknown>) => void) | undefined;
  const request = new Promise<Record<string, unknown>>(
    (resolve) => (sent = resolve),
  );
  let taken = false;
  const pattern = `**/api/canvas/*/nodes/${NOTE}/content`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PUT' || taken) return route.fallback();
    taken = true;
    sent?.(route.request().postDataJSON() as Record<string, unknown>);
    await passed;
    await route.continue();
  });
  return {
    request,
    release: () => pass?.(),
  };
}

const tags = (page: Page, id: string) =>
  panel(page, id).locator('[aria-label="Properties"] [data-property-tag]');

/** A creates the PDF's Note from the preview header and writes into it. */
async function createPdfNotes(
  request: APIRequestContext,
  canvasId: string,
  a: Device,
  text: string,
): Promise<string> {
  await openPreview(a.page, PDF);
  await panel(a.page, PDF).getByRole('button', { name: 'Add notes' }).click();
  await expect
    .poll(async () => (await storeState(a.page)).nodes[PDF]?.noteNodeId)
    .toBeTruthy();
  const noteId = (await storeState(a.page)).nodes[PDF].noteNodeId;
  if (!noteId) throw new Error('The PDF was not given a Note');
  const editor = panel(a.page, noteId).locator(
    '.ProseMirror[contenteditable="true"]',
  );
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await expect
    .poll(async () =>
      (await serverRecord(request, canvasId))
        .node(noteId)
        ?.data.content?.trim(),
    )
    .toBe(text);
  return noteId;
}

test('a PDF note created on page A arrives on page B as the same Note, linked, and its text follows', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'PDF note pair');

  const noteId = await createPdfNotes(request, canvasId, a, 'Notes by page A');

  // One command created the pair, with the id page A already showed.
  expect(
    a.commands.filter((command) => command.type !== 'SET_NODE_SELECTION'),
  ).toEqual([{ type: 'INITIALIZE_PDF_NOTE', nodeId: PDF, noteId }]);
  expect(a.calls.filter((call) => /^PUT <space>$/.test(call))).toEqual([]);
  const server = await serverRecord(request, canvasId);
  expect(server.node(PDF)?.data.noteNodeId).toBe(noteId);
  expect(server.node(noteId)).toMatchObject({ type: 'note', hidden: true });

  // B has both nodes and the link, without the Note appearing on its canvas.
  await expect
    .poll(async () => {
      const state = await storeState(b.page);
      return [
        state.nodes[PDF]?.noteNodeId,
        state.nodes[noteId]?.type,
        state.nodes[noteId]?.hidden,
        state.nodes[noteId]?.content?.trim(),
      ];
    })
    .toEqual([noteId, 'note', true, 'Notes by page A']);
  await expect(
    b.page.locator(`.react-flow__node[data-id="${noteId}"]`),
  ).toHaveCount(0);
  let state = await storeState(b.page);
  expect(writes(b)).toEqual([]);
  expect(state.reloaded).toBe(false);
  expect(state.canUndo).toBe(false);
  expect(state.version).toBe(server.version);

  // A leaves the Note; B opens it from its own PDF preview and reads A's
  // text. Opening an existing Note creates nothing.
  await blur(a.page);
  await openPreview(b.page, PDF);
  await panel(b.page, PDF).getByRole('button', { name: 'Open notes' }).click();
  await expect(panel(b.page, noteId).locator('.ProseMirror')).toHaveText(
    'Notes by page A',
  );
  state = await storeState(b.page);
  expect(b.commands.filter((c) => c.type === 'INITIALIZE_PDF_NOTE')).toEqual(
    [],
  );
  expect(
    state.ids.filter((id) => state.nodes[id].type === 'note'),
  ).toHaveLength(2);
  expect(state.reloaded).toBe(false);
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('tags edited on a note on page A show as chips on page B, which is read-only meanwhile and writes nothing', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Note tags');

  // B has the note open in the preview and is not editing it.
  await openPreview(b.page, NOTE);
  await blur(b.page);
  await expect(tags(b.page, NOTE)).toHaveText(['seed']);
  await expect(
    panel(b.page, NOTE).getByRole('button', { name: 'Edit tags' }),
  ).toBeVisible();
  b.calls.length = 0;

  // A opens the tag editor. Editing a property is editing the node: B's
  // properties become read-only and B is told who is editing.
  await openPreview(a.page, NOTE);
  await panel(a.page, NOTE).getByRole('button', { name: 'Edit tags' }).click();
  const field = panel(a.page, NOTE).getByRole('combobox', { name: 'Value' });
  await expect(field).toBeFocused();
  await expect(
    panel(b.page, NOTE).locator('[data-edit-locked-notice]'),
  ).toBeVisible();
  await expect(
    panel(b.page, NOTE).getByRole('button', { name: 'Edit tags' }),
  ).toHaveCount(0);
  await expect(tags(b.page, NOTE)).toHaveText(['seed']);

  // A adds a tag and saves.
  await field.fill('physics');
  await field.press('Enter');
  await field.press('Enter');
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(NOTE)?.data.properties,
    )
    .toEqual({ tags: ['seed', 'physics'], status: 'new' });
  await blur(a.page);

  // B shows the chips without a reload, and may edit again.
  await expect(tags(b.page, NOTE)).toHaveText(['seed', 'physics']);
  await expect(
    panel(b.page, NOTE).locator('[data-edit-locked-notice]'),
  ).toHaveCount(0);
  await expect(
    panel(b.page, NOTE).getByRole('button', { name: 'Edit tags' }),
  ).toBeVisible();

  // A removes the first tag; B follows.
  await panel(a.page, NOTE).getByRole('button', { name: 'Edit tags' }).click();
  await panel(a.page, NOTE)
    .getByRole('button', { name: 'Remove seed' })
    .click();
  await panel(a.page, NOTE)
    .getByRole('combobox', { name: 'Value' })
    .press('Enter');
  await blur(a.page);
  await expect(tags(b.page, NOTE)).toHaveText(['physics']);
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(NOTE)?.data.properties,
    )
    .toEqual({ tags: ['physics'], status: 'new' });

  // The saves were content saves of that one node; nothing saved the Space.
  expect(
    writes(a).filter((call) => !call.endsWith(`/nodes/${NOTE}/content`)),
  ).toEqual([]);
  // One request per committed edit.
  expect(writes(a)).toHaveLength(2);
  // Receiving them made B send nothing, and left nothing to save or undo.
  await b.page.waitForTimeout(1_500);
  const state = await storeState(b.page);
  expect(writes(b)).toEqual([]);
  expect(state.nodes[NOTE].properties).toEqual({
    tags: ['physics'],
    status: 'new',
  });
  expect(state.nodes[NOTE].content?.trim()).toBe('Seed body');
  expect(state.pendingContent).toEqual([]);
  expect(state.canUndo).toBe(false);
  expect(state.reloaded).toBe(false);
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('a property set and then cleared on a PDF on page A is followed by page B', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'PDF property');
  const properties = (page: Page) =>
    panel(page, PDF).locator('[aria-label="Properties"]');
  const venue = (page: Page) =>
    panel(page, PDF).getByRole('button', { name: 'Edit venue' });

  // B reads the PDF with its (still empty) properties open.
  await openPreview(b.page, PDF);
  await panel(b.page, PDF)
    .getByRole('button', { name: 'Expand properties' })
    .click();
  await expect(
    panel(b.page, PDF).getByRole('button', { name: 'Add property' }),
  ).toBeVisible();
  await expect(venue(b.page)).toHaveCount(0);
  await blur(b.page);
  b.calls.length = 0;

  // A adds a property to the PDF.
  await openPreview(a.page, PDF);
  await panel(a.page, PDF)
    .getByRole('button', { name: 'Expand properties' })
    .click();
  await panel(a.page, PDF)
    .getByRole('button', { name: 'Add property' })
    .click();
  await panel(a.page, PDF)
    .getByRole('textbox', { name: 'Property name' })
    .fill('venue');
  const value = panel(a.page, PDF).getByRole('textbox', { name: 'Value' });
  await value.fill('ICML');
  await value.press('Enter');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).node(PDF)?.data)
    .toMatchObject({
      properties: { venue: 'ICML' },
      propertyDisplayKeys: ['venue'],
    });
  await blur(a.page);

  // B follows, in the store and in the open preview.
  await expect(venue(b.page)).toHaveText('ICML');
  await expect
    .poll(async () => (await storeState(b.page)).nodes[PDF].properties)
    .toEqual({ venue: 'ICML' });

  // A clears it again.
  await panel(a.page, PDF)
    .getByRole('button', { name: 'Options for venue' })
    .click();
  await a.page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(PDF)?.data.properties ??
        {},
    )
    .toEqual({});
  await expect(venue(b.page)).toHaveCount(0);
  await expect(properties(b.page)).not.toContainText('ICML');
  await expect
    .poll(async () => (await storeState(b.page)).nodes[PDF].properties ?? {})
    .toEqual({});

  // One content save for the set and one for the clear, nothing else.
  expect(writes(a)).toEqual([
    `PUT <space>/nodes/${PDF}/content`,
    `PUT <space>/nodes/${PDF}/content`,
  ]);
  await b.page.waitForTimeout(1_500);
  const state = await storeState(b.page);
  expect(writes(b)).toEqual([]);
  expect(state.pendingContent).toEqual([]);
  expect(state.canUndo).toBe(false);
  expect(state.reloaded).toBe(false);
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('a PDF property saved after the page moved another node is not refused', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'PDF moved');

  // Every structure edit comes back to the page as an update. The page is
  // never sent the PDF's extracted text, so the revision its next property
  // save states must still be the one the load brought — not one computed,
  // after the update, from what the page shows.
  const node = a.page.locator(`.react-flow__node[data-id="${NOTE}"]`);
  const box = await node.boundingBox();
  if (!box) throw new Error('The note is not on the canvas');
  await a.page.mouse.move(box.x + 150, box.y + 12);
  await a.page.mouse.down();
  await a.page.mouse.move(box.x + 150, box.y + 252, { steps: 12 });
  await a.page.mouse.up();
  await expect
    .poll(async () => {
      const record = await request.get(`/api/canvas/${canvasId}`);
      const body = (await record.json()) as {
        state: { nodes: Array<{ id: string; position: { y: number } }> };
      };
      return body.state.nodes.find((n) => n.id === NOTE)?.position.y;
    })
    .toBeGreaterThan(200);
  // Whether the page holds the extracted text by now depends on whether
  // preprocessing has answered it; the save must be taken either way. (The
  // store test "is kept through a structure update" pins the case without.)
  test.info().annotations.push({
    type: 'page shows the extracted text',
    description: String(
      (await storeState(a.page)).nodes[PDF].content !== undefined,
    ),
  });
  await expect.poll(async () => (await storeState(a.page)).unsaved).toBe(false);

  await openPreview(a.page, PDF);
  await panel(a.page, PDF)
    .getByRole('button', { name: 'Expand properties' })
    .click();
  await panel(a.page, PDF)
    .getByRole('button', { name: 'Add property' })
    .click();
  await panel(a.page, PDF)
    .getByRole('textbox', { name: 'Property name' })
    .fill('year');
  const value = panel(a.page, PDF).getByRole('textbox', { name: 'Value' });
  await value.fill('2026');
  await value.press('Enter');
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(PDF)?.data.properties,
    )
    .toEqual({ year: '2026' });
  await expect
    .poll(async () => (await storeState(b.page)).nodes[PDF].properties)
    .toEqual({ year: '2026' });
  await expect(a.page.getByText(SAVE_FAILED)).toHaveCount(0);
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('deleting a PDF with its note on page A and undoing brings both back on page B, with the text and the link', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Pair undo');
  const noteId = await createPdfNotes(request, canvasId, a, 'Notes by page A');
  await expect
    .poll(async () => (await storeState(b.page)).nodes[noteId]?.content?.trim())
    .toBe('Notes by page A');
  await blur(a.page);
  // The Note's last save has been answered before the pair is deleted.
  await expect
    .poll(async () => (await storeState(a.page)).pendingContent)
    .toEqual([]);
  a.commands.length = 0;
  b.calls.length = 0;

  // A deletes the PDF; its Note goes with it, on the server and on B.
  await a.page
    .locator(`.react-flow__node[data-id="${PDF}"]`)
    .click({ position: { x: 150, y: 12 } });
  await a.page.keyboard.press('Delete');
  await expect
    .poll(async () => (await serverRecord(request, canvasId)).ids)
    .toEqual([NOTE]);
  await expect.poll(async () => (await storeState(b.page)).ids).toEqual([NOTE]);
  expect(
    a.commands.filter((command) => command.type === 'DELETE_NODES'),
  ).toEqual([{ type: 'DELETE_NODES', nodeIds: [PDF] }]);

  // A undoes. The pair is restored by one batch that carries both nodes.
  await a.page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => {
      const server = await serverRecord(request, canvasId);
      return [
        server.node(PDF)?.data.noteNodeId,
        server.node(noteId)?.hidden,
        server.node(noteId)?.data.content?.trim(),
      ];
    })
    .toEqual([noteId, true, 'Notes by page A']);
  const restore = a.commands.filter(
    (command) => command.type === 'RESTORE_NODES',
  );
  expect(restore).toHaveLength(1);
  expect(
    (restore[0].nodes as Array<{ id: string }>).map((node) => node.id).sort(),
  ).toEqual([PDF, noteId].sort());

  // B sees both come back, with the text and the link, without a reload.
  await expect
    .poll(async () => {
      const state = await storeState(b.page);
      return [
        state.nodes[PDF]?.noteNodeId,
        state.nodes[noteId]?.hidden,
        state.nodes[noteId]?.content?.trim(),
      ];
    })
    .toEqual([noteId, true, 'Notes by page A']);
  await expect(
    b.page.locator(`.react-flow__node[data-id="${PDF}"]`),
  ).toBeVisible();
  await openPreview(b.page, PDF);
  await panel(b.page, PDF).getByRole('button', { name: 'Open notes' }).click();
  await expect(panel(b.page, noteId).locator('.ProseMirror')).toHaveText(
    'Notes by page A',
  );
  const state = await storeState(b.page);
  expect(state.reloaded).toBe(false);
  expect(b.commands.filter((c) => c.type === 'INITIALIZE_PDF_NOTE')).toEqual(
    [],
  );
  expect(
    [...a.calls, ...b.calls].filter((call) => /^PUT <space>$/.test(call)),
  ).toEqual([]);
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);

  await a.context.close();
  await b.context.close();
});

test('two pages editing different properties of one note: both survive, also when the two saves leave in the same moment', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Two editors');
  const serverProperties = async () =>
    (await serverRecord(request, canvasId)).node(NOTE)?.data.properties;
  const edit = (device: Device, name: string) =>
    panel(device.page, NOTE).getByRole('button', { name: `Edit ${name}` });
  const statusField = panel(a.page, NOTE).getByRole('textbox', {
    name: 'Value',
  });
  const tagField = panel(b.page, NOTE).getByRole('combobox', { name: 'Value' });

  await openPreview(a.page, NOTE);
  await blur(a.page);
  await openPreview(b.page, NOTE);
  await blur(b.page);
  await expect(edit(a, 'status')).toBeVisible();
  await expect(edit(b, 'tags')).toBeVisible();

  // Both start in the same instant, before either page has heard that the
  // other is editing (a real click on one page is seen by the other within
  // a tenth of a second, and would lock it out — the tags case above).
  // Neither is then locked out by the other.
  const startBoth = () =>
    Promise.all([
      edit(a, 'status').dispatchEvent('click'),
      edit(b, 'tags').dispatchEvent('click'),
    ]);
  await startBoth();
  await expect(statusField).toBeFocused();
  await expect(tagField).toBeFocused();

  // A saves its property. B, whose editor is still open, takes it in.
  await statusField.fill('done');
  await statusField.press('Enter');
  await expect
    .poll(serverProperties)
    .toEqual({ tags: ['seed'], status: 'done' });
  await expect
    .poll(async () => (await storeState(b.page)).nodes[NOTE].properties)
    .toEqual({ tags: ['seed'], status: 'done' });
  await expect(tagField).toBeFocused();

  // B then saves a different property: both edits stand.
  await tagField.fill('physics');
  await tagField.press('Enter');
  await tagField.press('Enter');
  await expect
    .poll(serverProperties)
    .toEqual({ tags: ['seed', 'physics'], status: 'done' });
  await expect
    .poll(async () => (await storeState(a.page)).nodes[NOTE].properties)
    .toEqual({ tags: ['seed', 'physics'], status: 'done' });
  expect([...a.conflicts, ...b.conflicts]).toEqual([]);
  const putsBefore = writes(b).filter((call) => call.startsWith('PUT')).length;

  // Now both save from the same revision. B's request is held on its way
  // out until the server has taken A's, so B's is the one refused as stale —
  // every time, not by chance.
  await blur(a.page);
  await blur(b.page);
  await expect(edit(a, 'status')).toBeVisible();
  await expect(edit(b, 'tags')).toBeVisible();
  await startBoth();
  await expect(statusField).toBeFocused();
  await expect(tagField).toBeFocused();
  await statusField.fill('final');
  await tagField.fill('math');
  await tagField.press('Enter');
  const held = await holdNextContentSave(b.page);
  await tagField.press('Enter');
  const heldBody = await held.request;
  expect(heldBody.properties).toMatchObject({
    tags: ['seed', 'physics', 'math'],
  });
  await statusField.press('Enter');
  await expect
    .poll(serverProperties)
    .toEqual({ tags: ['seed', 'physics'], status: 'final' });
  held.release();

  // B's save is refused once. A changed `status`, B changed `tags`: B takes
  // A's value in, makes its own edit again on top of it and saves — nobody
  // is asked anything, and nothing has to be done again.
  await expect
    .poll(serverProperties)
    .toEqual({ tags: ['seed', 'physics', 'math'], status: 'final' });
  for (const device of [a, b]) {
    await expect
      .poll(async () => (await storeState(device.page)).nodes[NOTE].properties)
      .toEqual({ tags: ['seed', 'physics', 'math'], status: 'final' });
    await expect(device.page.getByText(SAVE_FAILED)).toHaveCount(0);
    await expect(
      device.page.getByRole('button', { name: 'Keep mine' }),
    ).toHaveCount(0);
  }
  await expect(tags(b.page, NOTE)).toHaveText(['seed', 'physics', 'math']);
  expect(a.conflicts).toEqual([]);
  expect(b.conflicts).toEqual([
    `PUT /api/canvas/${canvasId}/nodes/${NOTE}/content`,
  ]);
  // Refused once, fetched, sent again: two saves and no other write.
  expect(writes(b).filter((call) => call.startsWith('PUT'))).toHaveLength(
    putsBefore + 2,
  );
  await blur(a.page);
  await blur(b.page);
  await expect(async () => {
    for (const device of [a, b]) {
      const state = await storeState(device.page);
      expect(state.unsaved).toBe(false);
      expect(state.pendingContent).toEqual([]);
      expect(state.reloaded).toBe(false);
    }
  }).toPass();

  await a.context.close();
  await b.context.close();
});

test('two pages editing the same property of one note at the same moment: the second is refused and told, and nothing is overwritten', async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Same property');
  const serverProperties = async () =>
    (await serverRecord(request, canvasId)).node(NOTE)?.data.properties;
  const edit = (device: Device) =>
    panel(device.page, NOTE).getByRole('button', { name: 'Edit status' });
  const field = (device: Device) =>
    panel(device.page, NOTE).getByRole('textbox', { name: 'Value' });

  await openPreview(a.page, NOTE);
  await blur(a.page);
  await openPreview(b.page, NOTE);
  await blur(b.page);
  await expect(edit(a)).toBeVisible();
  await expect(edit(b)).toBeVisible();
  // Both start in the same instant, so neither is locked out by the other.
  await Promise.all([
    edit(a).dispatchEvent('click'),
    edit(b).dispatchEvent('click'),
  ]);
  await expect(field(a)).toBeFocused();
  await expect(field(b)).toBeFocused();

  await field(a).fill('from A');
  await field(b).fill('from B');
  const held = await holdNextContentSave(b.page);
  await field(b).press('Enter');
  await held.request;
  await field(a).press('Enter');
  await expect
    .poll(serverProperties)
    .toEqual({ tags: ['seed'], status: 'from A' });
  held.release();

  // Both changed `status`: B's edit is not put on top of A's. B is told, its
  // edit is taken back, and the server keeps what A saved.
  await expect(b.page.getByText(SAVE_FAILED)).toBeVisible();
  await expect(b.page.getByRole('button', { name: 'Keep mine' })).toBeVisible();
  await expect(a.page.getByText(SAVE_FAILED)).toHaveCount(0);
  expect(b.conflicts).toEqual([
    `PUT /api/canvas/${canvasId}/nodes/${NOTE}/content`,
  ]);
  expect(a.conflicts).toEqual([]);
  expect(writes(b).filter((call) => call.startsWith('PUT'))).toHaveLength(1);
  expect((await storeState(b.page)).nodes[NOTE].properties?.status).not.toBe(
    'from B',
  );
  // Still so a moment later: nothing resubmits behind the toast.
  await b.page.waitForTimeout(1_500);
  expect(await serverProperties()).toEqual({
    tags: ['seed'],
    status: 'from A',
  });
  expect(writes(b).filter((call) => call.startsWith('PUT'))).toHaveLength(1);
  expect((await storeState(a.page)).reloaded).toBe(false);
  expect((await storeState(b.page)).reloaded).toBe(false);

  await a.context.close();
  await b.context.close();
});

/** The stored content revision a load reports for `nodeId`. */
async function storedRevision(
  request: APIRequestContext,
  canvasId: string,
  nodeId: string,
) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const { nodeContentRevisions } = (await response.json()) as {
    nodeContentRevisions?: Record<string, string>;
  };
  const revision = nodeContentRevisions?.[nodeId];
  if (!revision) throw new Error(`No stored revision for ${nodeId}`);
  return revision;
}

/** An agent writes `patch` into `nodeId` through `execute`, having read it. */
async function agentWrites(
  request: APIRequestContext,
  canvasId: string,
  nodeId: string,
  patch: Record<string, unknown>,
) {
  const response = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId,
              patch,
              expectRev: await storedRevision(request, canvasId, nodeId),
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-properties-agent' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as {
    results: Array<{ applied: boolean; reason?: string }>;
    nodeContentRevisions?: Record<string, string>;
  };
  expect(body.results).toEqual([expect.objectContaining({ applied: true })]);
  // The response names the revision of what the server stored.
  expect(body.nodeContentRevisions?.[nodeId]).toBe(
    await storedRevision(request, canvasId, nodeId),
  );
}

/** Content saves of `nodeId` the server refused for this page. */
const refusedSaves = (device: Device, nodeId: string) =>
  device.conflicts.filter((call) => call.endsWith(`/nodes/${nodeId}/content`));

test("an agent's write to a PDF's properties while page B has it open: B's next property save on that PDF is taken", async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'PDF agent');
  const venue = (page: Page) =>
    panel(page, PDF).getByRole('button', { name: 'Edit venue' });

  // B reads the PDF with its properties open.
  await openPreview(b.page, PDF);
  await panel(b.page, PDF)
    .getByRole('button', { name: 'Expand properties' })
    .click();
  await expect(venue(b.page)).toHaveCount(0);
  await blur(b.page);

  // An agent sets a property on the PDF; nobody saved it from a page.
  await agentWrites(request, canvasId, PDF, {
    properties: { venue: 'NeurIPS' },
    propertyDisplayKeys: ['venue'],
  });
  for (const device of [a, b]) {
    await expect
      .poll(async () => (await storeState(device.page)).nodes[PDF].properties)
      .toEqual({ venue: 'NeurIPS' });
  }
  await expect(venue(b.page)).toHaveText('NeurIPS');
  await expect.poll(async () => (await storeState(b.page)).unsaved).toBe(false);

  // B adds another property: its save states the revision the update
  // brought, and the server takes it at the first attempt.
  await panel(b.page, PDF)
    .getByRole('button', { name: 'Add property' })
    .click();
  await panel(b.page, PDF)
    .getByRole('textbox', { name: 'Property name' })
    .fill('year');
  const value = panel(b.page, PDF).getByRole('textbox', { name: 'Value' });
  await value.fill('2026');
  await value.press('Enter');
  await expect
    .poll(
      async () =>
        (await serverRecord(request, canvasId)).node(PDF)?.data.properties,
    )
    .toEqual({ venue: 'NeurIPS', year: '2026' });
  await expect
    .poll(async () => (await storeState(a.page)).nodes[PDF].properties)
    .toEqual({ venue: 'NeurIPS', year: '2026' });

  await expect(b.page.getByText(SAVE_FAILED)).toHaveCount(0);
  await expect(b.page.getByText('was changed elsewhere')).toHaveCount(0);
  expect(refusedSaves(b, PDF)).toEqual([]);
  expect(refusedSaves(a, PDF)).toEqual([]);
  const state = await storeState(b.page);
  expect(state.pendingContent).toEqual([]);
  expect(state.reloaded).toBe(false);

  await a.context.close();
  await b.context.close();
});

test("a note body an agent wrote through execute is edited on page B afterwards: B's save is taken", async ({
  browser,
  request,
}) => {
  const { canvasId, a, b } = await openBoth(browser, request, 'Note agent');

  await agentWrites(request, canvasId, NOTE, { content: 'Agent body' });
  for (const device of [a, b]) {
    await expect
      .poll(async () =>
        (await storeState(device.page)).nodes[NOTE].content?.trim(),
      )
      .toBe('Agent body');
  }
  // Let preprocessing of the agent's write settle on both pages.
  await b.page.waitForTimeout(2_000);
  await expect.poll(async () => (await storeState(b.page)).unsaved).toBe(false);
  b.conflicts.length = 0;

  // B then edits the body the agent wrote.
  await openPreview(b.page, NOTE);
  const editor = panel(b.page, NOTE).locator(
    '.ProseMirror[contenteditable="true"]',
  );
  await expect(editor).toContainText('Agent body');
  await editor.fill('Agent body, continued on B');
  await expect
    .poll(async () =>
      (await serverRecord(request, canvasId)).node(NOTE)?.data.content?.trim(),
    )
    .toBe('Agent body, continued on B');
  await blur(b.page);
  await expect
    .poll(async () => (await storeState(a.page)).nodes[NOTE].content?.trim())
    .toBe('Agent body, continued on B');

  await expect(b.page.getByText('was changed elsewhere')).toHaveCount(0);
  expect(refusedSaves(b, NOTE)).toEqual([]);
  await expect
    .poll(async () => (await storeState(b.page)).pendingContent)
    .toEqual([]);
  expect((await storeState(b.page)).reloaded).toBe(false);

  await a.context.close();
  await b.context.close();
});
