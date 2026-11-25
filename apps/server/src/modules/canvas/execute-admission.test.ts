// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Admission of `POST /canvas/:canvasId/execute`: the source follows the
 * credential, commands are well formed, and a page does not write bodies
 * through execute. Driven through the route with Fastify `inject()`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editsPerCommand } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import canvasRoutes from './canvas.route.js';
import { admitExecuteRequest } from './execute-admission.js';
import {
  markAgentCredential,
  setRequestIdentity,
} from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-execute-admission-'));
  setWorkspacePath(tmp);
  resetStorageCache();
  const store = getCanvasStore('c1');
  store.write({
    canvasId: 'c1',
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: 'node-a',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'A' },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode('node-a', {
    nodeId: 'node-a',
    type: 'note',
    label: 'A',
    content: 'the body',
  });
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** The route behind an identity layer; `x-credential: agent` is a machine. */
async function buildApp() {
  const app = fastify();
  app.addHook('onRequest', async (request) => {
    const agent = request.headers['x-credential'] === 'agent';
    if (agent) markAgentCredential(request);
    setRequestIdentity(request, {
      principal: agent
        ? { principalId: 'huabu-agentlet', kind: 'bot' }
        : { principalId: 'alice', kind: 'user' },
      member: true,
      owner: false,
      access: UNRESTRICTED_ACCESS,
    });
  });
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof buildApp>>;

/**
 * The command results of a page `execute` response, flat. These requests
 * send one edit per command, so entry i answers command i.
 */
function resultsOf(body: {
  edits: Array<{
    results: Array<{ applied: boolean; reason?: string }>;
  }>;
}): Array<{ applied: boolean; reason?: string }> {
  return body.edits.flatMap((edit) => edit.results);
}

function execute(
  app: App,
  payload: Record<string, unknown>,
  credential: 'session' | 'agent' = 'session',
) {
  return app.inject({
    method: 'POST',
    url: '/canvas/c1/execute',
    headers: { 'x-credential': credential },
    payload,
  });
}

const body = () => getCanvasStore('c1').readNode('node-a')?.content;
const version = () => getCanvasStore('c1').read()?.version;
const lock = {
  type: 'SET_NODE_LOCKED',
  items: [{ nodeId: 'node-a', locked: true }],
};

describe('the source of an execute request', () => {
  it('is the credential: a session is ui, an agent credential is an agent', async () => {
    const app = await buildApp();
    try {
      // A page-only command is out of scope for an agent credential.
      const asAgent = await execute(
        app,
        { edits: editsPerCommand([lock]) },
        'agent',
      );
      expect(asAgent.statusCode).toBe(200);
      expect(resultsOf(asAgent.json())).toEqual([
        expect.objectContaining({ applied: false, reason: 'invalid-scope' }),
      ]);
      expect(version()).toBe(1);

      // A person's session is ui.
      const session = await execute(app, { edits: editsPerCommand([lock]) });
      expect(session.statusCode).toBe(200);
      expect(resultsOf(session.json())[0].applied).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('refuses a request that states a source, whatever it states', async () => {
    const app = await buildApp();
    try {
      for (const credential of ['session', 'agent'] as const) {
        for (const source of ['ui', 'agent', 'system']) {
          const response = await execute(
            app,
            { originator: { source }, edits: editsPerCommand([lock]) },
            credential,
          );
          expect(response.statusCode, `${credential} ${source}`).toBe(400);
        }
      }
      expect(version()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    'SET_NODE_LOCKED',
    'SET_NODE_SELECTION',
    'CHANGE_NODE_TYPE',
    'APPLY_MEASURED_HEIGHT',
    'APPLY_MEASURED_SIZE',
    'RESTORE_NODES',
  ])('reports %s from an agent as out of scope', async (type) => {
    const commands: Record<string, Record<string, unknown>> = {
      SET_NODE_LOCKED: lock,
      SET_NODE_SELECTION: { type, nodeIds: ['node-a'] },
      CHANGE_NODE_TYPE: { type, nodeId: 'node-a', to: 'text' },
      APPLY_MEASURED_HEIGHT: {
        type,
        items: [{ nodeId: 'node-a', intrinsicHeight: 10, measuredFor: 'k' }],
      },
      APPLY_MEASURED_SIZE: {
        type,
        items: [{ nodeId: 'node-a', width: 1, height: 1, measuredFor: 'k' }],
      },
      RESTORE_NODES: {
        type,
        nodes: [
          {
            id: 'node-b',
            type: 'note',
            position: { x: 0, y: 0 },
            data: { content: 'x' },
          },
        ],
      },
    };
    const app = await buildApp();
    try {
      const response = await execute(
        app,
        { edits: editsPerCommand([commands[type]]) },
        'agent',
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(resultsOf(response.json())).toEqual([
        expect.objectContaining({ applied: false, reason: 'invalid-scope' }),
      ]);
      expect(version()).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('a page does not overwrite a body through execute', () => {
  it.each([
    ['sets content', { patch: { content: 'overwritten' } }],
    ['sets src', { patch: { src: 'artifacts/other.png' } }],
    ['unsets content', { patch: {}, unset: ['content'] }],
    [
      'sets content beside a structure key',
      { patch: { pinned: 1, content: '' } },
    ],
  ])('refuses a ui MERGE_NODE_DATA that %s', async (_name, entry) => {
    const app = await buildApp();
    try {
      const response = await execute(app, {
        edits: editsPerCommand([
          {
            type: 'MERGE_NODE_DATA',
            patches: [{ nodeId: 'node-a', ...entry }],
          },
        ]),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'UI_BODY_WRITE' });
      expect(body()).toBe('the body');
      expect(version()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('takes a ui MERGE_NODE_DATA of structure keys, and an agent body write with the revision', async () => {
    const app = await buildApp();
    try {
      const structure = await execute(app, {
        edits: editsPerCommand([
          {
            type: 'MERGE_NODE_DATA',
            patches: [{ nodeId: 'node-a', patch: { pinned: true } }],
          },
        ]),
      });
      expect(structure.statusCode).toBe(200);
      expect(resultsOf(structure.json())[0].applied).toBe(true);
      expect(body()).toBe('the body');

      const stale = await execute(
        app,
        {
          edits: editsPerCommand([
            {
              type: 'MERGE_NODE_DATA',
              patches: [{ nodeId: 'node-a', patch: { content: 'by agent' } }],
            },
          ]),
        },
        'agent',
      );
      expect(resultsOf(stale.json())[0]).toMatchObject({
        applied: false,
        reason: 'conflict',
      });
      const read = await execute(
        app,
        {
          edits: editsPerCommand([
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'node-a',
                  patch: { content: 'by agent' },
                  expectRev: nodeRevisionOf({ content: 'the body' }),
                },
              ],
            },
          ]),
        },
        'agent',
      );
      expect(resultsOf(read.json())[0].applied).toBe(true);
      expect(body()).toBe('by agent');
    } finally {
      await app.close();
    }
  });

  it('refuses a RESTORE_NODES that replaces a node without keeping its body, and takes one that keeps it', async () => {
    const app = await buildApp();
    const snapshot = {
      id: 'node-a',
      type: 'note',
      position: { x: 40, y: 40 },
      data: { label: 'A', content: 'an old body from undo history' },
    };
    try {
      for (const keepDataKeys of [
        undefined,
        [],
        ['label'],
        ['content'],
        ['content', 'src'],
      ]) {
        const response = await execute(app, {
          edits: editsPerCommand([
            {
              type: 'RESTORE_NODES',
              nodes: [snapshot],
              replace: ['node-a'],
              ...(keepDataKeys ? { keepDataKeys } : {}),
            },
          ]),
        });
        expect(response.statusCode, String(keepDataKeys)).toBe(400);
        expect(response.json()).toMatchObject({ code: 'UI_BODY_WRITE' });
      }
      expect(body()).toBe('the body');
      expect(version()).toBe(1);

      // What the browser sends: the content fields are kept.
      const kept = await execute(app, {
        edits: editsPerCommand([
          {
            type: 'RESTORE_NODES',
            nodes: [snapshot],
            replace: ['node-a'],
            keepDataKeys: ['content', 'src', 'dataSchema', 'label'],
          },
        ]),
      });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(resultsOf(kept.json())[0].applied).toBe(true);
      expect(body()).toBe('the body');
      expect(getCanvasStore('c1').read()?.state.nodes[0]).toMatchObject({
        position: { x: 40, y: 40 },
      });
    } finally {
      await app.close();
    }
  });

  it('still creates a node, and restores one that is gone, with its body', async () => {
    const app = await buildApp();
    try {
      const response = await execute(app, {
        edits: editsPerCommand([
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-new',
                nodeType: 'note',
                position: { x: 0, y: 300 },
                data: { label: 'New', content: 'created with a body' },
              },
            ],
          },
          {
            type: 'RESTORE_NODES',
            nodes: [
              {
                id: 'node-back',
                type: 'note',
                position: { x: 0, y: 600 },
                data: { label: 'Back', content: 'restored with its body' },
              },
            ],
          },
        ]),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(resultsOf(response.json())).toEqual([
        expect.objectContaining({ applied: true }),
        expect.objectContaining({ applied: true }),
      ]);
      const store = getCanvasStore('c1');
      expect(store.readNode('node-new')?.content).toBe('created with a body');
      expect(store.readNode('node-back')?.content).toBe(
        'restored with its body',
      );
    } finally {
      await app.close();
    }
  });
});

describe('malformed commands', () => {
  it.each([
    ['not an object', 'DELETE_NODES'],
    ['null', null],
    ['an unknown type', { type: 'DROP_EVERYTHING' }],
    ['no type', { nodeIds: ['node-a'] }],
    ['a list that is not a list', { type: 'DELETE_NODES', nodeIds: 'node-a' }],
    ['a missing list', { type: 'MERGE_NODE_DATA' }],
    ['a null item', { type: 'MERGE_NODE_DATA', patches: [null] }],
    [
      'a patch that is not an object',
      { type: 'MERGE_NODE_DATA', patches: [{ nodeId: 'node-a', patch: 'x' }] },
    ],
    [
      'an id that is not a string',
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 7, position: { x: 0, y: 0 } }],
      },
    ],
    [
      'a point without numbers',
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'node-a', position: { x: '1' } }],
      },
    ],
    ['a created node without a type', { type: 'CREATE_NODES', nodes: [{}] }],
    ['a restored node that is null', { type: 'RESTORE_NODES', nodes: [null] }],
    ['an edge list of numbers', { type: 'DISCONNECT_EDGES', edges: [1] }],
    [
      'a reorder target of the wrong kind',
      { type: 'REORDER_NODES', nodeIds: ['node-a'], to: 3 },
    ],
  ])('answers 400, not 500, for %s', async (_name, command) => {
    const app = await buildApp();
    try {
      for (const credential of ['session', 'agent'] as const) {
        const response = await execute(
          app,
          { edits: editsPerCommand([lock, command]) },
          credential,
        );
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({
          code: 'INVALID_COMMAND',
          message: expect.stringContaining('edits[1].commands[0]'),
        });
      }
      // Nothing of the batch ran.
      expect(version()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('refuses a page id of another shape in originator.tabId', async () => {
    const app = await buildApp();
    try {
      for (const tabId of ['a b', '', 'p'.repeat(65), 'a/b']) {
        const response = await execute(app, {
          originator: { tabId },
          edits: editsPerCommand([lock]),
        });
        expect(response.statusCode, tabId).toBe(400);
      }
      const accepted = await execute(app, {
        originator: { tabId: 'page_A-1' },
        edits: editsPerCommand([lock]),
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('admitExecuteRequest', () => {
  it('takes the source from the credential alone', () => {
    expect(
      admitExecuteRequest({ viaAgentCredential: false, edits: [] }),
    ).toEqual({ ok: true, source: 'ui', edits: [] });
    expect(
      admitExecuteRequest({ viaAgentCredential: true, edits: [] }),
    ).toEqual({ ok: true, source: 'agent', edits: [] });
  });
});
