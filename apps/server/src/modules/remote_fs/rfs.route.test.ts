// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
} from '@huabu/shared';
import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

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
import { toSafeFilename } from '../../utils/naming.js';
import { agentNodeService } from '../agent/agent-node.service.js';
import { agentThreadResolver } from '../agent/agent-thread-resolver.js';
import {
  AgentThreadBusyError,
  agentThreadService,
} from '../agent/agent-thread.service.js';
import * as selectableProfiles from '../agent/selectable-agent-profile.js';
import { getCanvasStore, resetStorageCache, space } from '../storage/index.js';
import {
  RunCompletionError,
  runCompletionService,
} from '../task/run-completion.service.js';
import { RunLaunchError, runLauncher } from '../task/run-launcher.js';
import { taskService } from '../task/task.service.js';
import { setWorkspacePath } from '../workspace.js';

import type { FixedAgentNodeTarget } from '../agent/agent-thread-resolver.js';
import type { CanvasNodeId } from '@huabu/shared';

/**
 * The Space's Disk directory, or a test failure.
 *
 * These cases are Disk-specific by construction; the assertion states that
 * rather than letting an optional-chained `undefined` quietly pass.
 */
function diskDirOf(canvasId: string): string {
  const tree = space(canvasId).diskTree;
  if (!tree) throw new Error('Expected the Disk backend in this test');
  return tree.directory();
}

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
  tmp = mkdtempSync(join(tmpdir(), 'huabu-rfs-'));
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
  vi.restoreAllMocks();
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
      expect(res.body).toContain('$HUABU_RFS_URL/skill/tasks');
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

  it('returns only the bundled root guide without authorization', async () => {
    seedNote('c1', 'node-1', 'Anchor', 'content');
    writeFileSync(
      join(diskDirOf('c1'), 'skill.md'),
      '# Private Space Override',
      'utf8',
    );
    const app = await buildApp();
    try {
      const anonymous = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill',
      });
      const authenticated = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill',
        headers: { authorization: 'Bearer test-token' },
      });

      expect(anonymous.body).toMatch(/Accessing this Huabu Space/);
      expect(anonymous.body).not.toContain('Private Space Override');
      expect(authenticated.body).toContain('Private Space Override');
    } finally {
      await app.close();
    }
  });

  it('serves only known advanced skills', async () => {
    const app = await buildApp();
    try {
      const layout = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/layout',
      });
      const tasks = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/tasks',
      });
      const agents = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/agents',
      });
      const interactiveViews = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/interactive-views',
      });
      const unknown = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/not-a-skill',
      });
      const traversal = await app.inject({
        method: 'GET',
        url: '/rfs/c1/skill/%2e%2e%2faccess-huabu',
      });

      expect(layout.statusCode).toBe(200);
      expect(layout.body).toContain('# Layout Recipes');
      expect(tasks.body).toContain('# Durable Tasks and Runs');
      expect(agents.body).toContain('# Creating and Prompting Agents');
      expect(interactiveViews.body).toContain('# Building Interactive Views');
      expect(interactiveViews.body).toContain('huabu.view.connect');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'skill_not_found' });
      expect(traversal.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/rfs/:canvasId/agent/profiles', () => {
  it('returns the available Profile catalogue', async () => {
    vi.spyOn(selectableProfiles, 'listAvailableAgentProfiles').mockReturnValue([
      { id: 'profile-a', alias: 'Researcher' },
      { id: 'profile-b', alias: 'Builder' },
    ]);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/rfs/c1/agent/profiles',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        profiles: [
          { id: 'profile-a', alias: 'Researcher' },
          { id: 'profile-b', alias: 'Builder' },
        ],
      });
    } finally {
      await app.close();
    }
  });
});

describe('Task RFS adapters', () => {
  it('creates a Task through TaskService', async () => {
    const task = {
      taskId: 'task-a',
      canvasId: 'c1',
      goal: 'Investigate',
      defaultRootProfileId: 'profile-a',
      anchorNodeId: 'node-task',
      createdAt: 1,
    };
    const create = vi.spyOn(taskService, 'create').mockResolvedValue(task);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          goal: 'Investigate',
          defaultRootProfileId: 'profile-a',
          position: { x: 100, y: 200 },
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ task });
      expect(create).toHaveBeenCalledWith('c1', {
        goal: 'Investigate',
        defaultRootProfileId: 'profile-a',
        position: { x: 100, y: 200 },
      });
    } finally {
      await app.close();
    }
  });

  it('starts a Task Run through RunLauncher', async () => {
    const run = {
      runId: 'run-a',
      taskId: 'task-a',
      canvasIdSnapshot: 'c1',
      goalSnapshot: 'Investigate',
      rootProfileIdSnapshot: 'profile-b',
      status: 'running' as const,
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
      createdAt: 1,
      startedAt: 2,
    };
    const start = vi.spyOn(runLauncher, 'start').mockResolvedValue(run);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/task-a/run/create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          rootProfileId: 'profile-b',
          workingDirPath: '/work/task',
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ run });
      expect(start).toHaveBeenCalledWith(
        'c1',
        'task-a',
        {
          rootProfileId: 'profile-b',
          workingDirPath: '/work/task',
        },
        { logger: expect.anything() },
      );
    } finally {
      await app.close();
    }
  });

  it('completes a Task Run through RunCompletionService', async () => {
    const run = {
      runId: 'run-a',
      taskId: 'task-a',
      canvasIdSnapshot: 'c1',
      goalSnapshot: 'Investigate',
      rootProfileIdSnapshot: 'profile-b',
      status: 'completed' as const,
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
      createdAt: 1,
      startedAt: 2,
      completion: { completedAt: 3, message: 'PR merged' },
    };
    const complete = vi
      .spyOn(runCompletionService, 'complete')
      .mockResolvedValue(run);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/task-a/run/run-a/complete',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ message: 'PR merged' }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ run });
      expect(complete).toHaveBeenCalledWith('c1', 'task-a', 'run-a', {
        message: 'PR merged',
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['task_not_found', 404],
    ['run_not_found', 404],
    ['run_not_running', 409],
    ['completion_conflict', 409],
  ] as const)('maps %s completion errors to HTTP %s', async (code, status) => {
    vi.spyOn(runCompletionService, 'complete').mockRejectedValue(
      new RunCompletionError(code, `Completion failed: ${code}`),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/task-a/run/run-a/complete',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code });
      expect(res.json().message).toContain(`Completion failed: ${code}`);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid Task and Run bodies before calling services', async () => {
    const create = vi.spyOn(taskService, 'create');
    const start = vi.spyOn(runLauncher, 'start');
    const app = await buildApp();
    try {
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          goal: '',
          defaultRootProfileId: 'profile-a',
          position: { x: 0, y: 0 },
        }),
      });
      const runResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/task-a/run/create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ rootProfileId: '' }),
      });

      expect(taskResponse.statusCode).toBe(400);
      expect(runResponse.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reports retained Run and root Agent identities on launch failure', async () => {
    vi.spyOn(runLauncher, 'start').mockRejectedValue(
      new RunLaunchError(
        'invocation_failed',
        'Root invocation failed',
        'run-partial',
        'node-root' as CanvasNodeId,
        'thread-root',
      ),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/task/task-a/run/create',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'invocation_failed' });
      expect(res.json().message).toContain('Run: run-partial.');
      expect(res.json().message).toContain('Root node: node-root.');
      expect(res.json().message).toContain('Root thread: thread-root.');
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

  it('does not recreate legacy Portals for a retired Pin command', async () => {
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

      expect(response.statusCode).toBe(409);

      const worldNodes = getCanvasStore('canvas-world').read()?.state.nodes as
        | { type?: string; data?: { targetCanvasId?: string } }[]
        | undefined;
      expect(
        worldNodes?.some(
          (node) =>
            node.type === 'spacePreview' &&
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

  it('unwraps a downloaded node sidecar when it is written back as content', async () => {
    const file = seedNote('c1', 'node-1', 'Alpha', '# Existing body');
    const app = await buildApp();
    try {
      const download = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      expect(download.body).toMatch(/^---\n/);
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
                  patch: { content: download.body },
                },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(rfsExecuteResponseSchema.parse(response.json())).toMatchObject({
        fromVersion: 1,
        toVersion: 2,
        results: [{ applied: true }],
      });
      expect(getCanvasStore('c1').readNode('node-1')?.content).toBe(
        '# Existing body',
      );
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
  it('creates an idle Agent and connects its parent when available', async () => {
    vi.spyOn(agentThreadResolver, 'resolveAgentNodeId').mockResolvedValue(
      'node-parent' as CanvasNodeId,
    );
    const create = vi.spyOn(agentNodeService, 'create').mockResolvedValue({
      canvasId: 'c1',
      nodeId: 'node-child' as CanvasNodeId,
      threadId: 'thread-child',
      profileId: 'profile-child',
      parentConnection: 'connected',
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'application/json',
          'x-huabu-agent-start': 'false',
          'x-huabu-host-thread-id': 'thread-parent',
        },
        payload: JSON.stringify({
          profileId: 'profile-child',
          position: { x: 1200, y: 480 },
          workingDirPath: '/work/child',
          additionalInitialPreamble: 'Review the implementation.',
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        nodeId: 'node-child',
        threadId: 'thread-child',
        profileId: 'profile-child',
        parentConnection: 'connected',
        warnings: [],
      });
      expect(create).toHaveBeenCalledWith({
        canvasId: 'c1',
        profileId: 'profile-child',
        position: { x: 1200, y: 480 },
        anchor: {
          kind: 'delegated',
          parentAgentNodeId: 'node-parent',
        },
        launchOverrides: {
          workingDirPath: '/work/child',
          additionalInitialPreamble: 'Review the implementation.',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('submits a prompt to an existing Agent through AgentThreadService', async () => {
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-fixed' as CanvasNodeId,
      threadId: 'thread-fixed',
      agentBinding: {
        kind: 'external',
        profileId: 'profile-fixed',
        alias: 'Fixed Agent',
      },
      status: 'idle',
      content: '',
    };
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'node-fixed',
            type: 'question',
            position: { x: 0, y: 0 },
            data: {
              threadId: 'thread-fixed',
              agentBindingPolicy: 'fixed',
              agentBinding: target.agentBinding,
            },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('node-fixed', {
      nodeId: 'node-fixed',
      type: 'question',
      label: null,
      content: '',
    });

    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    const dispose = vi.fn().mockResolvedValue(undefined);
    const invoke = vi
      .spyOn(agentThreadService, 'invoke')
      .mockImplementation(async (options) => ({
        binding: target.agentBinding,
        fixedTarget: target,
        signal: options.signal ?? new AbortController().signal,
        dispose,
        events: (async function* () {
          yield {
            type: 'done' as const,
            data: { message: 'delegated answer' },
          };
        })(),
      }));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-fixed/prompt',
        headers: {
          'content-type': 'text/plain',
        },
        payload: 'continue delegated work',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data: delegated answer');
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-fixed',
          canvasId: 'c1',
          content: 'continue delegated work',
          mode: 'operate',
          fixedTarget: target,
        }),
      );
      expect(agentMocks.get).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses text/plain to create and immediately start a Huabu Agent', async () => {
    seedNote('c1', 'node-anchor', 'Anchor', 'content');
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-huabu' as CanvasNodeId,
      threadId: 'thread-huabu',
      agentBinding: { kind: 'internal' },
      status: 'idle',
      content: '',
    };
    vi.spyOn(agentNodeService, 'create').mockResolvedValue({
      canvasId: 'c1',
      nodeId: target.nodeId,
      threadId: target.threadId,
      profileId: 'huabu',
      parentConnection: 'not_requested',
    });
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    vi.spyOn(agentThreadService, 'invoke').mockImplementation(
      async (options) => ({
        binding: target.agentBinding,
        fixedTarget: target,
        signal: options.signal ?? new AbortController().signal,
        dispose: vi.fn().mockResolvedValue(undefined),
        events: (async function* () {
          yield { type: 'done' as const, data: { message: 'first answer' } };
        })(),
      }),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.body).toContain(': threadId thread-huabu');
      expect(res.body).toContain('event: created');
      expect(res.body).toContain('"profileId":"huabu"');
      expect(res.body).toContain('data: first answer');
      expect(agentNodeService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          canvasId: 'c1',
          profileId: 'huabu',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('reports created identity when the first turn cannot start', async () => {
    seedNote('c1', 'node-anchor', 'Anchor', 'content');
    vi.spyOn(agentNodeService, 'create').mockResolvedValue({
      canvasId: 'c1',
      nodeId: 'node-created' as CanvasNodeId,
      threadId: 'thread-created',
      profileId: 'huabu',
      parentConnection: 'not_requested',
    });
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(null);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json<{ message: string; code: string }>()).toMatchObject({
        code: 'agent_resolution_failed',
        message: expect.stringContaining(
          'Agent node-created was created with thread thread-created',
        ),
      });
    } finally {
      await app.close();
    }
  });

  it('continues an existing Huabu Agent through the prompt endpoint', async () => {
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-huabu' as CanvasNodeId,
      threadId: 'thread-huabu',
      agentBinding: { kind: 'internal' },
      status: 'done',
      content: 'Earlier request',
    };
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    const invoke = vi
      .spyOn(agentThreadService, 'invoke')
      .mockImplementation(async (options) => ({
        binding: target.agentBinding,
        fixedTarget: target,
        signal: options.signal ?? new AbortController().signal,
        dispose: vi.fn().mockResolvedValue(undefined),
        events: (async function* () {
          yield {
            type: 'done' as const,
            data: { message: 'continued answer' },
          };
        })(),
      }));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-huabu/prompt',
        headers: { 'content-type': 'text/plain' },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(': threadId thread-huabu');
      expect(res.body).toContain('data: continued answer');
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-huabu',
          content: 'continue',
        }),
      );

      const next = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-huabu/prompt',
        headers: { 'content-type': 'text/plain' },
        payload: 'continue again',
      });
      expect(next.statusCode).toBe(200);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('returns thread_not_found before opening SSE', async () => {
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(null);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/missing-thread/prompt',
        headers: { 'content-type': 'text/plain' },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('thread_not_found');
    } finally {
      await app.close();
    }
  });

  it('creates the Agent when its requested parent cannot be found', async () => {
    seedNote('c1', 'node-anchor', 'Anchor', 'content');
    vi.spyOn(agentThreadResolver, 'resolveAgentNodeId').mockResolvedValue(null);
    vi.spyOn(agentNodeService, 'create').mockResolvedValue({
      canvasId: 'c1',
      nodeId: 'node-independent' as CanvasNodeId,
      threadId: 'thread-independent',
      profileId: 'profile-a',
      parentConnection: 'not_requested',
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'application/json',
          'x-huabu-agent-start': 'false',
        },
        payload: JSON.stringify({
          profileId: 'profile-a',
          parentThreadId: 'missing-parent',
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        nodeId: 'node-independent',
        parentConnection: 'not_found',
        warnings: [{ code: 'parent_not_found' }],
      });
      expect(agentNodeService.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ anchor: expect.anything() }),
      );
    } finally {
      await app.close();
    }
  });

  it('returns thread_busy before opening SSE', async () => {
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-busy' as CanvasNodeId,
      threadId: 'thread-busy',
      agentBinding: { kind: 'internal' },
      status: 'running',
      content: 'Working',
    };
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    vi.spyOn(agentThreadService, 'invoke').mockRejectedValue(
      new AgentThreadBusyError('thread-busy'),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-busy/prompt',
        headers: { 'content-type': 'text/plain' },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('thread_busy');
    } finally {
      await app.close();
    }
  });

  it('keeps terminal errors visible in final mode', async () => {
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-error' as CanvasNodeId,
      threadId: 'thread-error',
      agentBinding: { kind: 'internal' },
      status: 'idle',
      content: '',
    };
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    vi.spyOn(agentThreadService, 'invoke').mockImplementation(
      async (options) => ({
        binding: target.agentBinding,
        fixedTarget: target,
        signal: options.signal ?? new AbortController().signal,
        dispose: vi.fn().mockResolvedValue(undefined),
        events: (async function* () {
          yield { type: 'error' as const, data: { error: 'model failed' } };
        })(),
      }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-error/prompt',
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

  it('lets event-mode headers override JSON prompt options', async () => {
    const target: FixedAgentNodeTarget = {
      canvasId: 'c1',
      nodeId: 'node-all' as CanvasNodeId,
      threadId: 'thread-all',
      agentBinding: { kind: 'internal' },
      status: 'idle',
      content: '',
    };
    vi.spyOn(agentThreadService, 'resolveFixedTarget').mockResolvedValue(
      target,
    );
    vi.spyOn(agentThreadService, 'invoke').mockImplementation(
      async (options) => ({
        binding: target.agentBinding,
        fixedTarget: target,
        signal: options.signal ?? new AbortController().signal,
        dispose: vi.fn().mockResolvedValue(undefined),
        events: (async function* () {
          yield { type: 'done' as const, data: { message: 'complete' } };
        })(),
      }),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-all/prompt',
        headers: {
          'content-type': 'application/json',
          'x-huabu-event-mode': 'all',
        },
        payload: JSON.stringify({ prompt: 'hello', eventMode: 'final' }),
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
