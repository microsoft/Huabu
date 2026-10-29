// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileThreadStore, FileTurnStore } from '@agenetes/agenetes';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  agentCanvasCommandSchema,
  agentRequestSchema,
  chatEnvelopeSchema,
  recentActionSchema,
} from '@huabu/shared';
import {
  extractCanvasChanges,
  fingerprintNodeFields,
} from '@huabu/shared/canvas-engine';

import { remapImportedSpace } from './import-space-identity.js';
import {
  createChatSubmission,
  createInteractiveViewSubmission,
} from '../agent/agenetes/handle.js';
import {
  rebuildTurnMessages,
  renderInternalAgentInputs,
} from '../agent/conversation/prompt/build-prompt.js';
import { renderInkRecognition } from '../agent/conversation/prompt/ink-ocr.js';
import { renderNodes } from '../agent/conversation/prompt/node-element.js';
import { buildHistoryFromTurns } from '../agent/conversation/transcript/history.js';

import type { CanvasFile } from './persistence-types.js';
import type { PersistedTurn } from '@agenetes/agenetes';
import type { AgentInput, AgentTurn } from '@agenetes/protocol';
import type {
  CanvasCommand,
  ChatEnvelope,
  ChatHistoryItem,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'huabu-identity-contracts-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(): CanvasFile {
  return {
    canvasId: 'source',
    title: 'Source',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    state: {
      nodes: [
        {
          id: 'node-note',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { content: 'Text' },
        },
        {
          id: 'node-ink',
          type: 'sketch',
          parentId: 'node-frame',
          position: { x: 10, y: 0 },
          data: {},
        },
        {
          id: 'node-agent',
          type: 'question',
          position: { x: 20, y: 0 },
          data: { threadId: 'thread-original' },
        },
        { id: 'node-frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'edge-original', source: 'node-note', target: 'node-agent' },
      ],
    },
  };
}
function envelope(): ChatEnvelope {
  return chatEnvelopeSchema.parse({
    user: {
      text: 'Explain',
      inputKind: 'ink-intent',
      attachments: [
        {
          type: 'text',
          source: 'excerpt',
          content: 'text',
          originNodeId: 'node-note',
        },
      ],
    },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      anchor: { nodeId: 'node-agent' },
      groundingVisual: {
        kind: 'visible-canvas',
        dataUrl: 'data:image/png;base64,AAAA',
        viewport: {
          x: 0,
          y: 0,
          zoom: 1,
          width: 100,
          height: 100,
          devicePixelRatio: 1,
        },
        crop: { x: 0, y: 0, width: 100, height: 100 },
        selectedNodeIds: ['node-note'],
        strokeSubsets: [{ nodeId: 'node-ink', strokeIds: ['stroke-a'] }],
      },
      selection: {
        refs: [{ id: 'node-note', type: 'note', filename: 'nodes/Note.md' }],
        selectedIds: ['node-note', 'node-ink'],
        strokeSubsets: [{ nodeId: 'node-ink', strokeIds: ['stroke-a'] }],
        imageAttachments: [],
        snapshotAttachments: [],
        textContents: [{ nodeId: 'node-note', content: 'Text' }],
      },
    },
  });
}
async function importTurn(format: string, turn: AgentTurn) {
  const namespace = {
    name: 'source',
    storage: { root: path.join(root, '.history') },
  };
  const turns = new FileTurnStore();
  new FileThreadStore().upsert(namespace, 'thread-original', {
    driverSchemaVersion: 1,
    spec: {
      kind: 'internal',
      workloadType: 'Deployment',
      namespace,
      threadId: 'thread-original',
      spec: {},
    },
    state: { driverState: {} },
  });
  const persisted: PersistedTurn = { seqStart: 1, seqEnd: 3, turn };
  if (format === 'sqlite') {
    turns.append(namespace, 'thread-original', persisted);
    turns.close(namespace);
  } else {
    await mkdir(path.join(namespace.storage.root, 'chat_v2'));
    await writeFile(
      path.join(
        namespace.storage.root,
        'chat_v2',
        'thread-original.turns.jsonl',
      ),
      JSON.stringify(persisted),
    );
  }
  const imported = await remapImportedSpace(root, record(), 'target');
  const nodes = imported.state.nodes as CanvasNode[];
  try {
    return {
      nodes,
      turn: turns.list(namespace, String(nodes[2].data.threadId))[0].turn,
    };
  } finally {
    turns.close(namespace);
  }
}

it.each(['jsonl', 'sqlite'])(
  'restores attachment navigation and selection deduplication in %s',
  async (format) => {
    const input = envelope();
    input.user.attachments.push({
      type: 'text',
      source: 'selection',
      originNodeId: 'node-note',
    });
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input),
      transcript: [],
    });
    const messages: ChatHistoryItem[] = [];
    buildHistoryFromTurns([turn], messages);
    const user = messages[0];
    if (user.role !== 'user') throw new Error('Expected user message');
    expect(user.attachments).toHaveLength(1);
    expect(user.attachments?.[0].originNodeId).toBe(nodes[0].id);
    expect(
      chatEnvelopeSchema.parse(turn.request?.content).focus.selection
        .textContents,
    ).toEqual([{ nodeId: nodes[0].id, content: 'Text' }]);
  },
);

it.each(['jsonl', 'sqlite'])(
  'rebases attachment content links in captured and rebuilt history in %s',
  async (format) => {
    const input = envelope();
    delete input.user.inputKind;
    input.focus = {
      selection: {
        refs: [],
        selectedIds: [],
        imageAttachments: [],
        snapshotAttachments: [],
      },
    };
    const content = [
      'Keep node-note and thread-original as prose.',
      '![chart](/api/canvas/source/artifact/chart.png)',
      '[Note](/canvas/source?node=node-note)',
      '[Other](/canvas/other?node=node-note)',
      '[External](https://example.com/chart.png)',
    ].join('\n');
    input.user.text = content;
    input.user.attachments[0] = {
      ...input.user.attachments[0],
      content,
      label: 'node-note',
      filename: 'node-note.md',
    };
    const rendered = await renderInternalAgentInputs(input, {
      canvasId: 'source',
    });
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input, rendered),
      transcript: [],
    });
    const imported = chatEnvelopeSchema.parse(turn.request?.content);
    const expected = content
      .replace('/api/canvas/source/artifact/', '/api/canvas/target/artifact/')
      .replace(
        '/canvas/source?node=node-note',
        `/canvas/target?node=${nodes[0].id}`,
      );
    expect(imported.user.attachments[0]).toEqual({
      ...input.user.attachments[0],
      content: expected,
      originNodeId: nodes[0].id,
    });
    expect(imported.user.text).toBe(content);
    for (const request of [turn.request, createChatSubmission(imported)]) {
      const replay = await rebuildTurnMessages(
        { ...turn, request },
        { canvasId: 'target' },
      );
      expect(JSON.stringify(replay)).toContain(
        JSON.stringify(expected).slice(1, -1),
      );
    }
  },
);

it.each(['jsonl', 'sqlite'])(
  'rebases captured OCR origins without changing transcription in %s',
  async (format) => {
    const input = envelope();
    const recognition = {
      provider: 'azure-vision' as const,
      apiVersion: '2024-02-01',
      originNodeIds: ['node-ink', 'node-note', 'node-outside'],
      lines: [{ text: 'Keep node-ink & node-note unchanged', confidence: 0.9 }],
    };
    input.focus.selection.inkRecognition = recognition;
    const ocr = renderInkRecognition(recognition);
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input, [{ type: 'text', text: ocr }]),
      transcript: [],
    });
    const mapped = {
      ...recognition,
      originNodeIds: [nodes[1].id, nodes[0].id, 'node-outside'],
    };
    expect(
      chatEnvelopeSchema.parse(turn.request?.content).focus.selection
        .inkRecognition,
    ).toEqual(mapped);
    expect(turn.request?.rendered).toEqual([
      { type: 'text', text: renderInkRecognition(mapped) },
    ]);
    const replay = await rebuildTurnMessages(turn, { canvasId: 'target' });
    expect(JSON.stringify(replay)).toContain(
      JSON.stringify(renderInkRecognition(mapped)).slice(1, -1),
    );
  },
);

it.each(['jsonl', 'sqlite'])(
  'preserves the Ink retry wire invariant in %s',
  async (format) => {
    const input = envelope();
    function retry(env: ChatEnvelope, noteId: string, inkId: string) {
      return agentRequestSchema.safeParse({
        canvasId: 'target',
        inputKind: 'ink-intent',
        content: '',
        canvasContext: {
          selectedNodes: [
            { id: noteId, type: 'note' },
            { id: inkId, type: 'sketch', strokeIds: ['stroke-a'] },
          ],
        },
        groundingVisual: env.focus.groundingVisual,
      });
    }
    expect(retry(input, 'node-note', 'node-ink').success).toBe(true);
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input),
      transcript: [],
    });
    const imported = chatEnvelopeSchema.parse(turn.request?.content);
    expect(imported.focus.groundingVisual?.dataUrl).toBe(
      input.focus.groundingVisual?.dataUrl,
    );
    expect(imported.focus.selection.strokeSubsets?.[0].strokeIds).toEqual([
      'stroke-a',
    ]);
    expect(retry(imported, nodes[0].id, nodes[1].id).success).toBe(true);
  },
);

it.each(['jsonl', 'sqlite'])(
  'rebases canonical replay without changing user text or images in %s',
  async (format) => {
    const input = envelope();
    input.user.text =
      '<node id="node-note" /> [original](/canvas/source?node=node-note)';
    const user = `<user_request>\n${input.user.text}\n</user_request>`;
    const rendered: AgentInput[] = [
      {
        type: 'parts',
        parts: [
          {
            type: 'text',
            text:
              renderNodes(input.focus.selection.refs) +
              '\n[Node](/canvas/source?node=node-note)\n/api/canvas/source/artifact/a.png',
          },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: user },
        ],
      },
    ];
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input, rendered),
      transcript: [],
    });
    const replay = await rebuildTurnMessages(turn, { canvasId: 'target' });
    expect(replay[0]).toMatchObject({
      content: [
        { type: 'text', text: expect.stringContaining(`id="${nodes[0].id}"`) },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: user },
      ],
    });
    expect(JSON.stringify(replay)).toContain(
      '/api/canvas/target/artifact/a.png',
    );
    expect(chatEnvelopeSchema.parse(turn.request?.content).user.text).toBe(
      input.user.text,
    );
  },
);

it.each([
  { kind: 'create', edited: false },
  { kind: 'create', edited: true },
  { kind: 'update', edited: false },
  { kind: 'update', edited: true },
])(
  'rebases $kind fingerprints while preserving staleness: edited=$edited',
  async ({ kind, edited }) => {
    const source = record();
    const note = source.state.nodes[0] as CanvasNode;
    note.data.content = '[Ink](/canvas/source?node=node-ink)';
    const [change] = extractCanvasChanges([
      kind === 'create'
        ? { type: 'INSERT_NODE', node: structuredClone(note) }
        : {
            type: 'REPLACE_NODE',
            prev: { ...note, data: { content: 'Before' } },
            next: structuredClone(note),
          },
    ]);
    if (edited) note.data.content += ' Later human edit';
    await mkdir(path.join(root, '.history', 'chat'), { recursive: true });
    await writeFile(
      path.join(root, '.history', 'chat', 'thread-original.changes.json'),
      JSON.stringify([change]),
    );
    const imported = await remapImportedSpace(root, source, 'target');
    const nodes = imported.state.nodes as CanvasNode[];
    const [mapped] = JSON.parse(
      await readFile(
        path.join(
          root,
          '.history',
          'chat',
          `${nodes[2].data.threadId}.changes.json`,
        ),
        'utf8',
      ),
    );
    expect(
      mapped.appliedFingerprint ===
        fingerprintNodeFields(nodes[0], mapped.fingerprintKeys),
    ).toBe(!edited);
  },
);

it.each([
  {
    type: 'CREATE_NODES',
    nodes: [
      {
        nodeType: 'note',
        data: { content: 'body' },
        position: { x: 0, y: 0 },
        parentId: 'node-frame',
      },
    ],
  },
  { type: 'DELETE_NODES', nodeIds: ['node-note'] },
  {
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: 'node-note', patch: { content: 'new body' } }],
  },
  { type: 'SET_NODE_PARENT', nodeIds: ['node-note'], parentId: 'node-frame' },
  { type: 'DISSOLVE_FRAME', frameId: 'node-frame' },
  {
    type: 'CONNECT_NODES',
    edges: [{ source: 'node-note', target: 'node-agent' }],
  },
  { type: 'DISCONNECT_EDGES', edges: ['edge-original'] },
  {
    type: 'DISCONNECT_EDGES',
    edges: [{ source: 'node-note', target: 'node-agent' }],
  },
  {
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: 'node-note', position: { x: 30, y: 0 } }],
  },
  {
    type: 'SET_FRAME_LAYOUT',
    frameId: 'node-frame',
    mode: 'grid',
    cells: [{ nodeId: 'node-ink', column: 0 }],
  },
  { type: 'REORDER_NODES', nodeIds: ['node-note'], to: { before: 'node-ink' } },
  { type: 'REORDER_NODES', nodeIds: ['node-note'], to: { after: 'node-ink' } },
  {
    type: 'SET_EDGE_STYLE',
    edges: [{ edge: { source: 'node-note', target: 'node-agent' }, style: {} }],
  },
  { type: 'SET_EDGE_STYLE', edges: [{ edge: 'edge-original', style: {} }] },
  {
    type: 'ALIGN_NODES',
    nodeIds: ['node-note', 'node-ink'],
    direction: 'left',
  },
  {
    type: 'DISTRIBUTE_NODES',
    nodeIds: ['node-note', 'node-ink', 'node-agent'],
  },
] satisfies CanvasCommand[])(
  'maps command references in inputs and JSON outputs: $type',
  async (command) => {
    agentCanvasCommandSchema.parse(command);
    const { turn } = await importTurn('sqlite', {
      request: null,
      transcript: [
        {
          type: 'tool_call',
          data: {
            toolCallId: 'call',
            title: 'space_commands',
            rawInput: { commands: [command] },
            rawOutput: JSON.stringify({ commands: [command] }),
          },
        },
      ],
    });
    const text = JSON.stringify(turn.transcript);
    for (const id of [
      'node-note',
      'node-ink',
      'node-frame',
      'node-agent',
      'edge-original',
    ])
      expect(text).not.toContain(id);
  },
);

it.each([
  {
    action: 'node_connected',
    source: { id: 'node-note', type: 'note' },
    target: { id: 'node-agent', type: 'question' },
  },
  {
    action: 'node_framed',
    node: { id: 'node-note', type: 'note' },
    frame: { id: 'node-frame', type: 'frame' },
  },
  {
    action: 'edges_disconnected',
    edges: [
      {
        source: { id: 'node-note', type: 'note' },
        target: { id: 'node-agent', type: 'question' },
      },
    ],
  },
])('maps action-log references: $action', async (raw) => {
  const payload = recentActionSchema.parse(raw);
  await mkdir(path.join(root, '.history'));
  await writeFile(
    path.join(root, '.history', 'events.jsonl'),
    JSON.stringify({ ts: 1, payload }),
  );
  await remapImportedSpace(root, record(), 'target');
  const text = await readFile(
    path.join(root, '.history', 'events.jsonl'),
    'utf8',
  );
  for (const id of ['node-note', 'node-agent', 'node-frame'])
    expect(text).not.toContain(id);
});

it('maps excerpt provenance without changing custom node payloads', async () => {
  const source = record();
  const custom = {
    nodeId: 'node-note',
    content: { threadId: 'thread-original' },
  };
  (source.state.nodes[1] as CanvasNode).data = {
    origin: { type: 'user-excerpt', excerptFromNodeId: 'node-note' },
    custom,
  };
  const imported = await remapImportedSpace(root, source, 'target');
  const [note, excerpt] = imported.state.nodes as CanvasNode[];
  expect(excerpt.data.origin).toMatchObject({ excerptFromNodeId: note.id });
  expect(excerpt.data.custom).toEqual(custom);
});

it.each(['jsonl', 'sqlite'])(
  'migrates actual generated Ink inputs and command context in %s',
  async (format) => {
    const input = envelope();
    const screenshot = 'data:image/png;base64,AAAA';
    input.user.text = 'Keep node-note unchanged';
    input.focus.selection.inkRecognition = {
      provider: 'azure-vision',
      apiVersion: '2024-02-01',
      originNodeIds: ['node-ink', 'node-note'],
      lines: [{ text: 'Keep node-ink unchanged' }],
    };
    input.focus.selection.snapshotAttachments = [
      {
        type: 'image',
        source: 'selection',
        originNodeIds: ['node-ink', 'node-note'],
        url: screenshot,
      },
    ];
    input.focus.selection.inkGeometry = [
      {
        nodeId: 'node-ink',
        strokeIds: ['stroke-a'],
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    ];
    input.focus.resources = {
      refs: [],
      imageAttachments: [],
      bindings: [
        {
          id: 'binding',
          fingerprint: '0123456789abcdef',
          targetNodeId: 'node-note',
          targetType: 'note',
          label: 'node-note',
          sources: ['a', 'b', 'c', 'd'].map((strokeId) => ({
            nodeId: 'node-ink',
            strokeId,
          })),
          sourceBounds: { x: 0, y: 0, width: 10, height: 10 },
        },
      ],
    };
    const rendered = await renderInternalAgentInputs(input, {
      canvasId: 'source',
    });
    const parts = rendered.flatMap((value) =>
      value.type === 'parts' ? value.parts : [],
    );
    expect(parts.length).toBeGreaterThan(0);
    const { nodes, turn } = await importTurn(format, {
      request: createChatSubmission(input, [
        { type: 'command', text: '/do node-note', context: parts },
      ]),
      transcript: [],
    });
    const json = JSON.stringify(turn.request?.rendered);
    expect(json).toContain(`nodeId\\":\\"${nodes[1].id}`);
    expect(json).toContain(`targetNodeId\\":\\"${nodes[0].id}`);
    expect(json).toContain(`origin=\\"${nodes[1].id}, ${nodes[0].id}\\"`);
    expect(json).toContain(`origin=\\"${nodes[1].id} ${nodes[0].id}\\"`);
    expect(json).toContain('Keep node-note unchanged');
    expect(json).toContain('/do node-note');
    expect(json).toContain('"data":"AAAA"');
    expect(
      chatEnvelopeSchema.parse(turn.request?.content).focus.resources
        ?.bindings[0],
    ).toMatchObject({
      id: 'binding',
      fingerprint: '0123456789abcdef',
      targetNodeId: nodes[0].id,
      label: 'node-note',
      sources: [
        { nodeId: nodes[1].id, strokeId: 'a' },
        { nodeId: nodes[1].id, strokeId: 'b' },
        { nodeId: nodes[1].id, strokeId: 'c' },
        { nodeId: nodes[1].id, strokeId: 'd' },
      ],
    });
  },
);

it('preserves quoted prose and skills in flattened canonical input', async () => {
  const input = envelope();
  input.user.text = '<node id="node-note" />';
  const skill = '<invoked_skills>\n<node id="node-note" />\n</invoked_skills>';
  const quote =
    '<quoted_comments>\n[Original](/canvas/source?node=node-note)\n</quoted_comments>';
  const { nodes, turn } = await importTurn('jsonl', {
    request: createChatSubmission(input, [
      {
        type: 'text',
        text: `${skill}\n${renderNodes(input.focus.selection.refs)}\n${quote}\n<user_request>\n${input.user.text}\n</user_request>`,
      },
    ]),
    transcript: [],
  });
  const rendered = turn.request?.rendered?.[0];
  if (rendered?.type !== 'text') throw new Error('Expected text input');
  expect(rendered.text).toContain(skill);
  expect(rendered.text).toContain(quote);
  expect(rendered.text).toContain(`<node id="${nodes[0].id}"`);
  expect(rendered.text).toContain(
    `<user_request>\n${input.user.text}\n</user_request>`,
  );
});

it('migrates Interactive View event identity but not application event input', async () => {
  const input = {
    nodeId: 'node-note',
    content: '[Original](/canvas/source?node=node-note)',
  };
  const { nodes, turn } = await importTurn('sqlite', {
    request: createInteractiveViewSubmission({
      protocolVersion: 1,
      nodeId: 'node-note',
      actionId: 'node-note',
      input,
      viewRevision: 'rev',
    }),
    transcript: [],
  });
  expect(turn.request?.content).toMatchObject({
    nodeId: nodes[0].id,
    actionId: 'node-note',
    input,
  });
  const text = JSON.stringify(turn.request?.rendered);
  expect(text).toContain(`nodeId\\":\\"${nodes[0].id}`);
  expect(text).toContain('canvas/source?node=node-note');
  expect(text).toContain('nodeId\\":\\"node-note');
});

it('rejects an inconsistent historical fingerprint instead of making it revertible', async () => {
  const source = record();
  const [change] = extractCanvasChanges([
    { type: 'INSERT_NODE', node: source.state.nodes[0] as CanvasNode },
  ]);
  change.appliedFingerprint = 'inconsistent';
  await mkdir(path.join(root, '.history', 'chat'), { recursive: true });
  await writeFile(
    path.join(root, '.history', 'chat', 'thread-original.changes.json'),
    JSON.stringify([change]),
  );
  await expect(remapImportedSpace(root, source, 'target')).rejects.toThrow(
    'Imported change fingerprint does not match its applied snapshot',
  );
});
