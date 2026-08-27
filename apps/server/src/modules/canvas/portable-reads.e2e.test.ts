// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * End-to-end coverage for the backend-agnostic read surface.
 *
 * Every scenario here drives a **real** stack: a temp Workspace on disk, the
 * Disk adapters behind the storage ports, and the Canvas routes registered on
 * a real Fastify instance. Nothing is mocked. The unit suites beside each
 * module already prove that a given reader calls the port; what they cannot
 * show is that the whole request path still answers the same way once every
 * read goes through `space(canvasId)` — including the two behaviours this
 * change set moved on purpose (a duplicated Space directory now fails loudly,
 * and a hand-damaged node sidecar renders instead of 422'ing a preview).
 *
 * Scenarios are grouped by the surface a user reaches:
 *
 *   1. the four node-read shapes agreeing with each other
 *   2. `GET /canvas/:id` — the Space a client opens
 *   3. `GET /canvas/:id/preview-scene` — the Portal projection
 *   4. duplicate Space directories — the catalogue's integrity failure
 *   5. `GET /canvas/:id/references` — World reference resolution
 *   6. `POST /canvas/:id/search` — the sidecar scan
 *   7. `GET /canvas/:id/export` + `POST /canvas/import` — the bundle format
 *   8. Workspace switching — a retained handle must not read the new one
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import multipart from '@fastify/multipart';
import archiver from 'archiver';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import canvasRoutes from './canvas.route.js';
import { refreshCanvasDirIndex } from '../storage/backends/disk/canvas-dirs.js';
import {
  createSpace,
  getStructuredStore,
  resetStorageCache,
  space,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasFile, NodeContent } from '../storage/index.js';
import type { FastifyInstance } from 'fastify';

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface SeedNode {
  readonly id: string;
  readonly type: string;
  readonly label: string | null;
  readonly content?: string;
  readonly position?: { x: number; y: number };
  /** Extra topology `data` fields — Portal targets, question state, … */
  readonly data?: Record<string, unknown>;
  /** Omit the sidecar entirely; the node exists in topology only. */
  readonly sidecar?: false;
}

interface SeedEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
}

let workspacePath: string;
let app: FastifyInstance;

function freshWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-portable-reads-'));
  setWorkspacePath(root);
  resetStorageCache();
  return root;
}

async function buildApp(): Promise<FastifyInstance> {
  const instance = fastify();
  await instance.register(multipart);
  await instance.register(canvasRoutes, { prefix: '/canvas' });
  await instance.ready();
  return instance;
}

function topologyNode(node: SeedNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    position: node.position ?? { x: 0, y: 0 },
    data: { label: node.label, ...(node.data ?? {}) },
  };
}

function nodeRecord(node: SeedNode): NodeContent {
  return {
    nodeId: node.id,
    type: node.type,
    label: node.label,
    content: node.content ?? '',
  };
}

/** Create a Space and install one topology + sidecar generation through the port. */
async function seedSpace(
  canvasId: string,
  title: string | null,
  nodes: readonly SeedNode[] = [],
  edges: readonly SeedEdge[] = [],
): Promise<CanvasFile> {
  const created = await createSpace(canvasId, title);
  if (!created.ok) throw new Error(`seed failed for ${canvasId}`);
  return writeTopology(canvasId, nodes, edges);
}

/** Replace a Space's topology and sidecars, whatever its current version. */
async function writeTopology(
  canvasId: string,
  nodes: readonly SeedNode[],
  edges: readonly SeedEdge[] = [],
): Promise<CanvasFile> {
  const handle = space(canvasId);
  const current = await handle.read();
  if (!current) throw new Error(`no Space record for ${canvasId}`);
  const nextRecord: CanvasFile = {
    ...current,
    version: current.version + 1,
    updatedAt: Date.now(),
    state: {
      ...current.state,
      nodes: nodes.map(topologyNode),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label === undefined ? {} : { data: { label: edge.label } }),
      })),
    },
  };
  const result = await handle.write({
    expectedVersion: current.version,
    nextRecord,
    nodeMutations: nodes
      .filter((node) => node.sidecar !== false)
      .map((node) => ({
        kind: 'put' as const,
        nodeId: node.id,
        record: nodeRecord(node),
      })),
  });
  if (!result.ok) throw new Error(`seed write failed: ${result.reason}`);
  return nextRecord;
}

/**
 * Disk's own directory for a Space.
 *
 * The tests reach for it to damage a Space the way a user with a file manager
 * would — which is exactly the capability `diskTree` exists to name, and the
 * only reason a test may know a Space is a folder.
 */
function spaceDirectory(canvasId: string): string {
  const tree = space(canvasId).diskTree;
  if (!tree) throw new Error('expected a Disk-backed Space');
  return tree.directory();
}

function spaceNodesDirectory(canvasId: string): string {
  const tree = space(canvasId).diskTree;
  if (!tree) throw new Error('expected a Disk-backed Space');
  return tree.nodesDirectory();
}

/** Hand-write a sidecar the way a user editing files outside the app would. */
function writeSidecarByHand(
  canvasId: string,
  filename: string,
  body: string,
): void {
  const dir = spaceNodesDirectory(canvasId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), body, 'utf8');
  resetStorageCache();
}

/** Overwrite a Space record on disk, bypassing the port's version check. */
function writeRecordByHand(canvasId: string, record: unknown): void {
  writeFileSync(
    path.join(spaceDirectory(canvasId), 'space.json'),
    JSON.stringify(record, null, 2),
    'utf8',
  );
  resetStorageCache();
}

function multipartBody(
  filename: string,
  body: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----huabu-portable-reads';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Build a Space bundle by hand, so an older on-the-wire shape can be replayed. */
async function makeBundle(entries: Record<string, string>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const [name, content] of Object.entries(entries)) {
    archive.append(content, { name });
  }
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}

/** Read an NDJSON search response back into its events. */
function ndjson(payload: string): Record<string, unknown>[] {
  return payload
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  workspacePath = freshWorkspace();
  await getStructuredStore().spaces().ensureWorld();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  resetStorageCache();
  rmSync(workspacePath, { recursive: true, force: true });
});

// ─── 1. The four node-read shapes ───────────────────────────────────────────

describe('node reads through the port', () => {
  it('serves the same records and revisions through read, readMany, list, and stream', async () => {
    await seedSpace('canvas-shapes', 'Shapes', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'alpha body' },
      { id: 'node-b', type: 'note', label: 'Beta', content: 'beta body' },
      { id: 'node-c', type: 'text', label: 'Gamma', content: 'gamma body' },
    ]);
    const nodes = space('canvas-shapes').nodes;

    const listed = await nodes.list();
    const streamed = new Map<string, unknown>();
    const settled = await nodes.stream((snapshot) => {
      streamed.set(snapshot.record.nodeId, snapshot);
    });
    const selected = await nodes.readMany(['node-a', 'node-c']);
    const single = await nodes.read('node-a');

    expect([...listed.keys()].sort()).toEqual(['node-a', 'node-b', 'node-c']);
    expect(settled).toEqual(listed);
    expect(streamed.size).toBe(3);
    expect(single).toEqual(listed.get('node-a'));
    expect(selected.get('node-a')).toEqual(listed.get('node-a'));
    expect(selected.get('node-c')).toEqual(listed.get('node-c'));
    // The revision is the port's own opaque token; the same record must not
    // produce two of them depending on which shape asked for it.
    expect(single?.revision).toBe(listed.get('node-a')?.revision);
  });

  it('treats an absent id in readMany as a missing key and collapses repeats', async () => {
    await seedSpace('canvas-select', 'Select', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'a' },
    ]);

    const selected = await space('canvas-select').nodes.readMany([
      'node-a',
      'node-a',
      'node-missing',
    ]);

    expect(selected.size).toBe(1);
    expect(selected.has('node-missing')).toBe(false);
    expect(await space('canvas-select').nodes.read('node-missing')).toBeNull();
  });

  it('stops a streamed scan early when the caller aborts, and still settles', async () => {
    // More nodes than the adapter's read concurrency, so aborting on the first
    // delivery still leaves work the scan can decline to do.
    const total = 128;
    await seedSpace(
      'canvas-abort',
      'Abort',
      Array.from({ length: total }, (_, i) => ({
        id: `node-${i}`,
        type: 'note',
        label: `Node ${i}`,
        content: `body ${i}`,
      })),
    );

    const signal = { aborted: false };
    const seen: string[] = [];
    const settled = await space('canvas-abort').nodes.stream(
      (snapshot) => {
        seen.push(snapshot.record.nodeId);
        signal.aborted = true;
      },
      { signal },
    );

    // The promise still settles — an aborted scan must not leak a pending
    // read — but its map is partial by definition.
    expect(seen.length).toBeGreaterThan(0);
    expect(settled.size).toBeLessThan(total);
    expect(settled.size).toBe(seen.length);
  });

  it('recovers a hand-broken sidecar identically through read and list', async () => {
    await seedSpace('canvas-broken', 'Broken', [
      { id: 'node-ok', type: 'note', label: 'Fine', content: 'fine' },
    ]);
    writeSidecarByHand(
      'canvas-broken',
      'node-damaged.md',
      '---\nlabel: [unterminated\n---\nthe body survives\n',
    );

    const nodes = space('canvas-broken').nodes;
    const single = await nodes.read('node-damaged');
    const listed = await nodes.list();

    // Broken YAML is dropped, the markdown body is kept, and both shapes
    // report the node the same way.
    expect(single?.record.content.trim()).toBe('the body survives');
    expect(single?.record.label).toBeNull();
    expect(listed.get('node-damaged')).toEqual(single);
  });

  it('rejects both collection scans when a record cannot be retrieved at all', async () => {
    await seedSpace('canvas-unreadable', 'Unreadable', [
      { id: 'node-ok', type: 'note', label: 'Fine', content: 'fine' },
    ]);
    // A directory where a sidecar should be: reachable-but-unreadable, which
    // is the environmental failure the port says must never look like absence.
    mkdirSync(
      path.join(spaceNodesDirectory('canvas-unreadable'), 'node-blocked.md'),
      { recursive: true },
    );
    resetStorageCache();

    const nodes = space('canvas-unreadable').nodes;
    await expect(nodes.list()).rejects.toThrow();
    // The streamed shape answers the same way, so a caller cannot pick the
    // scan that hides the failure.
    await expect(nodes.stream(() => {})).rejects.toThrow();
  });
});

// ─── 2. GET /canvas/:id ─────────────────────────────────────────────────────

describe('GET /canvas/:canvasId', () => {
  it('hydrates node bodies that live only in the sidecars', async () => {
    await seedSpace('canvas-get', 'Get', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'sidecar body' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-get',
    });

    expect(response.statusCode).toBe(200);
    const node = response.json().state.nodes[0];
    expect(node.data.content).toBe('sidecar body');
    // The body must not have been round-tripped into the topology record.
    const record = await space('canvas-get').read();
    expect(JSON.stringify(record?.state.nodes)).not.toContain('sidecar body');
  });

  it('still serves a Space whose sidecar frontmatter a user broke', async () => {
    await seedSpace('canvas-get-broken', 'Get broken', [
      { id: 'node-damaged', type: 'note', label: 'Damaged', sidecar: false },
    ]);
    writeSidecarByHand(
      'canvas-get-broken',
      'node-damaged.md',
      '---\nlabel: [unterminated\n---\nstill readable\n',
    );

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-get-broken',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state.nodes[0].data.content).toContain(
      'still readable',
    );
  });

  it('answers 404 for a Space that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-absent',
    });

    expect(response.statusCode).toBe(404);
  });
});

// ─── 3. GET /canvas/:id/preview-scene ───────────────────────────────────────

describe('GET /canvas/:canvasId/preview-scene', () => {
  it('projects records and topology into one bounded scene', async () => {
    await seedSpace(
      'canvas-preview',
      'Preview',
      [
        {
          id: 'node-a',
          type: 'note',
          label: 'Alpha',
          content: '# Heading\n\nSome **preview** text.',
          position: { x: 10, y: 20 },
        },
        {
          id: 'node-b',
          type: 'note',
          label: 'Beta',
          content: 'beta body',
          position: { x: 300, y: 20 },
        },
      ],
      [{ id: 'edge-1', source: 'node-a', target: 'node-b', label: 'links' }],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-preview/preview-scene',
    });

    expect(response.statusCode).toBe(200);
    const scene = response.json();
    expect(scene.nodes).toHaveLength(2);
    expect(scene.nodes[0]).toMatchObject({
      id: 'node-a',
      kind: 'content',
      x: 10,
      y: 20,
    });
    // Markdown is stripped for the preview text, and it comes from the record.
    expect(scene.nodes[0].previewText).toContain('Some preview text');
    expect(scene.edges).toEqual([
      expect.objectContaining({ id: 'edge-1', label: 'links' }),
    ]);
    expect(scene.truncated).toEqual({ nodes: false, edges: false });
  });

  it('renders a damaged sidecar instead of refusing the whole projection', async () => {
    // The behaviour this change set moved on purpose: the preview used to read
    // sidecars strictly and answer 422 when one failed to parse. It now reads
    // the same lenient collection the Space's own view does.
    await seedSpace('canvas-preview-damaged', 'Damaged preview', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'alpha' },
      { id: 'node-damaged', type: 'note', label: 'Damaged', sidecar: false },
    ]);
    writeSidecarByHand(
      'canvas-preview-damaged',
      'node-damaged.md',
      '---\nkeywords: [oops\n---\nrecovered body\n',
    );

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-preview-damaged/preview-scene',
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().nodes.map((node: { id: string }) => node.id);
    expect(ids).toEqual(['node-a', 'node-damaged']);
  });

  it('falls back to topology data for a node with no sidecar at all', async () => {
    await seedSpace('canvas-preview-bare', 'Bare preview', [
      {
        id: 'node-bare',
        type: 'note',
        label: 'Bare',
        sidecar: false,
        data: { content: 'topology fallback' },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-preview-bare/preview-scene',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().nodes[0]).toMatchObject({
      id: 'node-bare',
      label: 'Bare',
      previewText: 'topology fallback',
    });
  });

  it('keeps 422 for a malformed Space record', async () => {
    await seedSpace('canvas-preview-malformed', 'Malformed', []);
    writeRecordByHand('canvas-preview-malformed', {
      canvasId: 'canvas-preview-malformed',
      title: 'Malformed',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      state: { nodes: 'not an array', edges: [] },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-preview-malformed/preview-scene',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain('malformed');
  });

  it('answers 404 for an absent Space and for the World Space', async () => {
    const worldId = await getStructuredStore().spaces().worldId();

    const absent = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-absent/preview-scene',
    });
    const world = await app.inject({
      method: 'GET',
      url: `/canvas/${worldId}/preview-scene`,
    });

    expect(absent.statusCode).toBe(404);
    expect(world.statusCode).toBe(404);
  });
});

// ─── 4. Duplicate Space directories ─────────────────────────────────────────

describe('two directories claiming one Space', () => {
  it('fails every catalogue read loudly and names both directories', async () => {
    await seedSpace('canvas-dupe', 'Duplicated', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'a' },
    ]);
    cpSync(
      spaceDirectory('canvas-dupe'),
      path.join(workspacePath, 'Duplicated copy'),
      { recursive: true },
    );
    refreshCanvasDirIndex();

    const listed = await app.inject({ method: 'GET', url: '/canvas' });

    expect(listed.statusCode).toBe(500);
    await expect(getStructuredStore().spaces().list()).rejects.toThrow(
      /duplicate directories.*Duplicated.*Duplicated copy/s,
    );
  });

  it('recovers as soon as one of the two directories is removed', async () => {
    await seedSpace('canvas-dupe-fix', 'Fixable', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'a' },
    ]);
    const copy = path.join(workspacePath, 'Fixable copy');
    cpSync(spaceDirectory('canvas-dupe-fix'), copy, { recursive: true });
    refreshCanvasDirIndex();
    await expect(getStructuredStore().spaces().list()).rejects.toThrow();

    rmSync(copy, { recursive: true, force: true });
    refreshCanvasDirIndex();

    const listed = await app.inject({ method: 'GET', url: '/canvas' });
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json()
        .canvases.map((entry: { canvasId: string }) => entry.canvasId),
    ).toContain('canvas-dupe-fix');
  });
});

// ─── 5. GET /canvas/:id/references ──────────────────────────────────────────

describe('GET /canvas/:canvasId/references', () => {
  async function seedWorld(nodes: readonly SeedNode[]): Promise<string> {
    const worldId = await getStructuredStore().spaces().worldId();
    await writeTopology(worldId, nodes);
    return worldId;
  }

  it('resolves Portal and node references through the ports', async () => {
    await seedSpace('canvas-src', 'Source', [
      {
        id: 'node-target',
        type: 'note',
        label: 'Target',
        content: 'target body',
      },
    ]);
    const worldId = await seedWorld([
      {
        id: 'node-portal',
        type: 'canvasRef',
        label: null,
        sidecar: false,
        data: { targetCanvasId: 'canvas-src' },
      },
      {
        id: 'node-ref',
        type: 'nodeRef',
        label: null,
        sidecar: false,
        data: { target: { canvasId: 'canvas-src', nodeId: 'node-target' } },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/canvas/${worldId}/references`,
    });

    expect(response.statusCode).toBe(200);
    const { references } = response.json();
    expect(references).toEqual([
      expect.objectContaining({
        kind: 'canvasRef',
        targetCanvasId: 'canvas-src',
        status: 'ok',
        title: 'Source',
      }),
      expect.objectContaining({
        kind: 'nodeRef',
        status: 'ok',
        source: expect.objectContaining({ type: 'note', label: 'Target' }),
      }),
    ]);
  });

  it('reports a missing Space and a missing node distinctly', async () => {
    await seedSpace('canvas-partial', 'Partial', [
      { id: 'node-present', type: 'note', label: 'Present', content: 'here' },
    ]);
    const worldId = await seedWorld([
      {
        id: 'node-portal',
        type: 'canvasRef',
        label: null,
        sidecar: false,
        data: { targetCanvasId: 'canvas-gone' },
      },
      {
        id: 'node-ref',
        type: 'nodeRef',
        label: null,
        sidecar: false,
        data: { target: { canvasId: 'canvas-partial', nodeId: 'node-gone' } },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/canvas/${worldId}/references`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().references.map((ref: { status: string }) => ref.status),
    ).toEqual(['canvas-missing', 'node-missing']);
  });

  it('refuses to resolve references for an ordinary Space', async () => {
    await seedSpace('canvas-ordinary', 'Ordinary', []);

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-ordinary/references',
    });

    expect(response.statusCode).toBe(400);
  });
});

// ─── 6. POST /canvas/:id/search ─────────────────────────────────────────────

describe('POST /canvas/:canvasId/search', () => {
  it('finds text that exists only in a node sidecar', async () => {
    await seedSpace('canvas-search', 'Search', [
      {
        id: 'node-a',
        type: 'note',
        label: 'Alpha',
        content: 'the needle is in the body',
      },
      { id: 'node-b', type: 'note', label: 'Beta', content: 'unrelated' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/canvas/canvas-search/search',
      payload: { query: 'needle' },
    });

    expect(response.statusCode).toBe(200);
    const events = ndjson(response.payload);
    const matches = events.filter((event) => event.type === 'match');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      tier: 'content',
      match: {
        nodeId: 'node-a',
        field: 'content',
        snippet: expect.stringContaining('needle'),
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('answers 404 before opening a stream for an absent Space', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/canvas/canvas-absent/search',
      payload: { query: 'needle' },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ─── 7. Bundle export and import ────────────────────────────────────────────

describe('Space bundle round trip', () => {
  it('re-imports an exported bundle as a new Space with its node records', async () => {
    await seedSpace('canvas-export', 'Exported', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'exported body' },
    ]);

    const exported = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-export/export',
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('.huabu.zip');

    const body = multipartBody('Exported.huabu.zip', exported.rawPayload);
    const imported = await app.inject({
      method: 'POST',
      url: '/canvas/import',
      payload: body.payload,
      headers: body.headers,
    });

    expect(imported.statusCode).toBe(200);
    const newCanvasId = imported.json().canvasId;
    expect(newCanvasId).not.toBe('canvas-export');

    const record = await space(newCanvasId).read();
    expect(record?.canvasId).toBe(newCanvasId);
    const nodes = await space(newCanvasId).nodes.list();
    expect(nodes.get('node-a')?.record.content).toContain('exported body');
  });

  it('accepts a bundle that still carries the frozen canvas.json record name', async () => {
    const bundle = await makeBundle({
      'manifest.json': JSON.stringify({ version: '2', title: 'Legacy bundle' }),
      'canvas.json': JSON.stringify({
        canvasId: 'canvas-legacy-source',
        title: 'Legacy bundle',
        version: 3,
        createdAt: 1,
        updatedAt: 2,
        state: {
          nodes: [
            {
              id: 'node-legacy',
              type: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'Legacy' },
            },
          ],
          edges: [],
        },
      }),
      'nodes/Legacy.md':
        '---\nid: node-legacy\ntype: note\nlabel: Legacy\n---\nlegacy body\n',
    });

    const body = multipartBody('legacy.huabu.zip', bundle);
    const imported = await app.inject({
      method: 'POST',
      url: '/canvas/import',
      payload: body.payload,
      headers: body.headers,
    });

    expect(imported.statusCode).toBe(200);
    const canvasId = imported.json().canvasId;
    const record = await space(canvasId).read();
    expect(record?.title).toBe('Legacy bundle');
    const nodes = await space(canvasId).nodes.list();
    expect(nodes.get('node-legacy')?.record.content).toContain('legacy body');
  });

  it('de-duplicates the title when the imported name is already taken', async () => {
    await seedSpace('canvas-taken', 'Shared name', []);
    const bundle = await makeBundle({
      'manifest.json': JSON.stringify({ version: '2', title: 'Shared name' }),
      'space.json': JSON.stringify({
        canvasId: 'canvas-other-source',
        title: 'Shared name',
        version: 0,
        createdAt: 1,
        updatedAt: 1,
        state: { nodes: [], edges: [] },
      }),
    });

    const body = multipartBody('shared.huabu.zip', bundle);
    const imported = await app.inject({
      method: 'POST',
      url: '/canvas/import',
      payload: body.payload,
      headers: body.headers,
    });

    expect(imported.statusCode).toBe(200);
    const record = await space(imported.json().canvasId).read();
    expect(record?.title).not.toBe('Shared name');
    expect(record?.title).toContain('Shared name');
  });

  it('refuses a bundle with no Space record and leaves no staging directory', async () => {
    const bundle = await makeBundle({
      'manifest.json': JSON.stringify({ version: '2' }),
      'nodes/Orphan.md': '---\nid: node-orphan\n---\nno record\n',
    });

    const body = multipartBody('broken.huabu.zip', bundle);
    const imported = await app.inject({
      method: 'POST',
      url: '/canvas/import',
      payload: body.payload,
      headers: body.headers,
    });

    expect(imported.statusCode).toBe(400);
    const listed = await app.inject({ method: 'GET', url: '/canvas' });
    expect(listed.json().canvases).toHaveLength(0);
  });

  it('resolves the record filename however the module graph was entered', async () => {
    // `space-import.ts` reads the record filename from `layout.ts`, and the
    // two sit in one import cycle: layout → workspace → the storage barrel →
    // the composition root → space-import. Whichever module the process
    // happens to load first decides whether `layout.ts` has finished
    // initializing by the time this file evaluates, so a module-scope capture
    // of that constant is `undefined` for the life of the process under some
    // orders and correct under others — and every bundle import then answers
    // 500 with no clue why.
    //
    // A static import cannot express that: the order this file's own imports
    // produce is the safe one. Reset the registry and re-enter the cycle
    // through a Disk module, which is the order that breaks it.
    vi.resetModules();
    await import('../storage/backends/disk/canvas-dirs.js');
    const reloadedStorage = await import('../storage/index.js');
    const reloadedWorkspace = await import('../workspace.js');

    const staging = mkdtempSync(path.join(tmpdir(), 'huabu-portable-reads-4-'));
    try {
      reloadedWorkspace.setWorkspacePath(staging);
      const staged = reloadedStorage.stageSpaceImport('canvas-staged');
      expect(staged).not.toBeNull();
      if (!staged) return;
      mkdirSync(staged.stagingDirectory, { recursive: true });
      writeFileSync(
        path.join(staged.stagingDirectory, 'space.json'),
        JSON.stringify({
          canvasId: 'canvas-staged-source',
          title: 'Staged',
          version: 0,
          createdAt: 1,
          updatedAt: 1,
          state: { nodes: [], edges: [] },
        }),
        'utf8',
      );

      await expect(staged.readRecord()).resolves.toMatchObject({
        canvasId: 'canvas-staged-source',
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
      // The reloaded copy of `workspace.ts` holds its own module state; put
      // the one this file uses back where the shared setup left it.
      setWorkspacePath(workspacePath);
      resetStorageCache();
    }
  });

  it('answers 404 when exporting a Space that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-absent/export',
    });

    expect(response.statusCode).toBe(404);
  });
});

// ─── 8. Per-node content routes ─────────────────────────────────────────────

describe('per-node content routes', () => {
  it('serves one node record and round-trips an edit back through it', async () => {
    await seedSpace('canvas-content', 'Content', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'first body' },
    ]);

    const before = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-content/nodes/node-a/content',
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      nodeId: 'node-a',
      type: 'note',
      label: 'Alpha',
      content: 'first body',
    });

    const written = await app.inject({
      method: 'PUT',
      url: '/canvas/canvas-content/nodes/node-a/content',
      payload: { nodeType: 'note', content: 'second body' },
    });
    expect(written.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-content/nodes/node-a/content',
    });
    expect(after.json().content).toBe('second body');
    // Sidecar writes are outside the Space record's version counter.
    expect((await space('canvas-content').read())?.version).toBe(1);
  });

  it('returns a placeholder rather than 404 for a node with no sidecar', async () => {
    await seedSpace('canvas-content-bare', 'Bare content', [
      { id: 'node-bare', type: 'note', label: 'Bare', sidecar: false },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-content-bare/nodes/node-bare/content',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nodeId: 'node-bare',
      contentMissing: true,
      content: '',
    });
  });

  it('keeps a node whose frontmatter a user broke editable and deletable', async () => {
    // The reason the port's single-node read is strict about reachability but
    // lenient about content: refusing the read would make a hand-broken node
    // unreachable through exactly the two routes that could repair it.
    await seedSpace('canvas-content-broken', 'Broken content', [
      { id: 'node-broken', type: 'note', label: 'Broken', sidecar: false },
    ]);
    writeSidecarByHand(
      'canvas-content-broken',
      'node-broken.md',
      '---\nkeywords: [oops\n---\nsalvageable\n',
    );

    const read = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-content-broken/nodes/node-broken/content',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toContain('salvageable');

    const repaired = await app.inject({
      method: 'PUT',
      url: '/canvas/canvas-content-broken/nodes/node-broken/content',
      payload: { nodeType: 'note', content: 'repaired', label: 'Broken' },
    });
    expect(repaired.statusCode).toBe(200);
    expect(
      (await space('canvas-content-broken').nodes.read('node-broken'))?.record
        .content,
    ).toContain('repaired');

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/canvas/canvas-content-broken/nodes/node-broken',
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      await space('canvas-content-broken').nodes.read('node-broken'),
    ).toBeNull();
  });

  it('renders a node two sidecars claim, and refuses to overwrite either', async () => {
    // Only a filesystem can produce this, so only Disk answers it: the read
    // path keeps the node visible with a duplicate hint so a user can fix it,
    // while the write path hard-fails rather than picking a file.
    await seedSpace('canvas-dupe-node', 'Duplicate node', [
      { id: 'node-a', type: 'note', label: 'Alpha', content: 'original' },
    ]);
    writeSidecarByHand(
      'canvas-dupe-node',
      'Alpha copy.md',
      '---\nid: node-a\ntype: note\nlabel: Alpha\n---\nsecond claim\n',
    );

    const response = await app.inject({
      method: 'GET',
      url: '/canvas/canvas-dupe-node/nodes/node-a/content',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nodeId: 'node-a',
      contentDuplicate: true,
    });
    expect(response.json().duplicateFiles).toHaveLength(2);

    const put = await space('canvas-dupe-node').nodes.put({
      nodeId: 'node-a',
      record: {
        nodeId: 'node-a',
        type: 'note',
        label: 'Alpha',
        content: 'overwrite attempt',
      },
    });
    expect(put).toMatchObject({ ok: false, reason: 'duplicate-node' });
  });
});

// ─── 9. Executor batches ────────────────────────────────────────────────────

describe('POST /canvas/:canvasId/execute', () => {
  it('hydrates prestate through the ports and lands nodes plus sidecars', async () => {
    await seedSpace('canvas-exec', 'Exec', [
      { id: 'node-existing', type: 'note', label: 'Existing', content: 'kept' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/canvas/canvas-exec/execute',
      payload: {
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-new',
                nodeType: 'note',
                position: { x: 40, y: 40 },
                data: { label: 'New', content: 'created by the executor' },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canvasId: 'canvas-exec',
      fromVersion: 1,
      toVersion: 2,
    });

    const nodes = await space('canvas-exec').nodes.list();
    expect([...nodes.keys()].sort()).toEqual(['node-existing', 'node-new']);
    expect(nodes.get('node-new')?.record.content).toContain(
      'created by the executor',
    );
    // The prestate the batch read from is still there afterwards.
    expect(nodes.get('node-existing')?.record.content).toBe('kept');
  });

  it('answers 404 for a batch addressed to a Space that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/canvas/canvas-absent/execute',
      payload: { originator: { source: 'ui' }, commands: [] },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ─── 10. Workspace switching ────────────────────────────────────────────────

describe('a handle bound to one Workspace', () => {
  it('refuses to read a newly activated Workspace instead of resolving into it', async () => {
    await seedSpace('canvas-bound', 'Bound', [
      {
        id: 'node-a',
        type: 'note',
        label: 'Alpha',
        content: 'first workspace',
      },
    ]);
    const retained = space('canvas-bound');
    const retainedNodes = retained.nodes;
    const retainedTree = retained.diskTree;
    expect(retainedTree).not.toBeNull();

    const second = mkdtempSync(path.join(tmpdir(), 'huabu-portable-reads-2-'));
    try {
      setWorkspacePath(second);
      resetStorageCache();

      await expect(retainedNodes.list()).rejects.toThrow(/inactive workspace/i);
      await expect(retainedNodes.read('node-a')).rejects.toThrow(
        /inactive workspace/i,
      );
      expect(() => retainedTree?.directory()).toThrow(/inactive workspace/i);
    } finally {
      rmSync(second, { recursive: true, force: true });
      setWorkspacePath(workspacePath);
      resetStorageCache();
    }
  });

  it('serves the new Workspace through a freshly resolved handle', async () => {
    await seedSpace('canvas-bound-2', 'Bound two', []);

    const second = mkdtempSync(path.join(tmpdir(), 'huabu-portable-reads-3-'));
    try {
      setWorkspacePath(second);
      resetStorageCache();
      await getStructuredStore().spaces().ensureWorld();

      expect(await space('canvas-bound-2').read()).toBeNull();
      expect(await getStructuredStore().spaces().list()).toEqual([]);
    } finally {
      rmSync(second, { recursive: true, force: true });
      setWorkspacePath(workspacePath);
      resetStorageCache();
    }
  });
});
