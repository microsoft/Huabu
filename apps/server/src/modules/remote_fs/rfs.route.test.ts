/**
 * Tests for the RFS route plugin (`/api/rfs/:canvasId/*`).
 *
 * Exercised via Fastify `inject()` so the catch-all body parser, wildcard
 * path routing, upload/download roundtrip, collision handling, and the
 * `/skill`-hint error envelope are covered end-to-end.
 *
 * Auth is applied by the global preHandler in `app.ts`, not by the route
 * plugin, so injecting the plugin directly needs no Bearer token.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CANVAS_COMMAND_TYPES,
  rfsCapabilitiesResponseSchema,
  rfsExecuteResponseSchema,
  rfsOperationCapabilityResponseSchema,
  spaceQueryResponseSchema,
} from '@sediment/shared';
import { getNodeDefaultSize } from '@sediment/shared/canvas-engine';

const agentMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  record: vi.fn(),
  get: vi.fn(),
  handleRun: vi.fn(),
}));

vi.mock('../agent/agent.service.js', () => ({
  runAgent: agentMocks.runAgent,
}));

vi.mock('../agent/agenetes/drivers.js', () => ({
  INTERNAL_DRIVER_KIND: 'internal',
  agenetes: {
    record: agentMocks.record,
    get: agentMocks.get,
  },
}));

import rfsRoutes from './rfs.route.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import { getCanvasStore, resetStorageCache } from '../storage/index.js';
import { toSafeFilename } from '../workspace/disk/naming.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(rfsRoutes, { prefix: '/rfs' });
  await app.ready();
  return app;
}

/**
 * Seed a note node (topology entry + `nodes/<safeLabel>.md` body) and
 * return its download path. Re-calling with the same id/label overwrites the
 * body (topology strips content, so the body only lives in the sidecar).
 */
function seedNote(
  canvasId: string,
  id: string,
  label: string,
  content: string,
): string {
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [{ id, type: 'note', position: { x: 0, y: 0 }, data: { label } }],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(id, { nodeId: id, type: 'note', label, content });
  return `nodes/${toSafeFilename(label, id)}.md`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-rfs-'));
  setWorkspacePath(tmp);
  agentMocks.runAgent.mockReset();
  agentMocks.record.mockReset();
  agentMocks.get.mockReset();
  agentMocks.handleRun.mockReset();
  agentMocks.runAgent.mockImplementation(async function* () {
    yield { type: 'done', data: { message: 'first answer' } };
    return [];
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/rfs/:canvasId/skill', () => {
  it('returns the bundled access guide as markdown', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/rfs/c1/skill' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.body).toMatch(/Accessing this Huabu Space/i);
      expect(res.body).toMatch(/POST execute/);
      expect(res.body).toMatch(/work without an internal model provider/i);
      for (const command of AGENT_CANVAS_COMMAND_TYPES) {
        expect(res.body).toMatch(
          new RegExp(String.raw`\|\s+\`${command}\`\s+\|`),
        );
      }
      expect(res.body).toContain('/capabilities/commands/$COMMAND');
      expect(res.body).toContain('**parent-local**');
      expect(res.body).toContain('read-only `absolutePosition`');
      expect(res.body).toContain(
        `${getNodeDefaultSize('web').width} × ${getNodeDefaultSize('web').height}px`,
      );
      expect(res.body).toContain(
        `${getNodeDefaultSize('note').height}px nominal layout height`,
      );
    } finally {
      await app.close();
    }
  });
});

describe('direct Space query discovery', () => {
  it('publishes bounded operation capabilities and generated schemas', async () => {
    const app = await buildApp();
    try {
      const capabilities = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities',
      });
      expect(capabilities.statusCode).toBe(200);
      const parsedCapabilities = rfsCapabilitiesResponseSchema.parse(
        capabilities.json(),
      );
      expect(parsedCapabilities).toMatchObject({
        permissions: { read: true, write: true },
        execution: { atomic: false, idempotent: false },
        limits: { queryMax: 200, executeMaxCommands: 50 },
      });

      const detail = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities/queries/INSPECT_NODES',
      });
      expect(detail.statusCode).toBe(200);
      const parsedDetail = rfsOperationCapabilityResponseSchema.parse(
        detail.json(),
      );
      expect(parsedDetail).toMatchObject({
        kind: 'query',
        type: 'INSPECT_NODES',
      });
      expect(parsedDetail.schema).toHaveProperty('properties.type');

      const commandDetail = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities/commands/CREATE_NODES',
      });
      const parsedCommand = rfsOperationCapabilityResponseSchema.parse(
        commandDetail.json(),
      );
      expect(parsedCommand.examples).toHaveLength(1);

      const snapshotDetail = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities/queries/SNAPSHOT_NODES',
      });
      const parsedSnapshot = rfsOperationCapabilityResponseSchema.parse(
        snapshotDetail.json(),
      );
      expect(parsedSnapshot).toMatchObject({
        kind: 'query',
        type: 'SNAPSHOT_NODES',
      });
      expect(parsedSnapshot.schema).toHaveProperty('properties.nodeIds');
    } finally {
      await app.close();
    }
  });

  it('returns a structured unsupported-operation error', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities/queries/UNKNOWN',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>()).toMatchObject({
        code: 'unsupported_query',
      });

      const inheritedName = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities/queries/toString',
      });
      expect(inheritedName.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/rfs/:canvasId/query', () => {
  it('dispatches spatial queries through the canonical JSON response', async () => {
    seedNote('c1', 'node-1', 'Alpha', 'hello body');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'INSPECT_NODES', ids: ['node-1'] },
      });
      expect(response.statusCode).toBe(200);
      const parsed = spaceQueryResponseSchema.parse(response.json());
      expect(parsed).toMatchObject({
        type: 'INSPECT_NODES',
        result: {
          count: 1,
          nodes: [{ id: 'node-1', label: 'Alpha' }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('collects streaming search into a bounded JSON result', async () => {
    seedNote('c1', 'node-1', 'Alpha', 'hello searchable body');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'SEARCH', query: 'searchable', limit: 10 },
      });
      expect(response.statusCode).toBe(200);
      expect(spaceQueryResponseSchema.parse(response.json())).toMatchObject({
        type: 'SEARCH',
        result: {
          count: 1,
          truncated: false,
          matches: [{ tier: 'content', match: { nodeId: 'node-1' } }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid JSON and out-of-range query limits', async () => {
    const app = await buildApp();
    try {
      const invalidJson = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(invalidJson.statusCode).toBe(400);
      expect(invalidJson.json<{ code: string }>().code).toBe('invalid_json');

      const invalidLimit = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'INSPECT_NODES', limit: 201 },
      });
      expect(invalidLimit.statusCode).toBe(400);
      expect(invalidLimit.json<{ code: string }>().code).toBe(
        'validation_failed',
      );
    } finally {
      await app.close();
    }
  });
});

describe('SNAPSHOT_NODES Space query', () => {
  it('renders a sketch into a downloadable PNG artifact', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'frame-root',
            type: 'frame',
            position: { x: 0, y: 0 },
            style: { width: 300, height: 200 },
            data: { type: 'frame' },
          },
          {
            id: 'frame-nested',
            type: 'frame',
            parentId: 'frame-root',
            position: { x: 20, y: 20 },
            style: { width: 200, height: 120 },
            data: { type: 'frame' },
          },
          {
            id: 'sketch-1',
            type: 'sketch',
            parentId: 'frame-nested',
            position: { x: 20, y: 30 },
            style: { width: 120, height: 80 },
            data: {
              type: 'sketch',
              initialSize: { width: 120, height: 80 },
              strokes: [
                {
                  id: 'stroke-1',
                  points: [
                    [10, 10, 0.5],
                    [60, 60, 0.5],
                    [110, 10, 0.5],
                  ],
                  color: 'blue',
                  size: 4,
                },
              ],
            },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'SNAPSHOT_NODES',
          nodeIds: ['frame-root'],
          maxPixels: 512,
        },
      });
      expect(response.statusCode).toBe(200);
      const parsed = spaceQueryResponseSchema.parse(response.json());
      expect(parsed).toMatchObject({ type: 'SNAPSHOT_NODES' });
      if (parsed.type !== 'SNAPSHOT_NODES') {
        throw new Error('Expected SNAPSHOT_NODES response');
      }
      expect(parsed.result.snapshots).toEqual([
        {
          src: expect.stringMatching(/^sketch-raster-.+\.png$/),
          downloadPath: expect.stringMatching(
            /^artifacts\/sketch-raster-.+\.png$/,
          ),
          width: expect.any(Number),
          height: expect.any(Number),
          originNodeIds: ['sketch-1'],
        },
      ]);

      const download = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${parsed.result.snapshots[0].downloadPath}`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.subarray(0, 8)).toEqual(
        Buffer.from('89504e470d0a1a0a', 'hex'),
      );
    } finally {
      await app.close();
    }
  });

  it('validates requests before rendering', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'SNAPSHOT_NODES',
          nodeIds: [],
          maxPixels: 128,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/rfs/:canvasId/execute', () => {
  const writeWorldFixture = (
    directory: string,
    canvasId: string,
    nodes: unknown[],
  ): void => {
    const root = join(tmp, directory);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'space.json'),
      JSON.stringify({
        canvasId,
        title: directory,
        version: 0,
        state: { nodes, edges: [] },
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  };

  const pinPayload = (sourceCanvasId: string, sourceNodeId: string) => ({
    commands: [
      {
        type: 'SET_PORTAL_NODE_PINS',
        updates: [
          {
            sourceCanvasId,
            sourceNodeIds: [sourceNodeId],
            pinned: true,
          },
        ],
      },
    ],
  });

  // A live Space whose Portal does not exist yet used to be answered with
  // 409 "refresh the World". Since `ensureCanonicalPortals`, the router
  // reconciles the missing Portal first and the pin succeeds, so the route
  // has no reason to fail. Router-level coverage of the reconciliation
  // itself lives in canvas-command-router.test.ts.
  it('reconciles a missing Portal instead of failing the request', async () => {
    writeWorldFixture('.world', 'canvas-world', []);
    writeWorldFixture('Project', 'canvas-source', [
      {
        id: 'node-source',
        type: 'note',
        position: { x: 0, y: 0 },
        data: {},
      },
    ]);
    resetStorageCache();

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/canvas-source/execute',
        headers: { 'content-type': 'application/json' },
        payload: pinPayload('canvas-source', 'node-source'),
      });

      expect(response.statusCode).toBe(200);

      const worldNodes = getCanvasStore('canvas-world').read()?.state.nodes as
        | { type?: string; data?: { targetCanvasId?: string } }[]
        | undefined;
      expect(
        worldNodes?.some(
          (node) =>
            node.type === 'canvasRef' &&
            node.data?.targetCanvasId === 'canvas-source',
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  // Reconciliation only mints Portals for live Spaces, so a pin naming a
  // Space that is not one cannot be satisfied. That is the case the route's
  // 409 branch exists for.
  it('answers 409 when the pinned source Space owns no Portal', async () => {
    writeWorldFixture('.world', 'canvas-world', []);
    writeWorldFixture('Project', 'canvas-source', [
      {
        id: 'node-source',
        type: 'note',
        position: { x: 0, y: 0 },
        data: {},
      },
    ]);
    resetStorageCache();

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/canvas-source/execute',
        headers: { 'content-type': 'application/json' },
        payload: pinPayload('canvas-ghost', 'node-ghost'),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'WORLD_PORTAL_MISSING',
      });
      expect(response.json().message).toMatch(/not a live Space/i);
    } finally {
      await app.close();
    }
  });

  it('attributes change-review records to the host thread only when the header is present', async () => {
    seedNote('c1', 'node-1', 'Alpha', 'existing body');
    const app = await buildApp();
    try {
      const payload = {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'note',
                data: { label: 'Attributed', content: '# Attributed' },
                position: { x: 120, y: 80 },
              },
            ],
          },
        ],
      };

      // With the host-thread header → records persisted to that thread's sidecar.
      const attributed = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: {
          'content-type': 'application/json',
          'x-huabu-host-thread-id': 'thread-abc',
        },
        payload,
      });
      expect(attributed.statusCode).toBe(200);
      expect(getCanvasStore('c1').readChanges('thread-abc')).toHaveLength(1);

      // Without the header → no attribution, no records written.
      const unattributed = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(unattributed.statusCode).toBe(200);
      expect(getCanvasStore('c1').readChanges('thread-xyz')).toHaveLength(0);

      // A malformed filesystem ID is ignored: the write still applies, but
      // no change-review sidecar is attributed to it.
      const malformed = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: {
          'content-type': 'application/json',
          'x-huabu-host-thread-id': 'thread/invalid',
        },
        payload,
      });
      expect(malformed.statusCode).toBe(200);
      expect(
        malformed.json<{ affected: { nodeIds: string[] } }>().affected.nodeIds,
      ).toHaveLength(1);
      expect(getCanvasStore('c1').readChanges('thread-invalid')).toHaveLength(
        0,
      );
    } finally {
      await app.close();
    }
  });

  it('executes adjacent requests independently when they reuse a runId', async () => {
    const anchorFile = seedNote('c1', 'node-1', 'Alpha', 'existing body');
    agentMocks.runAgent.mockImplementation(() => {
      throw new Error('Internal model provider is not configured');
    });
    const app = await buildApp();
    try {
      const anchorQuery = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'INSPECT_NODES', ids: ['node-1'] },
      });
      expect(anchorQuery.statusCode).toBe(200);
      expect(anchorQuery.json()).toMatchObject({
        result: { nodes: [{ id: 'node-1', filename: anchorFile }] },
      });

      const anchorDownload = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${anchorFile}`,
      });
      expect(anchorDownload.statusCode).toBe(200);
      expect(anchorDownload.body).toContain('existing body');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload: {
          runId: 'external-run-1',
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'note',
                  data: { label: 'Created', content: '# Created' },
                  position: { x: 200, y: 100 },
                },
              ],
            },
          ],
        },
      });
      expect(createResponse.statusCode).toBe(200);
      const created = rfsExecuteResponseSchema.parse(createResponse.json());
      const createdNodeId = created.results[0]?.nodes?.[0]?.nodeId;
      expect(created).toMatchObject({
        runId: 'external-run-1',
        fromVersion: 1,
        toVersion: 2,
        results: [{ index: 0, type: 'CREATE_NODES', applied: true }],
      });
      expect(createdNodeId).toMatch(/^node-/);
      expect(created.revisions).toContainEqual({
        nodeId: createdNodeId,
        rev: expect.any(String),
      });
      expect(JSON.stringify(created.commands)).not.toMatch(
        /origin|labelSource/,
      );

      const connectResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload: {
          runId: 'external-run-1',
          commands: [
            {
              type: 'CONNECT_NODES',
              edges: [{ source: 'node-1', target: createdNodeId }],
            },
          ],
        },
      });
      const connected = rfsExecuteResponseSchema.parse(connectResponse.json());
      expect(connected).toMatchObject({
        runId: 'external-run-1',
        fromVersion: 2,
        toVersion: 3,
      });
      expect(connected.results[0]?.edges?.[0]).toMatchObject({
        edgeId: expect.stringMatching(/^edge-/),
        source: 'node-1',
        target: createdNodeId,
      });

      const verification = await app.inject({
        method: 'POST',
        url: '/rfs/c1/query',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'INSPECT_EDGES',
          between: { a: 'node-1', b: createdNodeId },
        },
      });
      expect(verification.statusCode).toBe(200);
      expect(verification.json()).toMatchObject({
        result: {
          count: 1,
          edges: [{ source: 'node-1', target: createdNodeId }],
        },
      });
      expect(agentMocks.runAgent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns stale content conflicts as HTTP 200 without echoing content', async () => {
    seedNote('c1', 'node-1', 'Alpha', 'current secret body');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload: {
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'node-1',
                  expectRev: 'stale-revision',
                  patch: { content: 'replacement' },
                },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      const result = rfsExecuteResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        fromVersion: 1,
        toVersion: 1,
        results: [{ applied: false, reason: 'conflict' }],
        conflicts: [{ nodeId: 'node-1', reason: 'stale' }],
      });
      expect(response.body).not.toContain('current secret body');
      expect(getCanvasStore('c1').readNode('node-1')?.content).toBe(
        'current secret body',
      );
    } finally {
      await app.close();
    }
  });

  it('applies content updates guarded by the downloaded revision', async () => {
    const file = seedNote('c1', 'node-1', 'Alpha', 'before');
    const app = await buildApp();
    try {
      const download = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      const revision = String(download.headers['etag']).replace(/"/g, '');

      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload: {
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'node-1',
                  expectRev: revision,
                  patch: { content: 'after' },
                },
              ],
            },
          ],
        },
      });
      const result = rfsExecuteResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        fromVersion: 1,
        toVersion: 2,
        results: [{ applied: true }],
        revisions: [{ nodeId: 'node-1', rev: expect.any(String) }],
      });
      expect(result.revisions[0]?.rev).not.toBe(revision);
      expect(getCanvasStore('c1').readNode('node-1')?.content).toBe('after');
    } finally {
      await app.close();
    }
  });

  it('rejects caller-owned origin and UI-only commands', async () => {
    seedNote('c1', 'node-1', 'Alpha', 'body');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/rfs/c1/execute',
        headers: { 'content-type': 'application/json' },
        payload: {
          originator: { source: 'ui' },
          commands: [{ type: 'SET_NODE_SELECTION', nodeIds: ['node-1'] }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    } finally {
      await app.close();
    }
  });
});

describe('POST/GET/DELETE /api/rfs/:canvasId/upload', () => {
  it('roundtrips an upload then a download', async () => {
    const app = await buildApp();
    try {
      const up = await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/note.md',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello world',
      });
      expect(up.statusCode).toBe(201);
      expect(up.json<{ path: string; size: number }>()).toEqual({
        path: 'upload/note.md',
        size: 11,
      });

      const down = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/upload/note.md',
      });
      expect(down.statusCode).toBe(200);
      expect(down.body).toBe('hello world');
    } finally {
      await app.close();
    }
  });

  it('rejects a colliding upload with 409 and a /skill hint', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/dup.md',
        payload: 'a',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/dup.md',
        payload: 'b',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ message: string }>().message).toMatch(/\/skill/);
    } finally {
      await app.close();
    }
  });

  it('deletes a staged upload', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/gone.md',
        payload: 'x',
      });
      const del = await app.inject({
        method: 'DELETE',
        url: '/rfs/c1/upload/gone.md',
      });
      expect(del.statusCode).toBe(204);
      const after = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/upload/gone.md',
      });
      expect(after.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/rfs/:canvasId/download', () => {
  it('404s a missing file with a runnable /skill recovery command', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/nodes/missing.md',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(/curl .*\/skill/);
    } finally {
      await app.close();
    }
  });

  it('refuses reads of private bookkeeping dirs', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/.memory/state.json',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('node download revision (ETag / conditional GET)', () => {
  it('serves an ETag and 304s a matching If-None-Match', async () => {
    const app = await buildApp();
    try {
      const file = seedNote('c1', 'node-1', 'Alpha', 'hello body');

      const res = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      expect(res.statusCode).toBe(200);
      const etag = res.headers['etag'] as string;
      expect(etag).toMatch(/^".+"$/);

      // Same content → 304, empty body.
      const notModified = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
        headers: { 'if-none-match': etag },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('changes the ETag when the authored body changes', async () => {
    const app = await buildApp();
    try {
      const file = seedNote('c1', 'node-1', 'Alpha', 'first body');
      const first = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      const etag1 = first.headers['etag'] as string;

      seedNote('c1', 'node-1', 'Alpha', 'second body');
      const second = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
        headers: { 'if-none-match': etag1 },
      });
      // Body changed → the stale If-None-Match no longer matches → 200.
      expect(second.statusCode).toBe(200);
      expect(second.headers['etag']).not.toBe(etag1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/rfs/:canvasId/agent', () => {
  it('creates a Deployment and returns its thread id before the final text', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.body).toMatch(
        /^: ok\n\n: threadId reachback-[^\n]+\n\ndata: first answer\n\n$/,
      );
      expect(agentMocks.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'operate',
          workloadType: 'Deployment',
          threadId: expect.stringMatching(/^reachback-/),
          canvasId: 'c1',
          envelope: expect.objectContaining({
            user: expect.objectContaining({ text: 'hello' }),
          }),
          context: expect.objectContaining({ messages: [] }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('continues an existing live internal Deployment directly through its handle', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.handleRun.mockImplementation(async function* () {
      yield { type: 'done', data: { message: 'continued answer' } };
      return [];
    });
    agentMocks.get.mockReturnValue({ run: agentMocks.handleRun });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-existing',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(': threadId reachback-existing');
      expect(res.body).toContain('data: continued answer');
      expect(agentMocks.runAgent).not.toHaveBeenCalled();
      expect(agentMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'c1' }),
        'reachback-existing',
      );
      expect(agentMocks.handleRun).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'huabu.chat',
          content: expect.objectContaining({
            user: expect.objectContaining({ text: 'continue' }),
          }),
          rendered: [{ type: 'text', text: 'continue' }],
        }),
        expect.objectContaining({ maxIterations: 20 }),
      );

      const next = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-existing',
        },
        payload: 'continue again',
      });
      expect(next.statusCode).toBe(200);
      expect(agentMocks.handleRun).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('returns thread_not_live before opening SSE', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.get.mockReturnValue(undefined);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-cold',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('thread_not_live');
    } finally {
      await app.close();
    }
  });

  it('rejects a non-internal Deployment', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'external', workloadType: 'Deployment' },
      state: {},
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'external-thread',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('unsupported_thread_kind');
      expect(agentMocks.get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns thread_busy before opening SSE', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.get.mockReturnValue({ run: agentMocks.handleRun });
    const release = acquireAgentTurn('reachback-busy');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-busy',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('thread_busy');
    } finally {
      release?.();
      await app.close();
    }
  });

  it('keeps terminal errors visible in final mode', async () => {
    agentMocks.runAgent.mockImplementation(async function* () {
      yield { type: 'error', data: { error: 'model failed' } };
      return [];
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('"error":"model failed"');
    } finally {
      await app.close();
    }
  });

  it('lets event-mode headers override legacy JSON options', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'application/json',
          'x-huabu-event-mode': 'all',
        },
        payload: JSON.stringify({ prompt: 'hello', doneTextOnly: true }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: meta');
      expect(res.body).toContain('event: done');
      expect(res.body).toContain('event: end');
    } finally {
      await app.close();
    }
  });
});
