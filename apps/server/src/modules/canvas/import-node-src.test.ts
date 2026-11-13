// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importForeignNodeSources, NodeCoverError } from './import-node-src.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { space, getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@huabu/shared';

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
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response('downloaded bytes', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  tmp = mkdtempSync(path.join(tmpdir(), 'huabu-import-node-src-'));
  setWorkspacePath(tmp);
  for (const canvasId of [
    'c-web-local',
    'c-web-invalid-local',
    'c-web-remote',
    'c-web-data',
    'c-web-merge-local',
    'c-web-merge-multiple',
    'c-web-merge-remote',
    'c-image-local',
    'c-image-reentered',
    'c-pdf-cover',
  ]) {
    createCanvas(canvasId);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

/** Stage a file under the canvas's hidden `.upload/` scratch dir. */
function stageUpload(canvasId: string, name: string, body: string): string {
  const uploadDir = path.join(diskDirOf(canvasId), '.upload');
  mkdirSync(uploadDir, { recursive: true });
  const abs = path.join(uploadDir, name);
  writeFileSync(abs, body);
  return abs;
}

/** Extract the (single) node's rewritten `src` from a CREATE_NODES batch. */
function firstSrc(commands: CanvasCommand[]): string | undefined {
  const create = commands.find((c) => c.type === 'CREATE_NODES');
  if (create?.type !== 'CREATE_NODES') return undefined;
  const data = create.nodes[0]?.data as Record<string, unknown> | undefined;
  return data?.['src'] as string | undefined;
}

/** Extract the first rewritten `src` from a MERGE_NODE_DATA batch. */
function firstPatchedSrc(commands: CanvasCommand[]): string | undefined {
  const merge = commands.find((c) => c.type === 'MERGE_NODE_DATA');
  if (merge?.type !== 'MERGE_NODE_DATA') return undefined;
  const src = merge.patches[0]?.patch?.src;
  return typeof src === 'string' ? src : undefined;
}

/** Seed a Space with one existing web node for merge-path tests. */
function seedWebNode(canvasId: string, nodeId: string, src: string): void {
  seedWebNodes(canvasId, [{ nodeId, src }]);
}

/** Seed a Space with existing web nodes for merge-path tests. */
function seedWebNodes(
  canvasId: string,
  nodes: readonly { nodeId: string; src: string }[],
): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: nodes.map(({ nodeId, src }) => ({
        id: nodeId,
        type: 'web',
        position: { x: 0, y: 0 },
        data: { label: 'Existing page', src },
      })),
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe('importForeignNodeSources — web nodes', () => {
  it('relocates a locally-staged HTML upload into .artifacts/ and reclaims it', async () => {
    const canvasId = 'c-web-local';
    const uploadAbs = stageUpload(
      canvasId,
      'index.html',
      '<!doctype html><title>hi</title>',
    );

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: 'upload/index.html', label: 'My page' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);
    const src = firstSrc(out);

    // Rewritten to a bare artifact key…
    expect(src).toMatch(/^artifact-[^/]+\.html$/);
    // …whose file exists in the artifact store…
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten web src');
    expect(await space(canvasId).artifacts.head(src)).not.toBeNull();
    // …and the staging upload was reclaimed (move semantics).
    expect(existsSync(uploadAbs)).toBe(false);
  });

  it('rejects a non-HTML local upload without reclaiming it', async () => {
    const canvasId = 'c-web-invalid-local';
    const uploadAbs = stageUpload(canvasId, 'document.pdf', 'not html');

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: 'upload/document.pdf', label: 'Wrong source' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);

    expect(firstSrc(out)).toBe('upload/document.pdf');
    expect(existsSync(uploadAbs)).toBe(true);
  });

  it('leaves a live remote URL untouched (never downloads it)', async () => {
    const canvasId = 'c-web-remote';
    const remote = 'https://example.com/some/page.html';

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: remote, label: 'Live site' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);
    expect(firstSrc(out)).toBe(remote);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a data: URL untouched', async () => {
    const canvasId = 'c-web-data';
    const dataUrl = 'data:text/html,<h1>inline</h1>';

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: dataUrl, label: 'Inline' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);
    expect(firstSrc(out)).toBe(dataUrl);
  });

  it('relocates a local HTML upload in MERGE_NODE_DATA', async () => {
    const canvasId = 'c-web-merge-local';
    const nodeId = 'node-web-merge-local';
    seedWebNode(canvasId, nodeId, 'https://example.com/old');
    const uploadAbs = stageUpload(
      canvasId,
      'replacement.html',
      '<!doctype html><title>replacement</title>',
    );
    const commands: CanvasCommand[] = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId, patch: { src: 'upload/replacement.html' } }],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);
    const src = firstPatchedSrc(out);

    expect(src).toMatch(/^artifact-[^/]+\.html$/);
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten web src');
    expect(await space(canvasId).artifacts.head(src)).not.toBeNull();
    expect(existsSync(uploadAbs)).toBe(false);
  });

  it('leaves a remote URL untouched in MERGE_NODE_DATA', async () => {
    const canvasId = 'c-web-merge-remote';
    const nodeId = 'node-web-merge-remote';
    seedWebNode(canvasId, nodeId, 'https://example.com/old');
    const remote = 'https://example.com/new';
    const commands: CanvasCommand[] = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId, patch: { src: remote } }],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);

    expect(firstPatchedSrc(out)).toBe(remote);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes every entry in a multi-node MERGE_NODE_DATA command', async () => {
    const canvasId = 'c-web-merge-multiple';
    const firstNodeId = 'node-web-merge-first';
    const secondNodeId = 'node-web-merge-second';
    seedWebNodes(canvasId, [
      { nodeId: firstNodeId, src: 'https://example.com/first' },
      { nodeId: secondNodeId, src: 'https://example.com/second' },
    ]);
    const firstUpload = stageUpload(canvasId, 'first.html', '<p>first</p>');
    const secondUpload = stageUpload(canvasId, 'second.html', '<p>second</p>');

    const out = await importForeignNodeSources(canvasId, [
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: firstNodeId, patch: { src: 'upload/first.html' } },
          { nodeId: secondNodeId, patch: { src: 'upload/second.html' } },
        ],
      },
    ]);
    const command = out[0];
    if (command?.type !== 'MERGE_NODE_DATA') {
      throw new Error('Expected MERGE_NODE_DATA output');
    }

    expect(command.patches.map((entry) => entry.patch.src)).toEqual([
      expect.stringMatching(/^artifact-[^/]+\.html$/),
      expect.stringMatching(/^artifact-[^/]+\.html$/),
    ]);
    expect(existsSync(firstUpload)).toBe(false);
    expect(existsSync(secondUpload)).toBe(false);
  });
});

describe('importForeignNodeSources — media nodes (regression)', () => {
  const youtubeUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42',
    'https://youtu.be/dQw4w9WgXcQ?si=share',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'http://youtube.com/live/dQw4w9WgXcQ',
  ];

  describe.each(['CREATE_NODES', 'MERGE_NODE_DATA'] as const)('%s', (type) => {
    async function importSrc(
      src: string,
      nodeType:
        | 'video'
        | 'image'
        | 'audio'
        | 'pdf'
        | 'office'
        | 'web' = 'video',
    ): Promise<string | undefined> {
      const canvasId = 'c-media-remote';
      createCanvas(canvasId);
      const nodeId = 'node-media-remote';
      const store = getCanvasStore(canvasId);
      const canvas = store.read();
      if (!canvas) throw new Error('Expected a canvas');
      store.write({
        ...canvas,
        state: {
          nodes: [
            { id: nodeId, type: nodeType, position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [],
        },
      });
      const commands: CanvasCommand[] =
        type === 'CREATE_NODES'
          ? [
              {
                type,
                nodes: [{ nodeType, position: { x: 0, y: 0 }, data: { src } }],
              },
            ]
          : [{ type, patches: [{ nodeId, patch: { src } }] }];
      const out = await importForeignNodeSources(canvasId, commands);
      return type === 'CREATE_NODES' ? firstSrc(out) : firstPatchedSrc(out);
    }

    it.each(youtubeUrls)(
      'preserves validated video URL without fetching: %s',
      async (src) => {
        expect(await importSrc(src)).toBe(src);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be.evil.example/dQw4w9WgXcQ',
      'https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=invalid',
      'https://youtube.com/playlist?list=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ/extra',
    ])(
      'does not bypass downloads for lookalike or invalid video URL: %s',
      async (src) => {
        expect(await importSrc(src)).toMatch(/^artifact-[^/]+\.bin$/);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          src,
          expect.any(Object),
        );
      },
    );

    it.each(['image', 'audio', 'pdf', 'office'] as const)(
      'still downloads YouTube URLs on %s nodes',
      async (nodeType) => {
        const src = youtubeUrls[0];
        expect(await importSrc(src, nodeType)).toMatch(/^artifact-[^/]+\.bin$/);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          src,
          expect.any(Object),
        );
      },
    );

    it.each([
      ['video', 'mp4'],
      ['image', 'png'],
      ['audio', 'mp3'],
      ['pdf', 'pdf'],
      ['office', 'docx'],
    ] as const)(
      'still imports direct remote %s bytes',
      async (nodeType, extension) => {
        const src = `https://example.com/media.${extension}`;
        const imported = await importSrc(src, nodeType);
        expect(imported).toMatch(new RegExp(`^artifact-[^/]+\\.${extension}$`));
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          src,
          expect.any(Object),
        );
        if (!imported) throw new Error('Expected an imported artifact');
        expect(await space('c-media-remote').artifacts.read(imported)).toEqual(
          Buffer.from('downloaded bytes'),
        );
      },
    );

    it.each([
      youtubeUrls[0],
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    ])('preserves any remote web URL without fetching: %s', async (src) => {
      expect(await importSrc(src, 'web')).toBe(src);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('still relocates a locally-staged image upload', async () => {
    const canvasId = 'c-image-local';
    stageUpload(canvasId, 'pic.png', 'not-a-real-png-but-bytes');

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'image',
            data: { src: 'upload/pic.png' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);
    const src = firstSrc(out);
    expect(src).toMatch(/^artifact-[^/]+\.png$/);
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten image src');
    expect(await space(canvasId).artifacts.head(src)).not.toBeNull();
  });

  it('canonicalizes an artifact path that leaves and re-enters the Space', async () => {
    const canvasId = 'c-image-reentered';
    const spaceDir = diskDirOf(canvasId);
    const artifactsDir = path.join(spaceDir, '.artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, 'pic.png'), 'existing artifact');
    const src = path.join(
      '..',
      path.basename(spaceDir),
      '.artifacts',
      'pic.png',
    );

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'image',
            data: { src },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(canvasId, commands);

    expect(firstSrc(out)).toBe('pic.png');
  });
});

describe('importForeignNodeSources — PDF covers', () => {
  const canvasId = 'c-pdf-cover';
  /** The agent command contract, as the RFS and built-in agent entries use it. */
  const importCovers = (commands: readonly CanvasCommand[]) =>
    importForeignNodeSources('c-pdf-cover', commands, { agentCovers: true });
  // 1×1 images: covers are validated by their bytes, not their names.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );

  function stageBytes(name: string, body: Buffer): string {
    const uploadDir = path.join(diskDirOf(canvasId), '.upload');
    mkdirSync(uploadDir, { recursive: true });
    const abs = path.join(uploadDir, name);
    writeFileSync(abs, body);
    return abs;
  }

  function seedNodes(...types: string[]): void {
    getCanvasStore(canvasId).write({
      canvasId,
      title: null,
      version: 1,
      state: {
        nodes: types.map((type, index) => ({
          id: `node-${index + 1}`,
          type,
          position: { x: 0, y: 0 },
          data: { label: 'Existing node' },
        })),
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  function mergeCovers(...coverUrls: (string | null)[]): CanvasCommand[] {
    return [
      {
        type: 'MERGE_NODE_DATA',
        patches: coverUrls.map((coverUrl, index) => ({
          nodeId: `node-${index + 1}` as const,
          patch: { coverUrl },
        })),
      },
    ];
  }

  function patchedCovers(commands: CanvasCommand[]): unknown[] {
    const merge = commands.find((c) => c.type === 'MERGE_NODE_DATA');
    if (merge?.type !== 'MERGE_NODE_DATA') return [];
    return merge.patches.map(
      (entry) => (entry.patch as Record<string, unknown>)['coverUrl'],
    );
  }

  it('moves a staged image upload into artifacts as the PDF cover', async () => {
    seedNodes('pdf');
    const staged = stageBytes('cover.png', PNG);

    const [cover] = patchedCovers(
      await importCovers(mergeCovers('upload/cover.png')),
    );

    expect(cover).toMatch(/^artifact-.+\.png$/);
    expect(await space(canvasId).artifacts.read(cover as string)).toEqual(PNG);
    expect(existsSync(staged)).toBe(false);
  });

  it('imports one staged upload once for every PDF that names it', async () => {
    seedNodes('pdf', 'pdf');
    const staged = stageBytes('cover.png', PNG);

    const covers = patchedCovers(
      await importCovers(mergeCovers('upload/cover.png', 'upload/cover.png')),
    );

    expect(covers[0]).toMatch(/^artifact-.+\.png$/);
    expect(covers[1]).toBe(covers[0]);
    expect(existsSync(staged)).toBe(false);
  });

  it('leaves staged uploads in place when a later cover rejects the batch', async () => {
    seedNodes('pdf', 'pdf');
    const staged = stageBytes('cover.png', PNG);
    const commands = mergeCovers('upload/cover.png', 'missing.png');

    await expect(importCovers(commands)).rejects.toBeInstanceOf(NodeCoverError);
    // The retry, with the bad cover fixed, still finds the upload.
    expect(existsSync(staged)).toBe(true);
    const covers = patchedCovers(
      await importCovers(mergeCovers('upload/cover.png', null)),
    );
    expect(covers[0]).toMatch(/^artifact-.+\.png$/);
    expect(covers[1]).toBeNull();
  });

  it('keeps an existing image artifact key and passes null through to clear', async () => {
    seedNodes('pdf');
    await space(canvasId).artifacts.put('existing.gif', GIF);

    expect(
      patchedCovers(await importCovers(mergeCovers('existing.gif'))),
    ).toEqual(['existing.gif']);
    expect(patchedCovers(await importCovers(mergeCovers(null)))).toEqual([
      null,
    ]);
  });

  it('downloads a remote image as the cover', async () => {
    seedNodes('pdf');
    fetchMock.mockImplementation(
      async () =>
        new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    );

    const [cover] = patchedCovers(
      await importCovers(mergeCovers('https://example.com/cover')),
    );

    expect(cover).toMatch(/^artifact-.+\.png$/);
  });

  it('rejects a plain-HTTP cover without fetching it', async () => {
    seedNodes('pdf');
    fetchMock.mockImplementation(
      async () =>
        new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    );

    await expect(
      importCovers(mergeCovers('http://example.com/cover.png')),
    ).rejects.toBeInstanceOf(NodeCoverError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a cover on a PDF created earlier in the same batch and drops a null cover on create', async () => {
    seedNodes('pdf');
    await space(canvasId).artifacts.put('existing.gif', GIF);
    const position = { x: 0, y: 0 };

    const out = await importCovers([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-new-a',
            nodeType: 'pdf',
            position,
            data: { coverUrl: null },
          },
          { id: 'node-new-b', nodeType: 'pdf', position },
        ],
      } as unknown as CanvasCommand,
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: 'node-new-b', patch: { coverUrl: 'existing.gif' } },
        ],
      },
    ]);

    const create = out[0];
    if (create?.type !== 'CREATE_NODES') throw new Error('Expected a create');
    expect(create.nodes[0]?.data).toEqual({});
    expect(patchedCovers(out)).toEqual(['existing.gif']);
  });

  it.each([
    ['a missing artifact key', 'pdf', 'missing.png'],
    ['a non-image artifact', 'pdf', 'paper.pdf'],
    ['a non-image upload', 'pdf', 'upload/notes.txt'],
    ['an image name over non-image bytes', 'pdf', 'page.png'],
    ['a corrupt staged image', 'pdf', 'upload/broken.png'],
    ['a non-PDF target', 'note', 'existing.gif'],
    ['clearing a non-PDF target', 'note', null],
  ])('rejects %s', async (_case, type, coverUrl) => {
    seedNodes(type);
    await space(canvasId).artifacts.put('existing.gif', GIF);
    await space(canvasId).artifacts.put('paper.pdf', Buffer.from('pdf'));
    await space(canvasId).artifacts.put('page.png', Buffer.from('<html>'));
    stageUpload(canvasId, 'notes.txt', 'text');
    stageUpload(canvasId, 'broken.png', 'not a png');

    await expect(importCovers(mergeCovers(coverUrl))).rejects.toBeInstanceOf(
      NodeCoverError,
    );
  });

  it.each([
    ['an extensionless URL', 'https://example.com/cover'],
    // The suffix is trusted for the stored name, so only the bytes can tell.
    ['a .png URL', 'https://example.com/cover.png'],
  ])('rejects %s that answers with an HTML page', async (_case, url) => {
    seedNodes('pdf');
    // The shared fetch stub answers with text/html.
    await expect(importCovers(mergeCovers(url))).rejects.toBeInstanceOf(
      NodeCoverError,
    );
  });

  it('leaves every cover verbatim for callers outside the agent contract', async () => {
    seedNodes('pdf', 'web', 'note');
    // What such callers always could send: a client-reachable URL, an SVG, a
    // cover on a Web node. None of it is fetched, checked or rewritten.
    const commands = mergeCovers(
      'https://intranet.example.test/cover.png',
      'https://example.com/cover.svg',
      'anything',
    );
    expect(await importForeignNodeSources(canvasId, commands)).toEqual(
      commands,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets one staged upload serve as a PDF cover and an image source in the same batch', async () => {
    seedNodes('pdf');
    const staged = stageBytes('shared.png', PNG);

    const out = await importCovers([
      ...mergeCovers('upload/shared.png'),
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-image',
            nodeType: 'image',
            position: { x: 0, y: 0 },
            data: { src: 'upload/shared.png' },
          },
        ],
      } as unknown as CanvasCommand,
    ]);

    expect(patchedCovers(out)[0]).toMatch(/^artifact-.+\.png$/);
    // The source was still there to import, not left as a dead upload path.
    expect(firstSrc(out)).toMatch(/^artifact-.+\.png$/);
    expect(existsSync(staged)).toBe(false);
  });

  it('keeps an upload shared by a cover and a source for a caller that may still reject the batch', async () => {
    seedNodes('pdf');
    const staged = stageBytes('shared.png', PNG);
    const stagedCoverUploads: string[] = [];

    const out = await importForeignNodeSources(
      canvasId,
      [
        ...mergeCovers('upload/shared.png'),
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-image',
              nodeType: 'image',
              position: { x: 0, y: 0 },
              data: { src: 'upload/shared.png' },
            },
          ],
        } as unknown as CanvasCommand,
      ],
      { agentCovers: true, stagedCoverUploads },
    );

    expect(firstSrc(out)).toMatch(/^artifact-.+\.png$/);
    // Source normalization did not take the file the cover still owes to a
    // possible retry.
    expect(existsSync(staged)).toBe(true);
    expect(stagedCoverUploads).toEqual([staged]);
  });

  it('hands consumed cover uploads to a caller that reclaims them itself', async () => {
    seedNodes('pdf');
    const staged = stageBytes('cover.png', PNG);
    const stagedCoverUploads: string[] = [];

    await importForeignNodeSources(canvasId, mergeCovers('upload/cover.png'), {
      agentCovers: true,
      stagedCoverUploads,
    });

    expect(stagedCoverUploads).toEqual([staged]);
    expect(existsSync(staged)).toBe(true);
  });

  it('leaves a cover patch on an unknown node for the engine to reject', async () => {
    seedNodes('pdf');
    const commands: CanvasCommand[] = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-ghost', patch: { coverUrl: 'missing.png' } }],
      },
    ];
    expect(await importCovers(commands)).toEqual(commands);
  });
});
