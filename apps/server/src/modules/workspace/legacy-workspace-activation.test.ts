// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * End-to-end activation of a legacy workspace, over the production routes.
 *
 * Phase 4.5 moved the Disk record layout inside the storage boundary and
 * routed every "where is this Space" question through one accessor. This
 * suite exists to prove that the move did not change what the app can read or
 * write. It does not test a module — it activates a workspace the way a launch
 * does (`setWorkspacePath` → `prepareWorkspaceOnDisk` → every migration) and
 * then drives the same URLs the web client uses, mounted at the same prefixes
 * as `app.ts`.
 *
 * How the "old" workspace is built, and why it is honest:
 *
 *   - `space.json`, `nodes/<label>.md` and `.artifacts/<key>` are produced by
 *     the real writers and then *aged* into their pre-rename spellings
 *     (`canvas.json`, `.memory/canvas.md`, `setting/.huabu.md`). Their byte
 *     format did not change in this phase — only which module names the path —
 *     so writer-produced bytes are the same bytes an older build left behind.
 *   - The chat logs did change format, so those are hand-authored in the true
 *     legacy shapes: a bare pi-ai `Context`, and the two coexistence pairs a
 *     partially-migrated workspace can hold.
 *
 * The Space is deliberately titled so its directory name differs from its
 * canvasId. A layout that leaked the id into a path, or a history reader that
 * keyed off the namespace name instead of its storage root, fails here.
 *
 *   ✓ pre-rename topology / memory / user-memory files migrate on activation
 *   ✓ legacy Space, nodes, node bodies, artifacts and events read back over HTTP
 *   ✓ legacy chat history is served by GET /api/agent/history/:threadId
 *   ✓ a divergent legacy/new chat pair resolves instead of stalling both hops
 *   ✓ an unreadable legacy Context never costs its turn log its history
 *   ✓ new writes (node content, execute, artifact import, new Space) persist
 *   ✓ a second activation is idempotent and every read above still holds
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import agentRoutes from '../agent/agent.route.js';
import artifactRoute from '../artifact/artifact.route.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { resetStorageCache, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { FastifyInstance } from 'fastify';

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

/** The Space under test: title-derived directory name ≠ canvasId. */
const CANVAS_ID = 'legacy-space-1';
const SPACE_TITLE = 'Legacy Space';
const SPACE_DIR = 'Legacy Space';

/** Threads seeded into `.history/chat/` in their legacy spellings. */
const PLAIN_THREAD = 'thread-plain';
const DIVERGENT_THREAD = 'thread-divergent';
const BROKEN_THREAD = 'thread-broken';

let tmp: string;

/** Mount the same plugins at the same prefixes as `app.ts`. */
async function buildApp(): Promise<FastifyInstance> {
  const app = fastify();
  await app.register(multipart);
  await app.register(canvasRoutes, { prefix: '/api/canvas' });
  await app.register(artifactRoute, { prefix: '/api/canvas' });
  await app.register(agentRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

/** A bare pi-ai `Context`, as builds before the turn format wrote it. */
function legacyContext(userText: string, answer: string): unknown {
  return {
    systemPrompt: 'sys',
    tools: [],
    messages: [
      {
        role: 'user',
        content:
          '[SYSTEM Context]\n[Selected Nodes]\n[\n{"id":"n-note","type":"note","label":"Old Note"}\n]',
        timestamp: 1,
      },
      {
        role: 'user',
        content: `${userText}\n[SYSTEM selectedNodeIds:["n-note"]]`,
        timestamp: 2,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        timestamp: 3,
      },
    ],
  };
}

/** One line of the intermediate `.turns.jsonl` format. */
function turnLine(text: string): string {
  return `${JSON.stringify({
    envelope: {
      user: { text, attachments: [] },
      skills: { invokedIds: [], resolved: [] },
      focus: {
        selection: {
          refs: [],
          selectedIds: [],
          imageAttachments: [],
          snapshotAttachments: [],
        },
      },
    },
    transcript: [
      { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }] },
    ],
  })}\n`;
}

function chatDirOf(): string {
  return join(tmp, SPACE_DIR, '.history', 'chat');
}

/**
 * Build a Space with the real writers, then rewrite the parts an older build
 * spelled differently. Returns once the workspace looks pre-Phase-4.5.
 */
async function seedLegacyWorkspace(): Promise<void> {
  setWorkspacePath(tmp);
  createCanvas(CANVAS_ID, SPACE_TITLE);

  const app = await buildApp();
  try {
    // Real topology write.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/canvas/${CANVAS_ID}`,
      payload: {
        version: 0,
        title: SPACE_TITLE,
        state: {
          nodes: [
            {
              id: 'n-note',
              type: 'note',
              position: { x: 10, y: 20 },
              data: { label: 'Old Note' },
            },
          ],
          edges: [],
        },
      },
    });
    expect(put.statusCode).toBe(200);

    // Real node markdown sidecar.
    const content = await app.inject({
      method: 'PUT',
      url: `/api/canvas/${CANVAS_ID}/nodes/n-note/content`,
      payload: {
        nodeType: 'note',
        label: 'Old Note',
        labelSource: 'user',
        content: 'body written by the old build',
      },
    });
    expect(content.statusCode).toBe(200);

    // Real event row.
    const event = await app.inject({
      method: 'POST',
      url: `/api/canvas/${CANVAS_ID}/events`,
      payload: {
        events: [
          {
            ts: 1,
            payload: {
              action: 'node_created',
              nodes: [{ id: 'n-note', type: 'note', label: 'Old Note' }],
            },
          },
        ],
      },
    });
    expect(event.statusCode).toBe(200);
  } finally {
    await app.close();
  }

  // A legacy artifact, in the layout the Disk backend has always used.
  const spaceDir = diskDirOf(CANVAS_ID);
  mkdirSync(join(spaceDir, '.artifacts'), { recursive: true });
  writeFileSync(
    join(spaceDir, '.artifacts', 'art_legacy.txt'),
    'legacy artifact bytes',
  );

  // Space + user memory, in their pre-rename spellings.
  mkdirSync(join(spaceDir, '.memory'), { recursive: true });
  writeFileSync(join(spaceDir, '.memory', 'canvas.md'), 'legacy space brief');
  mkdirSync(join(tmp, 'setting'), { recursive: true });
  writeFileSync(join(tmp, 'setting', '.huabu.md'), '- legacy user preference');

  // Pre-rename topology filename.
  renameSync(join(spaceDir, 'space.json'), join(spaceDir, 'canvas.json'));

  // Legacy chat state, including both coexistence pairs.
  const chat = chatDirOf();
  mkdirSync(chat, { recursive: true });
  writeFileSync(
    join(chat, `${PLAIN_THREAD}.json`),
    JSON.stringify(legacyContext('what changed here', 'a summary')),
  );
  // Divergent: the live app wrote turns that this Context does not explain.
  writeFileSync(
    join(chat, `${DIVERGENT_THREAD}.json`),
    JSON.stringify(legacyContext('older half', 'older answer')),
  );
  writeFileSync(
    join(chat, `${DIVERGENT_THREAD}.turns.jsonl`),
    turnLine('newer half'),
  );
  // Unreadable Context beside a perfectly good turn log.
  writeFileSync(
    join(chat, `${BROKEN_THREAD}.json`),
    '{"messages":[{"role":"user"',
  );
  writeFileSync(
    join(chat, `${BROKEN_THREAD}.turns.jsonl`),
    turnLine('survivor turn'),
  );
}

/** Re-run activation the way a process restart does. */
function reactivate(): void {
  resetStorageCache();
  setWorkspacePath(tmp);
}

/** Every message text the history endpoint renders for a thread. */
async function historyTexts(
  app: FastifyInstance,
  threadId: string,
): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/agent/history/${threadId}?canvasId=${CANVAS_ID}`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    messages: { content?: unknown; text?: unknown }[];
  };
  return body.messages.flatMap((m) => {
    const raw = typeof m.content === 'string' ? m.content : m.text;
    return typeof raw === 'string' ? [raw] : [];
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-legacy-activation-'));
  await seedLegacyWorkspace();
  // The activation under test: a "new version" opening an old workspace.
  reactivate();
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('activating a legacy workspace on the new storage boundary', () => {
  it('migrates the pre-rename files and leaves their bytes alone', () => {
    const spaceDir = join(tmp, SPACE_DIR);
    expect(existsSync(join(spaceDir, 'canvas.json'))).toBe(false);
    expect(existsSync(join(spaceDir, 'space.json'))).toBe(true);
    expect(readFileSync(join(spaceDir, '.memory', 'space.md'), 'utf8')).toBe(
      'legacy space brief',
    );
    expect(readFileSync(join(tmp, 'setting', 'user.md'), 'utf8')).toBe(
      '- legacy user preference',
    );
  });

  it('serves the legacy Space, its node body, artifact and events over HTTP', async () => {
    const app = await buildApp();
    try {
      const list = await app.inject({ method: 'GET', url: '/api/canvas' });
      expect(list.statusCode).toBe(200);
      expect(
        (list.json() as { canvases: { canvasId: string; title?: string }[] })
          .canvases,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ canvasId: CANVAS_ID, title: SPACE_TITLE }),
        ]),
      );

      const read = await app.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}`,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        state: {
          nodes: [expect.objectContaining({ id: 'n-note' })],
        },
      });

      const body = await app.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/nodes/n-note/content`,
      });
      expect(body.statusCode).toBe(200);
      expect((body.json() as { content: string }).content).toContain(
        'body written by the old build',
      );

      const artifact = await app.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/artifact/art_legacy.txt`,
      });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.body).toBe('legacy artifact bytes');

      const events = await app.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/events`,
      });
      expect(events.statusCode).toBe(200);
      expect(JSON.stringify(events.json())).toContain('n-note');
    } finally {
      await app.close();
    }
  });

  it('serves the migrated legacy chat history for every seeded thread', async () => {
    const app = await buildApp();
    try {
      // A plain legacy Context: both hops ran, the turn reached chat_v2.
      expect((await historyTexts(app, PLAIN_THREAD)).join('\n')).toContain(
        'what changed here',
      );
      // Divergent pair: the live log wins and is folded, not stalled.
      expect((await historyTexts(app, DIVERGENT_THREAD)).join('\n')).toContain(
        'newer half',
      );
      // Unreadable Context: its turn log still reaches chat_v2.
      expect((await historyTexts(app, BROKEN_THREAD)).join('\n')).toContain(
        'survivor turn',
      );
    } finally {
      await app.close();
    }
  });

  it('preserves the durable state it could not convert', () => {
    const chat = chatDirOf();
    // Converted and superseded.
    expect(existsSync(join(chat, `${PLAIN_THREAD}.json.bak`))).toBe(true);
    // Kept verbatim, never converted — and no longer blocking hop 2.
    expect(existsSync(join(chat, `${DIVERGENT_THREAD}.json.unresolved`))).toBe(
      true,
    );
    expect(
      JSON.parse(
        readFileSync(join(chat, `${DIVERGENT_THREAD}.json.unresolved`), 'utf8'),
      ),
    ).toEqual(legacyContext('older half', 'older answer'));
    // Unreadable, so left exactly as found.
    expect(readFileSync(join(chat, `${BROKEN_THREAD}.json`), 'utf8')).toBe(
      '{"messages":[{"role":"user"',
    );
  });

  it('accepts new writes and persists them across a restart', async () => {
    let newCanvasId = '';
    let importedSrc = '';

    const app = await buildApp();
    try {
      // 1. Edit the legacy node's body.
      const edit = await app.inject({
        method: 'PUT',
        url: `/api/canvas/${CANVAS_ID}/nodes/n-note/content`,
        payload: {
          nodeType: 'note',
          label: 'Old Note',
          labelSource: 'user',
          content: 'body written by the NEW build',
        },
      });
      expect(edit.statusCode).toBe(200);

      // 2. Execute a real command batch that imports a staged local file into
      //    the artifact store through the blob port.
      const uploadDir = join(diskDirOf(CANVAS_ID), '.upload');
      mkdirSync(uploadDir, { recursive: true });
      writeFileSync(join(uploadDir, 'fresh.txt'), 'freshly imported bytes');
      const exec = await app.inject({
        method: 'POST',
        url: `/api/canvas/${CANVAS_ID}/execute`,
        payload: {
          // `agent` is the origin that runs the artifact import hook — the
          // path that has to keep reaching the blob port after the move.
          originator: { source: 'agent', threadId: PLAIN_THREAD },
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'image',
                  data: { src: 'upload/fresh.txt', label: 'Fresh' },
                  position: { x: 100, y: 100 },
                },
              ],
            },
          ],
        },
      });
      expect(exec.statusCode).toBe(200);

      const afterExec = await app.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}`,
      });
      const nodes = (
        afterExec.json() as { state: { nodes: { data?: { src?: string } }[] } }
      ).state.nodes;
      importedSrc =
        nodes.map((n) => n.data?.src).find((s): s is string => Boolean(s)) ??
        '';
      expect(importedSrc).not.toBe('');
      // The hook persisted a bare artifact key, not the staged path.
      expect(importedSrc).not.toContain('/');

      // 3. Create a brand-new Space through the route.
      const created = await app.inject({
        method: 'POST',
        url: '/api/canvas',
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      newCanvasId = (created.json() as { canvasId: string }).canvasId;
      expect(newCanvasId).not.toBe('');
    } finally {
      await app.close();
    }

    // Restart: re-run activation (migrations included) against the same disk.
    reactivate();

    const app2 = await buildApp();
    try {
      // The edited legacy node kept the new body.
      const body = await app2.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/nodes/n-note/content`,
      });
      expect(body.statusCode).toBe(200);
      expect((body.json() as { content: string }).content).toContain(
        'body written by the NEW build',
      );

      // The imported artifact is served from the new layout.
      const blob = await app2.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/artifact/${importedSrc}`,
      });
      expect(blob.statusCode).toBe(200);
      expect(blob.body).toBe('freshly imported bytes');

      // The legacy artifact is still there beside it.
      const legacy = await app2.inject({
        method: 'GET',
        url: `/api/canvas/${CANVAS_ID}/artifact/art_legacy.txt`,
      });
      expect(legacy.statusCode).toBe(200);

      // The new Space survived the restart.
      const list = await app2.inject({ method: 'GET', url: '/api/canvas' });
      expect(
        (list.json() as { canvases: { canvasId: string }[] }).canvases.map(
          (c) => c.canvasId,
        ),
      ).toEqual(expect.arrayContaining([CANVAS_ID, newCanvasId]));

      // The migrated history survived the restart and did not double-fold:
      // the legacy Context held exactly one real user turn.
      expect((await historyTexts(app2, PLAIN_THREAD)).join('\n')).toContain(
        'what changed here',
      );
      const foldedLines = readFileSync(
        join(
          tmp,
          SPACE_DIR,
          '.history',
          'chat_v2',
          `${PLAIN_THREAD}.turns.jsonl`,
        ),
        'utf8',
      )
        .split('\n')
        .filter(Boolean);
      expect(foldedLines).toHaveLength(1);
    } finally {
      await app2.close();
    }
  });

  it('leaves no legacy chat source unretired after activation', () => {
    const entries = readdirSync(chatDirOf());
    // Every seeded turn log was consumed by hop 2 …
    expect(entries.filter((f) => f.endsWith('.turns.jsonl'))).toEqual([]);
    // … and retired beside its replacement rather than deleted. All three
    // threads pass through the intermediate format, including the two that
    // arrived with one already written.
    expect(
      entries.filter((f) => f.endsWith('.turns.jsonl.bak')).sort(),
    ).toEqual([
      `${BROKEN_THREAD}.turns.jsonl.bak`,
      `${DIVERGENT_THREAD}.turns.jsonl.bak`,
      `${PLAIN_THREAD}.turns.jsonl.bak`,
    ]);
  });
});
