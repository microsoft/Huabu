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
import type {
  ArtifactUploadResponse,
  CreateCanvasResponse,
} from '@huabu/shared';

/**
 * Select all, cut, paste and their undo between two pages.
 *
 * Two real browser contexts open the same Space against the real server,
 * storage and Canvas Sync stream. Page A works with the real keyboard, mouse
 * and system clipboard; page B only receives. Nothing is mocked and no store
 * is written from the test; the stores are read for evidence.
 *
 * - A cut is a copy followed by one `DELETE_NODES` batch through the send
 *   queue. No page sends a request of its own for a removed node's record.
 * - A paste is one batch that creates the nodes with fresh ids and their
 *   bodies, so the other page receives the bodies with the update.
 * - Undoing a cut is one `RESTORE_NODES` batch with the original ids, bodies
 *   and edges.
 * - Page B never loads the Space again, is not reloaded, gains no undo entry
 *   and writes nothing but measurement reports.
 */

// Mouse input: the default project emulates touch for the gesture suites.
test.use({ hasTouch: false });
test.describe.configure({ timeout: 90_000 });

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Every non-GET `/api/canvas/**` call this page made, without the Space id. */
  calls: string[];
  /** Commands of every `execute` request this page sent. */
  commands: Array<Record<string, unknown>>;
  /** `GET /api/canvas/:id` requests: loads of the whole Space. */
  spaceLoads: () => number;
}

interface WireNode {
  id: string;
  type?: string;
  parentId?: string | null;
  hidden?: boolean;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

interface WireEdge {
  id: string;
  source: string;
  target: string;
}

/** What the pages and the server must agree on. */
interface Scene {
  nodes: Record<
    string,
    {
      type: string;
      parentId: string | null;
      hidden: boolean;
      x: number;
      y: number;
      content: string | null;
      noteNodeId: string | null;
    }
  >;
  edges: string[];
}

function sceneOf(nodes: WireNode[], edges: WireEdge[]): Scene {
  const string = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    nodes: Object.fromEntries(
      nodes.map((node) => [
        node.id,
        {
          type: node.type ?? 'unknown',
          parentId: node.parentId ?? null,
          hidden: node.hidden === true,
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          // A PDF's extracted text is the server's: a load leaves it out and
          // a page may or may not hold it. It is read from the record instead.
          content:
            node.type === 'pdf'
              ? null
              : (string(node.data?.content)?.trim() ?? null),
          noteNodeId: string(node.data?.noteNodeId),
        },
      ]),
    ),
    edges: edges
      .map((edge) => `${edge.id}: ${edge.source} -> ${edge.target}`)
      .sort(),
  };
}

async function serverScene(request: APIRequestContext, canvasId: string) {
  const response = await request.get(`/api/canvas/${canvasId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as {
    version: number;
    state: { nodes: WireNode[]; edges: WireEdge[] };
  };
  return {
    version: record.version,
    scene: sceneOf(record.state.nodes, record.state.edges),
  };
}

/** What the page's store shows, read only. */
async function pageState(page: Page) {
  const state = await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store, hasUnsavedCanvasEdits } = (await import(
      path
    )) as typeof CanvasStore;
    const state = store.getState();
    return {
      version: state.version,
      unsaved: hasUnsavedCanvasEdits(),
      pendingContent: state.pendingContentNodeIds(),
      canUndo: state.canUndo,
      reloaded:
        (window as unknown as { __mpcLoaded?: boolean }).__mpcLoaded !== true,
      selected: state.nodes
        .filter((node) => node.selected)
        .map((node) => node.id)
        .sort(),
      nodes: state.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        parentId: node.parentId ?? null,
        hidden: node.hidden,
        position: node.position,
        data: node.data as Record<string, unknown>,
      })),
      edges: state.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    };
  });
  return { ...state, scene: sceneOf(state.nodes, state.edges) };
}

async function openDevice(
  browser: Browser,
  canvasId: string,
  name: string,
  visibleNodeId: string,
): Promise<Device> {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
  let loads = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path === `/api/canvas/${canvasId}`) loads += 1;
      return;
    }
    if (!path.startsWith('/api/canvas/')) return;
    calls.push(
      `${request.method()} ${path.replace(`/api/canvas/${canvasId}`, '<space>')}`,
    );
    if (path.endsWith('/execute')) {
      const body = request.postDataJSON() as {
        edits?: Array<{ commands?: Array<Record<string, unknown>> }>;
      } | null;
      commands.push(
        ...(body?.edits ?? []).flatMap((edit) => edit.commands ?? []),
      );
    }
  });
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.locator(`.react-flow__node[data-id="${visibleNodeId}"]`),
  ).toBeVisible();
  // A reload replaces the document; this marker proves one did not happen.
  await page.evaluate(() => {
    (window as unknown as { __mpcLoaded: boolean }).__mpcLoaded = true;
  });
  return { name, context, page, calls, commands, spaceLoads: () => loads };
}

/** Both pages have loaded the same version and nothing is waiting to save. */
async function openBoth(
  browser: Browser,
  request: APIRequestContext,
  canvasId: string,
  visibleNodeId: string,
) {
  const a = await openDevice(browser, canvasId, 'A', visibleNodeId);
  const b = await openDevice(browser, canvasId, 'B', visibleNodeId);
  // Outlast load-time measurement and first preprocessing.
  await a.page.waitForTimeout(2_000);
  await settled(request, canvasId, [a, b]);
  for (const device of [a, b]) {
    device.calls.length = 0;
    device.commands.length = 0;
  }
  return { a, b };
}

/** Every page is at the server's version with nothing left to send. */
async function settled(
  request: APIRequestContext,
  canvasId: string,
  devices: Device[],
) {
  await expect(async () => {
    const { version } = await serverScene(request, canvasId);
    for (const device of devices) {
      const state = await pageState(device.page);
      expect(state.unsaved, `${device.name} has nothing unsent`).toBe(false);
      expect(state.pendingContent, `${device.name} content saves`).toEqual([]);
      expect(state.version, `${device.name} version`).toBe(version);
    }
  }).toPass();
}

/**
 * Both pages hold what the server holds — ids, parents, positions, bodies,
 * PDF↔Note links and edges. Polled: an edit takes a round trip to arrive.
 */
async function expectConverged(
  request: APIRequestContext,
  canvasId: string,
  devices: Device[],
): Promise<Scene> {
  let scene: Scene | undefined;
  await expect(async () => {
    const server = await serverScene(request, canvasId);
    for (const device of devices) {
      const state = await pageState(device.page);
      expect(state.unsaved, `${device.name} has nothing unsent`).toBe(false);
      expect(state.scene, `${device.name} vs server`).toEqual(server.scene);
      expect(state.version, `${device.name} version`).toBe(server.version);
    }
    scene = server.scene;
  }).toPass({ timeout: 20_000 });
  if (!scene) throw new Error('The pages never converged');
  return scene;
}

/** Requests a page made that are not presence reports. */
const writes = (device: Device) =>
  device.calls.filter((call) => !call.includes('/presence'));

/** Commands a page sent that are a user's edit, not a measurement report. */
const edits = (device: Device) =>
  device.commands.filter(
    (command) =>
      command.type !== 'APPLY_MEASURED_HEIGHT' &&
      command.type !== 'APPLY_MEASURED_SIZE' &&
      command.type !== 'SET_NODE_SELECTION',
  );

async function toasts(page: Page) {
  return page
    .locator('body > div.fixed [role="status"]')
    .allTextContents()
    .then((texts) => texts.map((text) => text.trim()));
}

/**
 * Page B only received: it was not reloaded, did not load the Space again,
 * has nothing to undo and sent nothing but measurement reports.
 */
async function expectOnlyReceived(b: Device, loadsAtStart: number) {
  const state = await pageState(b.page);
  expect(state.reloaded, 'B was not reloaded').toBe(false);
  expect(b.spaceLoads(), 'B did not load the Space again').toBe(loadsAtStart);
  expect(state.canUndo, 'B has no undo entry for edits it did not make').toBe(
    false,
  );
  expect(edits(b), 'B sent no edit').toEqual([]);
  expect(
    writes(b).filter((call) => call !== 'POST <space>/execute'),
    'B wrote nothing else',
  ).toEqual([]);
  expect(await toasts(b.page), 'B shows no notice').toEqual([]);
}

/** Take focus out of every editor and clear the selection. */
async function clickPane(page: Page) {
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 30, y: 640 } });
}

const N1 = 'node-mpc-one';
const N2 = 'node-mpc-two';
const TEXT = 'node-mpc-text';
const FRAME = 'node-mpc-frame';
const CHILD = 'node-mpc-child';
const EDGE = 'edge-mpc-one-two';

function note(
  id: string,
  x: number,
  y: number,
  content: string,
  parentId?: string,
) {
  return {
    id,
    nodeType: 'note',
    ...(parentId ? { parentId } : {}),
    data: {
      type: 'note',
      label: `Label ${id}`,
      // A title the user gave: preprocessing leaves it alone.
      labelSource: 'user',
      content,
      heightMode: 'fixed',
    },
    selectOnCreate: false,
    position: { x, y },
    size: { width: 160, height: 90 },
  };
}

async function createSpace(request: APIRequestContext, title: string) {
  const created = await request.post('/api/canvas', { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as CreateCanvasResponse).canvasId;
}

async function seed(
  request: APIRequestContext,
  canvasId: string,
  commands: unknown[],
) {
  const seeded = await request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand(commands),
      originator: { tabId: 'e2e-multi-page-clipboard-seed' },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const body = (await seeded.json()) as {
    edits?: { results: { applied?: boolean; reason?: string }[] }[];
  };
  expect(
    (body.edits ?? [])
      .map((edit) => edit.results[0])
      .filter((result) => result?.applied === false),
    'every seed command applied',
  ).toEqual([]);
}

test('select all and cut on page A empties page B; paste and undo arrive there with bodies, edges and Frame children', async ({
  browser,
  request,
}) => {
  const canvasId = await createSpace(request, 'Two pages, one clipboard');
  await seed(request, canvasId, [
    {
      type: 'CREATE_NODES',
      nodes: [
        note(N1, 80, 110, 'Body of one'),
        note(N2, 340, 110, 'Body of two'),
        {
          id: TEXT,
          nodeType: 'text',
          data: { content: 'Body of text' },
          selectOnCreate: false,
          position: { x: 600, y: 110 },
        },
        {
          id: FRAME,
          nodeType: 'frame',
          data: { type: 'frame', label: 'Frame', labelSource: 'user' },
          selectOnCreate: false,
          position: { x: 80, y: 280 },
          size: { width: 360, height: 220 },
        },
        note(CHILD, 40, 70, 'Body of the child', FRAME),
      ],
    },
    {
      type: 'CONNECT_NODES',
      edges: [{ id: EDGE, source: N1, target: N2 }],
    },
  ]);
  const { a, b } = await openBoth(browser, request, canvasId, N1);
  const loadsAtStart = b.spaceLoads();
  const original = await expectConverged(request, canvasId, [a, b]);
  expect(Object.keys(original.nodes).sort()).toEqual(
    [N1, N2, TEXT, FRAME, CHILD].sort(),
  );
  expect(original.nodes[CHILD].parentId).toBe(FRAME);
  expect(original.edges).toEqual([`${EDGE}: ${N1} -> ${N2}`]);
  const bodies = (scene: Scene) =>
    Object.values(scene.nodes)
      .map((node) => `${node.type}: ${node.content ?? ''}`)
      .sort();

  // ── A selects everything and cuts it ──────────────────────────────────
  await a.page.bringToFront();
  await clickPane(a.page);
  await a.page.keyboard.press('ControlOrMeta+a');
  await expect
    .poll(async () => (await pageState(a.page)).selected)
    .toEqual([N1, N2, TEXT, FRAME, CHILD].sort());
  await a.page.keyboard.press('ControlOrMeta+x');
  await expect(a.page.locator('.react-flow__node')).toHaveCount(0);

  // B shows them gone, edge included, and so does the server.
  await expect(b.page.locator('.react-flow__node')).toHaveCount(0);
  await expect(b.page.locator('.react-flow__edge')).toHaveCount(0);
  let scene = await expectConverged(request, canvasId, [a, b]);
  expect(scene).toEqual({ nodes: {}, edges: [] });
  // One deleting batch through the send queue, and no request by either
  // page for a removed node's record.
  const deletions = edits(a).filter(
    (command) => command.type === 'DELETE_NODES',
  );
  expect(deletions).toHaveLength(1);
  expect((deletions[0].nodeIds as string[]).slice().sort()).toEqual(
    [N1, N2, TEXT, FRAME, CHILD].sort(),
  );
  expect(edits(a)).toEqual(deletions);
  expect(
    [...a.calls, ...b.calls].filter((call) => call.startsWith('DELETE ')),
  ).toEqual([]);
  await expectOnlyReceived(b, loadsAtStart);
  expect(await toasts(a.page)).toEqual([]);

  // ── A pastes from the real clipboard ──────────────────────────────────
  a.commands.length = 0;
  await a.page.mouse.move(220, 180);
  await a.page.keyboard.press('ControlOrMeta+v');
  await expect(a.page.locator('.react-flow__node')).toHaveCount(5);
  await expect(b.page.locator('.react-flow__node')).toHaveCount(5);
  scene = await expectConverged(request, canvasId, [a, b]);
  const pasted = scene;
  // New nodes, not the originals, with every body.
  for (const id of Object.keys(original.nodes))
    expect(pasted.nodes[id], `${id} is not reused`).toBeUndefined();
  expect(bodies(pasted)).toEqual(bodies(original));
  const pastedId = (content: string) => {
    const found = Object.entries(pasted.nodes).filter(
      ([, node]) => node.content === content,
    );
    expect(found, `one pasted node reads "${content}"`).toHaveLength(1);
    return found[0][0];
  };
  const pastedFrame = Object.entries(pasted.nodes).find(
    ([, node]) => node.type === 'frame',
  )?.[0];
  expect(pasted.nodes[pastedId('Body of the child')].parentId).toBe(
    pastedFrame,
  );
  // The edge between the two cut notes came along, between their copies.
  expect(pasted.edges).toHaveLength(1);
  expect(pasted.edges[0]).toContain(
    `: ${pastedId('Body of one')} -> ${pastedId('Body of two')}`,
  );
  // B renders the pasted bodies.
  for (const text of ['Body of one', 'Body of two', 'Body of the child'])
    await expect(
      b.page.locator('.react-flow__node').filter({ hasText: text }),
    ).toHaveCount(1);
  await expect(b.page.locator('.react-flow__edge')).toHaveCount(1);
  // One creating batch, with the ids page A already shows and the bodies.
  const creations = edits(a).filter(
    (command) => command.type === 'CREATE_NODES',
  );
  expect(creations).toHaveLength(1);
  const createdNodes = creations[0].nodes as Array<{
    id?: string;
    data?: { content?: string };
  }>;
  expect(createdNodes.map((node) => node.id).sort()).toEqual(
    Object.keys(pasted.nodes).sort(),
  );
  expect(
    createdNodes.map((node) => node.data?.content?.trim() ?? '').sort(),
  ).toEqual(
    Object.values(original.nodes)
      .map((node) => node.content ?? '')
      .sort(),
  );
  await expectOnlyReceived(b, loadsAtStart);

  // ── A undoes the paste, then the cut ──────────────────────────────────
  a.commands.length = 0;
  await clickPane(a.page);
  await a.page.keyboard.press('ControlOrMeta+z');
  await expect(a.page.locator('.react-flow__node')).toHaveCount(0);
  await expect(b.page.locator('.react-flow__node')).toHaveCount(0);
  scene = await expectConverged(request, canvasId, [a, b]);
  expect(scene).toEqual({ nodes: {}, edges: [] });

  a.commands.length = 0;
  await a.page.keyboard.press('ControlOrMeta+z');
  await expect(a.page.locator('.react-flow__node')).toHaveCount(5);
  // B shows the originals back: same ids, parents, bodies and the edge.
  await expect(b.page.locator('.react-flow__node')).toHaveCount(5);
  scene = await expectConverged(request, canvasId, [a, b]);
  const identity = (from: Scene) => ({
    nodes: Object.fromEntries(
      Object.entries(from.nodes).map(([id, node]) => [
        id,
        { type: node.type, parentId: node.parentId, content: node.content },
      ]),
    ),
    edges: from.edges,
  });
  expect(identity(scene)).toEqual(identity(original));
  for (const id of [N1, N2, CHILD])
    await expect(
      b.page.locator(`.react-flow__node[data-id="${id}"]`),
    ).toContainText(original.nodes[id].content ?? '');
  await expect(
    b.page.locator(`.react-flow__node[data-id="${TEXT}"]`),
  ).toContainText('Body of text');
  await expect(b.page.locator('.react-flow__edge')).toHaveCount(1);
  // The originals went back in restoring commands that carry their bodies;
  // nothing wrote a body a second time.
  const restored = edits(a)
    .filter((command) => command.type === 'RESTORE_NODES')
    .flatMap(
      (command) =>
        (command.nodes ?? []) as Array<{
          id: string;
          data?: { content?: string };
        }>,
    );
  expect(restored.map((node) => node.id).sort()).toEqual(
    [N1, N2, TEXT, FRAME, CHILD].sort(),
  );
  expect(restored.find((node) => node.id === N1)?.data?.content?.trim()).toBe(
    'Body of one',
  );
  expect(
    [...a.calls, ...b.calls].filter(
      (call) => call.startsWith('DELETE ') || /^PUT <space>$/.test(call),
    ),
  ).toEqual([]);
  expect(
    a.calls.filter((call) => /^PUT <space>\/nodes\/.+\/content$/.test(call)),
    'no content save was needed for a cut, a paste or their undo',
  ).toEqual([]);
  await expectOnlyReceived(b, loadsAtStart);
  expect(await toasts(a.page)).toEqual([]);

  // B was left in a working state: it can cut one of the restored notes,
  // and A sees it go.
  await b.page.bringToFront();
  await b.page
    .locator(`.react-flow__node[data-id="${N2}"]`)
    .click({ position: { x: 80, y: 12 } });
  await b.page.keyboard.press('ControlOrMeta+x');
  await expect(
    a.page.locator(`.react-flow__node[data-id="${N2}"]`),
  ).toHaveCount(0);
  scene = await expectConverged(request, canvasId, [a, b]);
  expect(Object.keys(scene.nodes).sort()).toEqual(
    [N1, TEXT, FRAME, CHILD].sort(),
  );
  expect(scene.edges).toEqual([]);

  await a.context.close();
  await b.context.close();
});

const PDF = 'node-mpc-pdf';
const BYSTANDER = 'node-mpc-bystander';
const EXTRACTED = 'Extracted text two pages share';

function textPdf() {
  const stream = `BT /F1 18 Tf 40 700 Td (${EXTRACTED}) Tj ET`;
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

/** The preview panel of one node. */
const panel = (page: Page, id: string) =>
  page.locator(`[data-search-scope="node"][data-search-node-id="${id}"]`);

test('cutting a PDF with its note on page A and undoing brings both back on page B, linked, with the note text and the PDF text extracted again', async ({
  browser,
  request,
}) => {
  const canvasId = await createSpace(request, 'Cut a PDF and its note');
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
  await seed(request, canvasId, [
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: PDF,
          nodeType: 'pdf',
          data: {
            type: 'pdf',
            label: 'Paper',
            labelSource: 'user',
            src: uri,
            // Stands in for text extracted when the PDF was first added.
            content: 'Seeded body',
          },
          selectOnCreate: false,
          position: { x: 380, y: 90 },
          size: { width: 300, height: 380 },
        },
        note(BYSTANDER, 760, 90, 'Body of the bystander'),
      ],
    },
  ]);
  const pdfText = async () => {
    const response = await request.get(
      `/api/canvas/${canvasId}/nodes/${PDF}/content`,
    );
    return response.ok()
      ? (((await response.json()) as { content?: string }).content ?? '')
      : '';
  };
  const { a, b } = await openBoth(browser, request, canvasId, BYSTANDER);
  const loadsAtStart = b.spaceLoads();
  await expect.poll(pdfText).toBe('Seeded body');

  // A creates the PDF's Note from the preview header and writes into it.
  await a.page.bringToFront();
  await a.page
    .locator(`.react-flow__node[data-id="${PDF}"]`)
    .click({ position: { x: 150, y: 12 } });
  await a.page.getByRole('button', { name: 'Open Large View' }).click();
  await expect(panel(a.page, PDF)).toBeVisible();
  await panel(a.page, PDF).getByRole('button', { name: 'Add notes' }).click();
  await expect
    .poll(async () => (await pageState(a.page)).scene.nodes[PDF]?.noteNodeId)
    .toBeTruthy();
  const noteId = (await pageState(a.page)).scene.nodes[PDF].noteNodeId;
  if (!noteId) throw new Error('The PDF was not given a Note');
  const editor = panel(a.page, noteId).locator(
    '.ProseMirror[contenteditable="true"]',
  );
  await expect(editor).toBeVisible();
  await editor.fill('Notes by page A');
  await expect
    .poll(
      async () =>
        (await serverScene(request, canvasId)).scene.nodes[noteId]?.content,
    )
    .toBe('Notes by page A');
  await clickPane(a.page);
  const linked = await expectConverged(request, canvasId, [a, b]);
  expect(linked.nodes[PDF].noteNodeId).toBe(noteId);
  expect(linked.nodes[noteId]).toMatchObject({
    type: 'note',
    hidden: true,
    content: 'Notes by page A',
  });
  await settled(request, canvasId, [a, b]);
  a.commands.length = 0;
  a.calls.length = 0;
  b.calls.length = 0;
  b.commands.length = 0;

  // ── A cuts the PDF; its Note goes with it ─────────────────────────────
  await a.page
    .locator(`.react-flow__node[data-id="${PDF}"]`)
    .click({ position: { x: 150, y: 12 } });
  await a.page.keyboard.press('ControlOrMeta+x');
  await expect(
    a.page.locator(`.react-flow__node[data-id="${PDF}"]`),
  ).toHaveCount(0);
  await expect(
    b.page.locator(`.react-flow__node[data-id="${PDF}"]`),
  ).toHaveCount(0);
  let scene = await expectConverged(request, canvasId, [a, b]);
  expect(Object.keys(scene.nodes)).toEqual([BYSTANDER]);
  expect(edits(a).filter((command) => command.type === 'DELETE_NODES')).toEqual(
    [{ type: 'DELETE_NODES', nodeIds: [PDF] }],
  );
  // The record went with the deleting batch, extracted text included.
  await expect.poll(pdfText, { timeout: 10_000 }).toBe('');
  expect(
    [...a.calls, ...b.calls].filter((call) => call.startsWith('DELETE ')),
  ).toEqual([]);
  expect(await toasts(a.page)).toEqual([]);

  // ── A undoes: one batch restores the pair ─────────────────────────────
  a.commands.length = 0;
  await a.page.keyboard.press('ControlOrMeta+z');
  await expect(
    a.page.locator(`.react-flow__node[data-id="${PDF}"]`),
  ).toBeVisible();
  scene = await expectConverged(request, canvasId, [a, b]);
  expect(scene.nodes[PDF].noteNodeId).toBe(noteId);
  expect(scene.nodes[noteId]).toMatchObject({
    type: 'note',
    hidden: true,
    content: 'Notes by page A',
  });
  const restore = edits(a).filter(
    (command) => command.type === 'RESTORE_NODES',
  );
  expect(restore).toHaveLength(1);
  expect(
    (restore[0].nodes as Array<{ id: string }>).map((node) => node.id).sort(),
  ).toEqual([PDF, noteId].sort());

  // B has both back and linked, shows the PDF, and reads the note's text
  // from its own PDF preview.
  await expect(
    b.page.locator(`.react-flow__node[data-id="${PDF}"]`),
  ).toBeVisible();
  await expect(
    b.page.locator(`.react-flow__node[data-id="${noteId}"]`),
  ).toHaveCount(0);
  for (const device of [a, b])
    await expect(device.page.locator('.missing-file-banner')).toHaveCount(0);
  // The web never held the PDF's text, so the restore could not carry it.
  // What returns is text the server extracted again from the file.
  await expect.poll(pdfText, { timeout: 20_000 }).toContain(EXTRACTED);
  await expectOnlyReceived(b, loadsAtStart);
  await b.page.bringToFront();
  await b.page
    .locator(`.react-flow__node[data-id="${PDF}"]`)
    .click({ position: { x: 150, y: 12 } });
  await b.page.getByRole('button', { name: 'Open Large View' }).click();
  await panel(b.page, PDF).getByRole('button', { name: 'Open notes' }).click();
  await expect(panel(b.page, noteId).locator('.ProseMirror')).toHaveText(
    'Notes by page A',
  );
  expect(
    b.commands.filter((command) => command.type === 'INITIALIZE_PDF_NOTE'),
  ).toEqual([]);
  expect((await pageState(b.page)).reloaded).toBe(false);
  expect(b.spaceLoads()).toBe(loadsAtStart);
  expect(
    [...a.calls, ...b.calls].filter(
      (call) => call.startsWith('DELETE ') || /^PUT <space>$/.test(call),
    ),
  ).toEqual([]);
  for (const device of [a, b])
    await expect(device.page.locator('.missing-file-banner')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});
