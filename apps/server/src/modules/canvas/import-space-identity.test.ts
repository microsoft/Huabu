// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  FileThreadStore,
  FileTurnStore,
  mountAgenetes,
  InMemoryEventLogStore,
} from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

import { validateInteractiveViewState } from '@huabu/shared';

import { remapImportedSpace } from './import-space-identity.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import { toFrontmatter } from '../../utils/markdown-frontmatter.js';
import { buildReachbackEnv } from '../agent/acp/reachback-env.js';
import { createChatSubmission } from '../agent/agenetes/handle.js';
import { buildHistoryFromTurns } from '../agent/conversation/transcript/history.js';

import type { CanvasFile } from './persistence-types.js';
import type { PersistedTurn } from '@agenetes/agenetes';
import type { ChatHistoryItem } from '@huabu/shared';
import type { InteractiveViewDefinitionV1 } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'huabu-import-identity-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function record(): CanvasFile {
  return {
    canvasId: 'source',
    title: 'Imported',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    state: {
      nodes: [
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: { label: 'Frame' },
        },
        {
          id: 'note',
          type: 'note',
          parentId: 'frame',
          position: { x: 10, y: 20 },
          data: { label: 'note' },
        },
        {
          id: 'agent',
          type: 'question',
          position: { x: 100, y: 0 },
          data: { threadId: 'thread', selectedNodeIds: ['note'] },
        },
      ],
      edges: [{ id: 'edge', source: 'note', target: 'agent' }],
    },
  };
}

it('keeps application values and provenance opaque while remapping declared references', async () => {
  const definition: InteractiveViewDefinitionV1 = {
    protocolVersion: 1,
    ownerThreadId: 'thread',
    state: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string', enum: ['note'] } },
        additionalProperties: false,
      },
      value: { id: 'note' },
    },
    bindings: [
      {
        bindingId: 'note',
        source: { kind: 'canvas.nodes', nodeIds: ['note'] },
      },
    ],
    actions: [],
  };
  const original = record();
  (original.state.nodes[1] as CanvasNode).data = {
    interactiveView: definition,
    custom: { id: 'note', nodeId: 'note', threadId: 'thread', source: 'agent' },
    payload: { nodeId: 'note', source: 'agent' },
  };
  await mkdir(path.join(directory, 'nodes'));
  await writeFile(
    path.join(directory, 'nodes', 'Note.md'),
    `${toFrontmatter({ id: 'note', type: 'note', interactiveView: definition })}\nbody`,
  );
  await mkdir(path.join(directory, '.history'));
  await writeFile(
    path.join(directory, '.history', 'delta-log.jsonl'),
    JSON.stringify({
      originator: { source: 'agent', threadId: 'thread' },
      deltas: [
        {
          type: 'REPLACE_NODE',
          prev: original.state.nodes[1],
          next: original.state.nodes[1],
        },
      ],
    }),
  );
  const imported = await remapImportedSpace(directory, original, 'target');
  const [, note, agent] = imported.state.nodes as CanvasNode[];
  expect(note.data).toMatchObject({
    custom: (original.state.nodes[1] as CanvasNode).data.custom,
    payload: (original.state.nodes[1] as CanvasNode).data.payload,
    interactiveView: {
      state: definition.state,
      ownerThreadId: agent.data.threadId,
      bindings: [{ bindingId: 'note', source: { nodeIds: [note.id] } }],
    },
  });
  const view = note.data.interactiveView as InteractiveViewDefinitionV1;
  expect(
    validateInteractiveViewState(view.state.schema, view.state.value),
  ).toBeNull();
  const sidecar = parseFrontmatter(
    await readFile(path.join(directory, 'nodes', 'Note.md'), 'utf8'),
  );
  expect(sidecar.meta.interactiveView).toEqual(view);
  const delta = JSON.parse(
    await readFile(path.join(directory, '.history', 'delta-log.jsonl'), 'utf8'),
  );
  expect(delta).toMatchObject({
    originator: { source: 'agent', threadId: agent.data.threadId },
    deltas: [
      {
        prev: { id: note.id, data: note.data },
        next: { id: note.id, data: note.data },
      },
    ],
  });
});

it('imports an independent deployment and rekeys durable thread records and log filenames', async () => {
  const source = {
    name: 'source',
    storage: { root: path.join(directory, '.history') },
  };
  const threads = new FileThreadStore();
  threads.upsert(source, 'thread', {
    driverSchemaVersion: 1,
    spec: {
      kind: 'external',
      workloadType: 'Deployment',
      threadId: 'thread',
      namespace: source,
      spec: {
        binding: { profileId: 'profile', alias: 'Agent' },
        env: {
          HUABU_THREAD_ID: 'thread',
          HUABU_RFS_URL: 'http://old/api/rfs/source',
          CUSTOM: 'note',
        },
      },
    },
    state: {
      driverState: {
        sessionId: 'original-session',
        initialPreambleDelivered: true,
      },
      metadata: { sessionInfo: { title: 'Original', updatedAt: null } },
    },
    hostMetadata: { owner: { nodeId: 'agent', canvasId: 'source' } },
  });
  const history = path.join(directory, '.history', 'chat_v2');
  await mkdir(history);
  await mkdir(path.join(directory, '.history', 'chat'));
  await writeFile(
    path.join(history, 'thread.events.jsonl'),
    JSON.stringify({
      seq: 1,
      event: { type: 'meta', data: { threadId: 'thread' } },
    }),
  );
  await writeFile(
    path.join(history, 'thread.turns.jsonl.bak'),
    'historical backup',
  );
  await writeFile(
    path.join(directory, '.history', 'chat', 'thread.changes.json'),
    '[]',
  );
  const runtime = mountAgenetes({
    drivers: {
      external: defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Deployment'],
        specSchema: z.object({}).passthrough(),
        stateSchema: z.object({}).passthrough(),
        initialState: () => ({}),
        create: () => ({
          capabilities: {
            supportedControlMessages: [],
            turnInput: 'blocking' as const,
          },
          async *run() {
            yield { type: 'text_delta' as const, data: { content: 'reply' } };
          },
          async control() {
            return {
              ok: false as const,
              code: 'unsupported' as const,
              error: 'Not supported',
            };
          },
          close() {},
        }),
      }),
    },
    threadStore: threads,
    turnStore: new FileTurnStore(),
    eventLogStore: new InMemoryEventLogStore(),
  });
  const prior = threads.get(source, 'thread')!;
  const originalHandle = await runtime.create(prior.spec);
  const imported = await remapImportedSpace(directory, record(), 'target');
  const threadId = (imported.state.nodes[2] as CanvasNode).data.threadId;
  expect(threadId).toEqual(expect.any(String));
  expect(threadId).not.toBe('thread');
  const namespace = { ...source, name: 'target' };
  const copied = threads.get(namespace, String(threadId))!;
  expect(copied.spec).toMatchObject({
    threadId,
    namespace: { name: 'target' },
    spec: {
      env: { ...buildReachbackEnv(String(threadId), 'target'), CUSTOM: 'note' },
    },
  });
  expect(copied.state.driverState).toEqual({ initialPreambleDelivered: false });
  expect(copied.spec.spec).not.toMatchObject({
    env: { HUABU_RFS_URL: 'http://old/api/rfs/source' },
  });
  expect(threads.get(namespace, 'thread')).toBeUndefined();
  expect(await runtime.create(copied.spec)).not.toBe(originalHandle);
  expect(await readdir(history)).toContain(`${threadId}.events.jsonl`);
  expect(await readdir(history)).toContain(`${threadId}.turns.jsonl.bak`);
  expect(
    JSON.parse(
      await readFile(path.join(history, `${threadId}.events.jsonl`), 'utf8'),
    ).event.data.threadId,
  ).toBe(threadId);
  expect(await readdir(path.join(directory, '.history', 'chat'))).toEqual([
    `${threadId}.changes.json`,
  ]);
  await runtime.close('thread');
  await runtime.close(String(threadId));
});

it('migrates legacy ACP records before resetting copied native sessions', async () => {
  const root = path.join(directory, '.history');
  await mkdir(root);
  await writeFile(
    path.join(root, 'acp-sessions.json'),
    JSON.stringify({
      schemaVersion: 3,
      records: {
        thread: {
          sessionId: 'native-original',
          profileId: 'profile',
          cwd: '/tmp',
          updatedAt: 1,
          bindingRecipe: {
            command: 'agent',
            cwd: '/tmp',
            autoRestart: false,
            alias: 'Agent',
          },
        },
      },
    }),
  );
  const imported = await remapImportedSpace(directory, record(), 'target');
  const threadId = String(
    (imported.state.nodes[2] as CanvasNode).data.threadId,
  );
  const stored = new FileThreadStore().get(
    { name: 'target', storage: { root } },
    threadId,
  );
  expect(stored?.state.driverState).toEqual({
    initialPreambleDelivered: false,
  });
  expect(stored?.spec.threadId).toBe(threadId);
  expect(await readdir(root)).not.toContain('acp-sessions.json');
});

it('keeps foreign thread references and opaque tool output unchanged', async () => {
  const original = record();
  (original.state.nodes[1] as CanvasNode).data.parentThreadId =
    'foreign-thread';
  const root = path.join(directory, '.history');
  await mkdir(root);
  const output = {
    id: 'note',
    nodeId: 'note',
    source: 'agent',
    threadId: 'thread',
  };
  const event = {
    type: 'tool_call',
    data: { title: 'application', rawInput: output, rawOutput: output },
  };
  await writeFile(path.join(root, 'events.jsonl'), JSON.stringify(event));
  const opaque = JSON.stringify({
    id: 'note',
    nodeId: 'note',
    threadId: 'thread',
  });
  await writeFile(path.join(root, 'application.json'), opaque);
  const imported = await remapImportedSpace(directory, original, 'target');
  expect((imported.state.nodes[1] as CanvasNode).data.parentThreadId).toBe(
    'foreign-thread',
  );
  expect(
    JSON.parse(await readFile(path.join(root, 'events.jsonl'), 'utf8')),
  ).toEqual(event);
  expect(await readFile(path.join(root, 'application.json'), 'utf8')).toBe(
    opaque,
  );
});

it.each(['jsonl', 'sqlite'])(
  'remaps internal tool arguments and Task run references in %s without changing task IDs',
  async (format) => {
    const root = path.join(directory, '.history');
    const namespace = { name: 'source', storage: { root } };
    new FileThreadStore().upsert(namespace, 'thread', {
      driverSchemaVersion: 1,
      spec: {
        kind: 'internal',
        workloadType: 'Deployment',
        threadId: 'thread',
        namespace,
        spec: { hostContext: { canvasId: 'source' }, model: { id: 'note' } },
      },
      state: { driverState: {} },
    });
    const persisted: PersistedTurn = {
      seqStart: 1,
      seqEnd: 2,
      turn: {
        request: null,
        transcript: [
          {
            type: 'tool_call',
            data: {
              toolCallId: 'note',
              title: 'inspect_nodes',
              status: 'completed',
              rawInput: { nodeIds: ['note'] },
            },
          },
        ],
      },
    };
    const turns = new FileTurnStore();
    if (format === 'sqlite') {
      turns.append(namespace, 'thread', persisted);
      turns.close(namespace);
    } else {
      await mkdir(path.join(root, 'chat_v2'));
      await writeFile(
        path.join(root, 'chat_v2', 'thread.turns.jsonl'),
        JSON.stringify(persisted),
      );
    }
    await writeFile(
      path.join(root, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [{ taskId: 'note', canvasId: 'source', anchorNodeId: 'note' }],
        runs: [
          {
            runId: 'note',
            taskId: 'note',
            canvasIdSnapshot: 'source',
            rootNodeId: 'agent',
            rootThreadId: 'thread',
          },
        ],
      }),
    );
    const imported = await remapImportedSpace(directory, record(), 'target');
    const [, note, agent] = imported.state.nodes as CanvasNode[];
    const threadId = String(agent.data.threadId);
    try {
      expect(
        turns.list(namespace, threadId)[0].turn.transcript[0],
      ).toMatchObject({
        data: { toolCallId: 'note', rawInput: { nodeIds: [note.id] } },
      });
      const workload = new FileThreadStore().get(namespace, threadId);
      expect(workload?.spec.spec).toEqual({
        hostContext: { canvasId: 'target' },
        model: { id: 'note' },
      });
      expect(
        JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')),
      ).toEqual({
        version: 1,
        tasks: [{ taskId: 'note', canvasId: 'target', anchorNodeId: note.id }],
        runs: [
          {
            runId: 'note',
            taskId: 'note',
            canvasIdSnapshot: 'target',
            rootNodeId: agent.id,
            rootThreadId: threadId,
          },
        ],
      });
    } finally {
      turns.close(namespace);
    }
  },
);

it('remaps topology, node frontmatter, structured history and scoped links together', async () => {
  await mkdir(path.join(directory, 'nodes'));
  await mkdir(path.join(directory, '.history'));
  await writeFile(
    path.join(directory, 'nodes', 'Note.md'),
    '---\nid: note\ntype: note\nlabel: note\n---\nnote\n[Agent](/canvas/source?node=agent)\n![Image](/api/canvas/source/artifact/picture.png)\n',
  );
  await writeFile(
    path.join(directory, '.history', 'events.jsonl'),
    `${JSON.stringify({ nodeId: 'note', selectedNodeIds: ['note'], content: 'note', canvasId: 'source' })}\n`,
  );
  await writeFile(
    path.join(directory, '.history', 'threads.json'),
    JSON.stringify({
      records: {
        thread: {
          spec: { threadId: 'thread', namespace: { name: 'source' } },
          hostMetadata: { owner: { canvasId: 'source', nodeId: 'agent' } },
        },
      },
    }),
  );
  const original = record();
  const imported = await remapImportedSpace(directory, original, 'target');
  const [frame, note, agent] = imported.state.nodes as CanvasNode[];
  expect(new Set([frame.id, note.id, agent.id]).size).toBe(3);
  expect(frame.id).not.toBe('frame');
  expect(note).toMatchObject({
    type: 'note',
    parentId: frame.id,
    data: { label: 'note' },
    position: { x: 10, y: 20 },
  });
  expect(agent.data).toMatchObject({
    threadId: expect.stringMatching(/^thread-/),
    selectedNodeIds: [note.id],
  });
  expect(imported.state.edges[0]).toMatchObject({
    source: note.id,
    target: agent.id,
  });
  expect(imported.state.edges[0]).not.toMatchObject({ id: 'edge' });
  const sidecar = parseFrontmatter(
    await readFile(path.join(directory, 'nodes', 'Note.md'), 'utf8'),
  );
  expect(sidecar.meta).toMatchObject({ id: note.id, label: 'note' });
  expect(sidecar.content).toBe(
    `note\n[Agent](/canvas/target?node=${agent.id})\n![Image](/api/canvas/target/artifact/picture.png)\n`,
  );
  expect(
    JSON.parse(
      await readFile(path.join(directory, '.history', 'events.jsonl'), 'utf8'),
    ),
  ).toEqual({
    nodeId: note.id,
    selectedNodeIds: [note.id],
    content: 'note',
    canvasId: 'target',
  });
  expect(
    JSON.parse(
      await readFile(path.join(directory, '.history', 'threads.json'), 'utf8'),
    ),
  ).toEqual({
    records: {
      [String(agent.data.threadId)]: {
        spec: { threadId: agent.data.threadId, namespace: { name: 'target' } },
        hostMetadata: { owner: { canvasId: 'target', nodeId: agent.id } },
      },
    },
  });
  expect(original).toEqual(record());
});

it('rekeys SQLite conversations without changing turn order or sequence fences', async () => {
  const namespace = {
    name: 'source',
    storage: { root: path.join(directory, '.history') },
  };
  const turns = new FileTurnStore();
  turns.append(namespace, 'thread', {
    seqStart: 3,
    seqEnd: 8,
    turn: {
      request: { type: 'user_text', content: 'Original prompt' },
      transcript: [
        {
          type: 'tool_call',
          data: {
            toolCallId: 'call',
            title: 'Read nodes',
            status: 'completed',
            rawOutput: {
              tool: 'inspect_nodes',
              status: 'success',
              data: { nodeId: 'note', selectedNodeIds: ['note'] },
            },
          },
        },
      ],
    },
  });
  turns.close(namespace);
  const database = new DatabaseSync(
    path.join(namespace.storage.root, 'chat_v2', 'turns.sqlite'),
  );
  database
    .prepare('UPDATE turn_generations SET generation = 7 WHERE thread_id = ?')
    .run('thread');
  database
    .prepare('INSERT OR IGNORE INTO jsonl_imports (thread_id) VALUES (?)')
    .run('thread');
  database.close();
  try {
    const imported = await remapImportedSpace(directory, record(), 'target');
    const note = imported.state.nodes[1] as CanvasNode;
    const history = turns.list(
      namespace,
      String((imported.state.nodes[2] as CanvasNode).data.threadId),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      seqStart: 3,
      seqEnd: 8,
      turn: {
        request: { type: 'user_text', content: 'Original prompt' },
        transcript: [
          {
            type: 'tool_call',
            data: {
              rawOutput: {
                tool: 'inspect_nodes',
                status: 'success',
                data: { nodeId: note.id, selectedNodeIds: [note.id] },
              },
            },
          },
        ],
      },
    });
    const importedThread = String(
      (imported.state.nodes[2] as CanvasNode).data.threadId,
    );
    expect(turns.list(namespace, 'thread')).toEqual([]);
    const reopened = new DatabaseSync(
      path.join(namespace.storage.root, 'chat_v2', 'turns.sqlite'),
    );
    try {
      expect(
        reopened
          .prepare(
            'SELECT generation FROM turn_generations WHERE thread_id = ?',
          )
          .get(importedThread)?.generation,
      ).toBe(7);
      expect(
        reopened
          .prepare('SELECT thread_id FROM jsonl_imports WHERE thread_id = ?')
          .get(importedThread)?.thread_id,
      ).toBe(importedThread);
    } finally {
      reopened.close();
    }
  } finally {
    turns.close(namespace);
  }
});

it('rejects ambiguous duplicate identities instead of publishing broken references', async () => {
  const source = record();
  source.state.nodes.push(source.state.nodes[0]);
  await expect(remapImportedSpace(directory, source, 'target')).rejects.toThrow(
    'duplicate identity',
  );
});

it.each([
  'legacy body',
  '---\ntype: note\nlabel: Legacy\n---\nlegacy body',
  '---\nid: ""\ntype: note\n---\nlegacy body',
  '---\nid: 123\ntype: note\n---\nlegacy body',
])('preserves filename-identified legacy node content: %s', async (raw) => {
  await mkdir(path.join(directory, 'nodes'));
  const filename = path.join(directory, 'nodes', 'note.md');
  await writeFile(filename, raw);
  const imported = await remapImportedSpace(directory, record(), 'target');
  const note = imported.state.nodes[1] as CanvasNode;
  const sidecar = parseFrontmatter(await readFile(filename, 'utf8'));
  expect(sidecar.meta.id).toBe(note.id);
  expect(sidecar.content).toBe('legacy body');
});

it.each(['jsonl', 'sqlite'])(
  'remaps JSON string tool results in %s without rewriting opaque output',
  async (format) => {
    const namespace = {
      name: 'target',
      storage: { root: path.join(directory, '.history') },
    };
    const snapshots = [
      { src: 'image.png', width: 10, height: 10, originNodeIds: ['note'] },
    ];
    const outputs = [
      JSON.stringify(snapshots),
      JSON.stringify({
        tool: 'snapshot_nodes',
        status: 'success',
        data: { snapshots },
      }),
      'not JSON: note',
      '{"nodeId":"note"}',
    ];
    const persisted: PersistedTurn = {
      seqStart: 1,
      seqEnd: 5,
      turn: {
        request: null,
        transcript: outputs.map((rawOutput, index) => ({
          type: 'tool_call',
          data: {
            toolCallId: `call-${index}`,
            title: index < 2 ? 'snapshot_nodes' : 'external',
            status: 'completed',
            rawOutput,
          },
        })),
      },
    };
    const turns = new FileTurnStore();
    if (format === 'sqlite') {
      turns.append(namespace, 'thread', persisted);
      turns.close(namespace);
    } else {
      const history = path.join(namespace.storage.root, 'chat_v2');
      await mkdir(history, { recursive: true });
      await writeFile(
        path.join(history, 'thread.turns.jsonl'),
        `${JSON.stringify(persisted)}\n`,
      );
    }
    try {
      const imported = await remapImportedSpace(directory, record(), 'target');
      const note = imported.state.nodes[1] as CanvasNode;
      const history = turns.list(
        namespace,
        String((imported.state.nodes[2] as CanvasNode).data.threadId),
      );
      const expectedSnapshots = [{ ...snapshots[0], originNodeIds: [note.id] }];
      expect(history[0].turn.transcript).toMatchObject([
        { data: { rawOutput: JSON.stringify(expectedSnapshots) } },
        {
          data: {
            rawOutput: JSON.stringify({
              tool: 'snapshot_nodes',
              status: 'success',
              data: { snapshots: expectedSnapshots },
            }),
          },
        },
        { data: { rawOutput: outputs[2] } },
        { data: { rawOutput: outputs[3] } },
      ]);
      const messages: ChatHistoryItem[] = [];
      buildHistoryFromTurns(
        history.map((entry) => entry.turn),
        messages,
        { recoverInternalToolNames: true },
      );
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        parts: [
          {
            variant: 'snapshot_nodes',
            data: { data: { snapshots: expectedSnapshots } },
          },
          {
            variant: 'snapshot_nodes',
            data: { data: { snapshots: expectedSnapshots } },
          },
          {},
          {},
        ],
      });
    } finally {
      turns.close(namespace);
    }
  },
);

it.each(['jsonl', 'sqlite'])(
  'remaps selected ChatEnvelope nodes in %s history and its client projection',
  async (format) => {
    const namespace = {
      name: 'target',
      storage: { root: path.join(directory, '.history') },
    };
    const persisted: PersistedTurn = {
      seqStart: 1,
      seqEnd: 3,
      turn: {
        request: createChatSubmission({
          user: { text: 'note', attachments: [] },
          skills: { invokedIds: [], resolved: [] },
          focus: {
            anchor: { nodeId: 'agent' },
            selection: {
              refs: [{ id: 'note', type: 'note', filename: 'nodes/Note.md' }],
              selectedIds: ['note', 'frame'],
              imageAttachments: [],
              snapshotAttachments: [],
            },
          },
        }),
        transcript: [],
      },
    };
    const turns = new FileTurnStore();
    if (format === 'sqlite') {
      turns.append(namespace, 'thread', persisted);
      turns.close(namespace);
    } else {
      const historyDirectory = path.join(namespace.storage.root, 'chat_v2');
      await mkdir(historyDirectory, { recursive: true });
      await writeFile(
        path.join(historyDirectory, 'thread.turns.jsonl'),
        `${JSON.stringify(persisted)}\n`,
      );
    }
    try {
      const imported = await remapImportedSpace(directory, record(), 'target');
      const [frame, note, agent] = imported.state.nodes as CanvasNode[];
      const history = turns.list(namespace, String(agent.data.threadId));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        seqStart: 1,
        seqEnd: 3,
        turn: {
          request: {
            content: {
              user: { text: 'note' },
              focus: {
                anchor: { nodeId: agent.id },
                selection: {
                  refs: [{ id: note.id, filename: 'nodes/Note.md' }],
                  selectedIds: [note.id, frame.id],
                },
              },
            },
          },
        },
      });
      const messages: ChatHistoryItem[] = [];
      buildHistoryFromTurns(
        history.map((entry) => entry.turn),
        messages,
      );
      expect(messages[0]).toMatchObject({
        role: 'user',
        selectedNodeIds: [note.id, frame.id],
      });
    } finally {
      turns.close(namespace);
    }
  },
);

it('remaps both recent-conversation pointers without changing acceptance identity or other extensions', async () => {
  const source = record();
  source.state.nodes.push({
    id: 'pending-agent',
    type: 'question',
    position: { x: 200, y: 0 },
    data: { threadId: 'pending-thread' },
  });
  const extensionDirectory = path.join(
    directory,
    '.ext',
    'huabu.recentconversation',
  );
  await mkdir(extensionDirectory, { recursive: true });
  const pointerFile = path.join(extensionDirectory, 'target.json');
  const acceptanceId = 'f7f67652-dacc-4965-a42d-71a7ac02699e';
  await writeFile(
    pointerFile,
    JSON.stringify({
      conversation: { nodeId: 'agent', threadId: 'thread' },
      pending: {
        conversation: { nodeId: 'pending-agent', threadId: 'pending-thread' },
        acceptanceId,
      },
    }),
  );
  const otherDirectory = path.join(directory, '.ext', 'other-extension');
  await mkdir(otherDirectory);
  const otherFile = path.join(otherDirectory, 'target.json');
  const opaque = '{"nodeId":"agent"}';
  await writeFile(otherFile, opaque);

  const imported = await remapImportedSpace(directory, source, 'target');
  const [, , agent, pendingAgent] = imported.state.nodes as CanvasNode[];
  expect(JSON.parse(await readFile(pointerFile, 'utf8'))).toEqual({
    conversation: { nodeId: agent.id, threadId: agent.data.threadId },
    pending: {
      conversation: {
        nodeId: pendingAgent.id,
        threadId: pendingAgent.data.threadId,
      },
      acceptanceId,
    },
  });
  expect(await readFile(otherFile, 'utf8')).toBe(opaque);
});
