// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRfs } from '../src/rfs.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const app = createServer(handler);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      app.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = app.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected bound port');
  return {
    HUABU_RFS_URL: `http://127.0.0.1:${address.port}/rfs/space`,
    AGENTLET_TOKEN: 'private-token',
    HUABU_THREAD_ID: 'host-thread',
  };
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'huabu-rfs-test-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
function output(onChunk?: (chunk: Buffer) => void) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      onChunk?.(chunk);
      callback();
    },
  });
  return {
    stream,
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString(),
  };
}
async function bytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function call(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: Buffer = Buffer.alloc(0),
  extra: Parameters<typeof runRfs>[1] = {},
) {
  const stdout = output();
  const stderr = output();
  const code = await runRfs(args, {
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([stdin]),
    ...extra,
  });
  return { code, stdout: stdout.bytes(), stderr: stderr.text() };
}

function zip(
  entries: {
    name: string;
    data?: string;
    attributes?: number;
    checksum?: number;
    expanded?: number;
    method?: number;
  }[],
) {
  const bodies: Buffer[] = [];
  const index: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(entry.checksum ?? crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.expanded ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(entry.checksum ?? crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.expanded ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    bodies.push(local, name, data);
    index.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const catalogue = Buffer.concat(index);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(catalogue.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, catalogue, end]);
}

describe('optional raw RFS client', () => {
  it.each([
    [['get-skill', 'services'], '/skill/services'],
    [['agent', 'profiles'], '/agent/profiles'],
    [['service', 'list'], '/services'],
    [['service', 'skill', 'image-gen'], '/services/image-gen/skill'],
    [['service', 'manifest', 'image-gen'], '/services/image-gen/manifest'],
  ])(
    'reads the exact authenticated catalogue/Skill endpoint',
    async (args, path) => {
      const env = await server((request, response) => {
        expect(request.url).toBe(`/rfs/space${path}`);
        expect(request.headers.authorization).toBe('Bearer private-token');
        if (path.startsWith('/skill'))
          expect(request.headers['x-huabu-skill-client']).toBe('rfs-cli');
        response.end('raw content');
      });
      const result = await call(args, env);
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toBe('raw content');
    },
  );

  it('interrupts pending stdin before sending any mutation', async () => {
    let count = 0;
    const env = await server((_request, response) => {
      count++;
      response.end();
    });
    const controller = new AbortController();
    const stderr = output();
    const stdin = new PassThrough();
    const pending = runRfs(['execute', '--json-file', '-'], {
      env,
      stdin,
      stdout: output().stream,
      stderr: stderr.stream,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe(130);
    expect(count).toBe(0);
    expect(stdin.destroyed).toBe(true);
    expect(stderr.text()).not.toContain('Remote outcome may be unknown');
  });
  it.each(['query', 'execute'])(
    'forwards %s JSON bytes and unknown result fields without interpreting business outcomes',
    async (command) => {
      const original = ' \n{"type":"FUTURE","unknown":true}\n';
      const reply =
        '{"results":[{"applied":false,"reason":"conflict"}],"future":[1,2]}';
      const env = await server((request, response) => {
        expect(request.url).toBe(`/rfs/space/${command}`);
        expect(request.headers.authorization).toBe('Bearer private-token');
        expect(request.headers['x-huabu-host-thread-id']).toBe(
          command === 'execute' ? 'host-thread' : undefined,
        );
        void bytes(request).then((body) => {
          expect(body.toString()).toBe(original);
          response.end(reply);
        });
      });
      const result = await call(
        [command, '--json-file', '-'],
        env,
        Buffer.from(original),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toBe(reply);
    },
  );

  it.each([
    ['query', '--json', '{}', '--json-file', '-'],
    ['query', '--text', 'x'],
    ['query', '--output', 'x', '--json', '{}'],
    ['execute'],
    ['agent', 'create', '--text', 'x', '--no-start'],
    ['agent', 'create', 'extra', '--json', '{}'],
    ['agent', 'prompt', '--text', 'x'],
    ['agent', 'prompt', 't', '--text', 'x', '--no-start'],
    ['agent', 'profiles', '--json', '{}'],
    ['download', '../file', '--output', 'file'],
    ['download', 'nodes//file', '--output', 'file'],
    ['download', 'nodes/file'],
    ['upload', 'a/b', '--file', '-'],
    ['upload', 'a'],
    ['capabilities'],
    ['service', 'download', 'image-gen'],
    ['service', 'download', '../escape', '--out-folder', 'x'],
    ['query', '--help', '../TYPE'],
  ])('rejects invalid input locally: %j', async (...args) => {
    let count = 0;
    const env = await server((_request, response) => {
      count++;
      response.end();
    });
    const result = await call(args, env);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe('');
    expect(count).toBe(0);
  });

  it.each(['json', 'text', 'json-file', 'text-file'])(
    'forwards Agent %s input unchanged',
    async (source) => {
      const content = source.startsWith('json')
        ? ' \n{"prompt":"x","future":42}\n'
        : 'hello\r\nworld\n';
      const env = await server((request, response) => {
        expect(request.url).toBe('/rfs/space/agent');
        expect(request.headers['content-type']).toBe(
          source.startsWith('json') ? 'application/json' : 'text/plain',
        );
        expect(request.headers['x-huabu-host-thread-id']).toBe('host-thread');
        void bytes(request).then((body) => {
          expect(body.toString()).toBe(content);
          response.end(
            'event: error\ndata: {"message":"business failure"}\n\n',
          );
        });
      });
      const result = await call(
        [
          'agent',
          'create',
          `--${source}`,
          source.endsWith('file') ? '-' : content,
        ],
        env,
        Buffer.from(content),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toContain('event: error');
    },
  );

  it('uses JSON create-only header without rewriting body and reads actual files', async () => {
    const file = join(await directory(), 'body.json');
    const original = '{"future":1,"prompt":"Server should validate this"}\n';
    await writeFile(file, original);
    const env = await server((request, response) => {
      expect(request.headers['x-huabu-agent-start']).toBe('false');
      void bytes(request).then((body) => {
        expect(body.toString()).toBe(original);
        response.end('{"nodeId":"n"}');
      });
    });
    expect(
      (await call(['agent', 'create', '--no-start', '--json-file', file], env))
        .code,
    ).toBe(0);
  });

  it('streams raw SSE before EOF and does not require done/end events', async () => {
    let first!: () => void;
    const observed = new Promise<void>((resolve) => {
      first = resolve;
    });
    let finish!: () => void;
    const env = await server((request, response) => {
      expect(request.url).toBe('/rfs/space/agent/a%20b%252F/prompt');
      expect(request.headers['x-huabu-host-thread-id']).toBeUndefined();
      response.setHeader('content-type', 'text/event-stream');
      response.write(': heartbeat\n\nevent: custom\ndata: {"unknown":1}\n\n');
      finish = () => response.end('data: last\n\n');
    });
    const stdout = output(() => first());
    let settled = false;
    const promise = runRfs(['agent', 'prompt', 'a b%2F', '--text', 'hello'], {
      env,
      stdout: stdout.stream,
      stderr: output().stream,
    }).then((code) => {
      settled = true;
      return code;
    });
    await observed;
    expect(settled).toBe(false);
    expect(stdout.text()).toBe(
      ': heartbeat\n\nevent: custom\ndata: {"unknown":1}\n\n',
    );
    finish();
    expect(await promise).toBe(0);
    expect(stdout.text()).toContain('data: last');
  });

  it('streams binary file/stdin uploads with exactly-once encoding', async () => {
    const payload = Buffer.from([0, 255, 10, 13, 128, 42]);
    const file = join(await directory(), 'upload.bin');
    await writeFile(file, payload);
    const env = await server((request, response) => {
      expect(request.url).toBe('/rfs/space/upload/a%20%2520.bin');
      void bytes(request).then((body) => {
        expect(body).toEqual(payload);
        response.end('{"unknown":"untouched"}');
      });
    });
    for (const source of [file, '-']) {
      const result = await call(
        ['upload', '--file', source, 'a %20.bin'],
        env,
        payload,
      );
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toBe('{"unknown":"untouched"}');
    }
  });

  it('deletes a staged upload without reading a file or request body', async () => {
    const env = await server((request, response) => {
      expect(request.method).toBe('DELETE');
      expect(request.url).toBe('/rfs/space/upload/old.bin');
      void bytes(request).then((body) => {
        expect(body.length).toBe(0);
        response.end('deleted');
      });
    });
    const result = await call(['upload', '--delete', 'old.bin'], env);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe('deleted');
    for (const args of [
      ['upload', 'old.bin'],
      ['upload', '--delete', '--file', '-', 'old.bin'],
    ])
      expect((await call(args, env)).code).toBe(1);
  });

  it('streams download metadata as NDJSON, replaces only a complete file, and preserves cached output', async () => {
    const folder = await directory();
    const target = join(folder, 'body');
    const timer = setTimeout(() => {}, 60_000);
    timer.unref();
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      callback();
      return timer;
    });
    await writeFile(target, 'old');
    const env = await server((request, response) => {
      expect(request.url).toBe('/rfs/space/download/nodes/a%20%2520.md');
      response.setHeader('etag', '"revision"');
      response.setHeader('x-huabu-node-id', 'node-1');
      response.setHeader('x-huabu-node-type', 'note');
      response.setHeader('x-huabu-node-label', 'My%20note');
      response.setHeader(
        'x-huabu-node-edges',
        '{"parents":["frame-1"],"children":[]}',
      );
      response.setHeader('content-type', 'application/octet-stream');
      if (request.headers['if-none-match'] === '"revision"') {
        response.writeHead(304);
        response.end();
      } else {
        response.setHeader('x-huabu-basis', 'b1.read');
        response.setHeader('content-length', '3');
        response.end(Buffer.from([0, 255, 10]));
      }
    });
    const args = ['download', 'nodes/a %20.md', '--output', target];
    const downloaded = await call(args, env);
    expect(downloaded.code).toBe(0);
    expect(await readFile(target)).toEqual(Buffer.from([0, 255, 10]));
    expect(
      downloaded.stdout
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        event: 'download_started',
        output: target,
        size: 3,
        revision: 'revision',
        basis: 'b1.read',
        contentType: 'application/octet-stream',
        node: {
          id: 'node-1',
          type: 'note',
          label: 'My note',
          edges: { parents: ['frame-1'], children: [] },
        },
      },
      {
        event: 'download_progress',
        output: target,
        received: 0,
        size: 3,
      },
      {
        event: 'download_completed',
        output: target,
        received: 3,
        size: 3,
        revision: 'revision',
        basis: 'b1.read',
        contentType: 'application/octet-stream',
        node: {
          id: 'node-1',
          type: 'note',
          label: 'My note',
          edges: { parents: ['frame-1'], children: [] },
        },
      },
    ]);
    const cached = await call([...args, '--if-revision', 'revision'], env);
    expect(cached.code).toBe(0);
    expect(await readFile(target)).toEqual(Buffer.from([0, 255, 10]));
    expect(JSON.parse(cached.stdout.toString())).toEqual({
      event: 'not_modified',
      output: target,
      revision: 'revision',
      contentType: 'application/octet-stream',
      node: {
        id: 'node-1',
        type: 'note',
        label: 'My note',
        edges: { parents: ['frame-1'], children: [] },
      },
    });
    expect(await readdir(folder)).toEqual(['body']);
  });

  it('announces a download before body completion and preserves the target on failure', async () => {
    const folder = await directory();
    const target = join(folder, 'body');
    await writeFile(target, 'old');
    let finish!: () => void;
    const observed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const env = await server((_request, response) => {
      response.setHeader('content-length', '100');
      response.flushHeaders();
      void observed.then(() => {
        response.write('partial');
        response.destroy();
      });
    });
    const args = ['download', 'nodes/a', '--output', target];
    const stdout = output();
    const pending = runRfs(args, {
      env,
      stdout: stdout.stream,
      stderr: output().stream,
    });
    await vi.waitFor(() =>
      expect(stdout.text()).toContain('"event":"download_started"'),
    );
    expect(await readFile(target, 'utf8')).toBe('old');
    finish();
    expect(await pending).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(stdout.text()).not.toContain('"event":"download_completed"');
    expect(await readdir(folder)).toEqual(['body']);
  });

  it('keeps download error bodies off stdout and adapts the recovery command', async () => {
    const folder = await directory();
    const target = join(folder, 'body');
    await writeFile(target, 'old');
    const env = await server((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          message:
            'Denied. To see how to use this Space, run: curl -fsS "$HUABU_RFS_URL/skill"',
        }),
      );
    });
    const result = await call(['download', 'nodes/a', '--output', target], env);
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toContain('huabu-rfs get-skill');
    expect(result.stderr).not.toContain('HUABU_RFS_URL');
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(folder)).toEqual(['body']);
  });

  it('does not follow redirects or forward credentials to another server', async () => {
    let redirected = 0;
    const target = await server((_request, response) => {
      redirected++;
      response.end('bad');
    });
    const env = await server((_request, response) => {
      response.writeHead(302, { location: target.HUABU_RFS_URL });
      response.end('redirect body');
    });
    const result = await call(['get-skill'], env);
    expect(result.code).toBe(1);
    expect(result.stdout.toString()).toBe('redirect body');
    expect(redirected).toBe(0);
  });

  it.each([
    [['query', '--help'], undefined, '/capabilities'],
    [['query', '--help', 'QUERY'], undefined, '/capabilities/queries/QUERY'],
    [['execute', '--help', 'CMD'], undefined, '/capabilities/commands/CMD'],
    [['agent', '--help'], '/skill/agents', undefined],
    [['agent', 'prompt', '--help'], '/skill/agents', undefined],
    [['service', '--help'], '/skill/services', undefined],
    [['download', '--help'], undefined, undefined],
    [['get-skill', '--help'], undefined, undefined],
  ])(
    'combines local/live help at the exact endpoint',
    async (args, guide, capability) => {
      const requests: string[] = [];
      const env = await server((request, response) => {
        requests.push(request.url ?? '');
        if (request.url?.includes('/skill/'))
          expect(request.headers['x-huabu-skill-client']).toBe('rfs-cli');
        response.end('live contract');
      });
      const result = await call(args, env);
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toContain('Usage: huabu-rfs');
      expect(requests).toEqual([
        ...(guide ? [`/rfs/space${guide}`] : []),
        ...(capability ? [`/rfs/space${capability}`] : []),
      ]);
      if (guide)
        expect(result.stdout.toString()).toContain('Live Skill\nlive contract');
      if (capability)
        expect(result.stdout.toString()).toContain(
          'Live operation contract\nlive contract',
        );
      if (capability)
        expect(result.stdout.toString()).not.toContain('/capabilities');
    },
  );

  it.each([['get-skill'], ['--help'], []])(
    'loads Space-aware root context and generated usage in one call: %j',
    async (...args) => {
      const env = await server((request, response) => {
        expect(request.url).toBe('/rfs/space/skill');
        expect(request.headers['x-huabu-skill-client']).toBe('rfs-cli');
        response.end(
          '# Space Override\n\n# Space-specific Skills\nUse team glossary.',
        );
      });
      const result = await call(args, env);
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toContain('Usage: huabu-rfs');
      expect(result.stdout.toString()).toContain('service');
      expect(result.stdout.toString()).toContain('# Space Override');
      expect(result.stdout.toString()).toContain('Use team glossary.');
      expect(result.stdout.toString()).not.toContain('HUABU_RFS_URL');
      expect(result.stdout.toString()).not.toContain('AGENTLET_TOKEN');
    },
  );

  it('does not turn a failed root Skill request into successful local help', async () => {
    const env = await server((_request, response) => {
      response.writeHead(401);
      response.end('authentication failed');
    });
    const result = await call(['get-skill'], env);
    expect(result.code).toBe(1);
    expect(result.stdout.toString()).toBe('authentication failed');
  });

  it('adapts Server recovery guidance to the CLI without exposing connection environment', async () => {
    const env = await server((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          message:
            'Invalid query. To see how to use this Space, run: curl -fsS "$HUABU_RFS_URL/skill"',
        }),
      );
    });
    const result = await call(['query', '--json', '{}'], env);
    expect(result.code).toBe(1);
    expect(result.stdout.toString()).toContain('huabu-rfs get-skill');
    expect(result.stdout.toString()).not.toContain('HUABU_RFS_URL');
  });

  it('downloads a complete Service into FOLDER/ID without leasing or executing it', async () => {
    const folder = await directory();
    const archive = zip([
      { name: 'image-gen/service.yaml', data: 'id: image-gen' },
      { name: 'image-gen/SKILL.md', data: '# Package Skill' },
      {
        name: 'image-gen/docs/entry.mjs',
        data: 'throw new Error("never execute");',
      },
    ]);
    const env = await server((request, response) => {
      expect(request.url).toBe('/rfs/space/download/services/image-gen.zip');
      expect(request.headers.authorization).toBe('Bearer private-token');
      response.end(archive);
    });
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe(`${join(folder, 'image-gen')}\n`);
    expect(await readFile(join(folder, 'image-gen', 'SKILL.md'), 'utf8')).toBe(
      '# Package Skill',
    );
    expect(
      await readFile(join(folder, 'image-gen', 'docs', 'entry.mjs'), 'utf8'),
    ).toContain('never execute');
    expect(await readdir(folder)).toEqual(['image-gen']);
    const repeat = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(repeat.code).toBe(1);
    expect(repeat.stderr).toContain('Refusing to overwrite');
    expect(await readdir(folder)).toEqual(['image-gen']);
  });

  it.each([
    [{ name: 'image-gen/../escape', data: 'bad' }],
    [{ name: 'image-gen/NUL.txt', data: 'bad' }],
    [{ name: 'image-gen/name.', data: 'bad' }],
    [
      { name: 'image-gen/A/one', data: 'a' },
      { name: 'image-gen/a/two', data: 'b' },
    ],
    [{ name: 'wrong/SKILL.md', data: 'bad' }],
    [
      {
        name: 'image-gen/link',
        attributes: (0xa000 << 16) >>> 0,
        data: 'outside',
      },
    ],
    [
      { name: 'image-gen/SKILL.md', data: 'a' },
      { name: 'image-gen/skill.md', data: 'b' },
    ],
    [{ name: 'image-gen/SKILL.md', data: 'bad', checksum: 123 }],
    [{ name: 'image-gen/only.txt', data: 'no manifest or Skill' }],
  ])(
    'rejects unsafe/incomplete Service archives and cleans staging: %j',
    async (...entries) => {
      const folder = await directory();
      const archive = zip(entries);
      const env = await server((_request, response) => response.end(archive));
      const result = await call(
        ['service', 'download', 'image-gen', '--out-folder', folder],
        env,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).not.toBe('');
      expect(result.stdout.length).toBe(0);
      expect(await readdir(folder)).toEqual([]);
    },
  );

  it('keeps Service HTTP errors on stdout without creating a target', async () => {
    const folder = await directory();
    const env = await server((_request, response) => {
      response.writeHead(403);
      response.end('not Agent-facing');
    });
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stdout.toString()).toBe('not Agent-facing');
    expect(await readdir(folder)).toEqual([]);
  });

  it('enforces the actual Service compressed-byte limit and removes staging', async () => {
    const folder = await directory();
    const env = await server((_request, response) =>
      response.end(Buffer.alloc(64 * 1024 * 1024 + 1)),
    );
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('exceeds download size limit');
    expect(await readdir(folder)).toEqual([]);
  });

  it('enforces the declared expanded-byte limit before decompression', async () => {
    const folder = await directory();
    const archive = zip([
      {
        name: 'image-gen/large',
        data: 'x',
        method: 8,
        expanded: 128 * 1024 * 1024 + 1,
      },
    ]);
    const env = await server((_request, response) => response.end(archive));
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('exceeds extraction size limit');
    expect(await readdir(folder)).toEqual([]);
  });

  it('excludes concurrent same-ID downloads without removing another invocation lock', async () => {
    const folder = await directory();
    const archive = zip([
      { name: 'image-gen/service.yaml', data: 'id: image-gen' },
      { name: 'image-gen/SKILL.md', data: '# Skill' },
    ]);
    let firstResponse: ServerResponse | undefined;
    const env = await server((_request, response) => {
      if (!firstResponse) {
        firstResponse = response;
        response.writeHead(200);
        response.flushHeaders();
      } else response.end(archive);
    });
    const args = ['service', 'download', 'image-gen', '--out-folder', folder];
    const first = call(args, env);
    await expect
      .poll(() => readdir(folder))
      .toContain('.huabu-rfs-image-gen.lock');
    const second = await call(args, env);
    expect(second.code).toBe(1);
    expect(await readdir(folder)).toContain('.huabu-rfs-image-gen.lock');
    if (!firstResponse) throw new Error('Expected first transfer');
    firstResponse.end(archive);
    expect((await first).code).toBe(0);
    expect(await readdir(folder)).toEqual(['image-gen']);
  });

  it('cleans a locally interrupted Service transfer without publishing a directory', async () => {
    const folder = await directory();
    const controller = new AbortController();
    const env = await server((_request, response) => {
      response.writeHead(200);
      response.write('incomplete ZIP');
    });
    const pending = call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
      Buffer.alloc(0),
      { signal: controller.signal },
    );
    await expect
      .poll(() => readdir(folder))
      .toContain('.huabu-rfs-image-gen.lock');
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.stderr).not.toContain('Remote outcome may be unknown');
    expect(await readdir(folder)).toEqual([]);
  });

  it('rejects more than 4096 archive entries and cleans all staged directories', async () => {
    const folder = await directory();
    const archive = zip([
      { name: 'image-gen/' },
      ...Array.from({ length: 4096 }, (_, index) => ({
        name: `image-gen/dir${index}/`,
      })),
    ]);
    const env = await server((_request, response) => response.end(archive));
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('too many entries');
    expect(await readdir(folder)).toEqual([]);
  });

  it('cleans staging after a truncated Service transfer', async () => {
    const folder = await directory();
    const env = await server((_request, response) => {
      response.setHeader('content-length', '100');
      response.write('partial ZIP');
      setTimeout(() => response.destroy(), 10);
    });

    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(await readdir(folder)).toEqual([]);
  });

  it('bounds implicit directories as well as archive entries', async () => {
    const folder = await directory();
    const archive = zip(
      Array.from({ length: 2048 }, (_, index) => ({
        name: `image-gen/dir${index}/file`,
        data: '',
      })),
    );
    const env = await server((_request, response) => response.end(archive));
    const result = await call(
      ['service', 'download', 'image-gen', '--out-folder', folder],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('too many filesystem paths');
    expect(await readdir(folder)).toEqual([]);
  });

  it('marks absent/auth-failed/timed-out live help without changing help exit status', async () => {
    let stall = false;
    const env = await server((_request, response) => {
      if (!stall) {
        response.writeHead(401);
        response.end('denied');
      }
    });
    for (const current of [{}, env]) {
      const result = await call(['--help'], current);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Live Server contract unavailable');
      expect(result.stdout.toString()).not.toContain('denied');
    }
    stall = true;
    const result = await call(['--help'], env, Buffer.alloc(0), {
      helpTimeoutMs: 20,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Live Server contract unavailable');
  });

  it('rejects unsafe header/env and missing input files before issuing requests', async () => {
    let count = 0;
    const env = await server((_request, response) => {
      count++;
      response.end();
    });
    for (const changed of [
      { ...env, HUABU_THREAD_ID: 'unsafe\r\nheader' },
      { ...env, AGENTLET_TOKEN: 'private\nsecret' },
      { ...env, HUABU_RFS_URL: 'ftp://example.test' },
    ])
      expect((await call(['execute', '--json', '{}'], changed)).code).toBe(1);
    expect(
      (
        await call(
          ['upload', 'x', '--file', '/nonexistent-huabu-rfs-file'],
          env,
        )
      ).code,
    ).toBe(1);
    expect(count).toBe(0);
  });

  it('warns for absent correlation but continues, and reports ambiguous network mutations', async () => {
    const env = await server((_request, response) => {
      response.end('okay');
    });
    delete (env as NodeJS.ProcessEnv).HUABU_THREAD_ID;
    const result = await call(['execute', '--json', '{}'], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('proceeding without host-thread');
    const dropped = await server((request) => {
      request.socket.destroy();
    });
    const unknown = await call(
      ['execute', '--json', '{}'],
      dropped,
      undefined,
      { executeRetry: { backoffMs: [1] } },
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Remote outcome may be unknown');
    expect(unknown.stderr).not.toContain('private-token');
  });

  describe('execute request ids', () => {
    const UUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const OPERATION = '11111111-1111-4111-8111-111111111111';
    const fast = { executeRetry: { backoffMs: [1] } };
    /** Record what each attempt sent, then let the test answer it. */
    async function recorder(
      answer: (
        attempt: number,
        request: IncomingMessage,
        response: ServerResponse,
      ) => void,
    ) {
      const seen: { id: string | undefined; basis: unknown; body: string }[] =
        [];
      const env = await server(async (request, response) => {
        expect(request.url).toBe('/rfs/space/execute');
        seen.push({
          id: request.headers['x-huabu-operation-id'] as string | undefined,
          basis: request.headers['x-huabu-basis'],
          body: (await bytes(request)).toString(),
        });
        answer(seen.length, request, response);
      });
      return { env, seen };
    }
    const echo = (request: IncomingMessage, response: ServerResponse) =>
      response.end(
        JSON.stringify({
          canvasId: 'space',
          operationId: request.headers['x-huabu-operation-id'],
          basis: 'b1.next',
          results: [],
        }),
      );

    it('adds a fresh request id per invocation and prints it with the basis, body untouched', async () => {
      const { env, seen } = await recorder((_attempt, request, response) =>
        echo(request, response),
      );
      const body = '{ "commands": [ ] }';
      const first = await call(['execute', '--json', body], env);
      const second = await call(['execute', '--json', body], env);
      expect(first.code).toBe(0);
      expect(seen).toHaveLength(2);
      expect(seen[0]?.id).toMatch(UUID);
      expect(seen[1]?.id).toMatch(UUID);
      expect(seen[0]?.id).not.toBe(seen[1]?.id);
      expect(seen[0]?.body).toBe(body);
      expect(seen[0]?.basis).toBeUndefined();
      // stdout stays the raw response, which names the effective id and basis.
      expect(JSON.parse(first.stdout.toString())).toEqual({
        canvasId: 'space',
        operationId: seen[0]?.id,
        basis: 'b1.next',
        results: [],
      });
      expect(first.stderr).toBe('');
      expect(JSON.parse(second.stdout.toString()).operationId).toBe(
        seen[1]?.id,
      );
    });

    it('forwards --operation-id and --basis, and keeps a request id the body names', async () => {
      const { env, seen } = await recorder((_attempt, request, response) =>
        echo(request, response),
      );
      const flagged = await call(
        [
          'execute',
          '--json',
          '{"commands":[]}',
          '--operation-id',
          OPERATION.toUpperCase(),
          '--basis',
          'b1.read',
        ],
        env,
      );
      expect(flagged.code).toBe(0);
      expect(seen[0]).toEqual({
        id: OPERATION,
        basis: 'b1.read',
        body: '{"commands":[]}',
      });

      const inBody = `{"operationId":"${OPERATION}","commands":[]}`;
      await call(['execute', '--json', inBody], env);
      expect(seen[1]).toEqual({
        id: undefined,
        basis: undefined,
        body: inBody,
      });

      const invalid = await call(
        ['execute', '--json', '{}', '--operation-id', 'nope'],
        env,
      );
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('--operation-id must be a UUID');
      expect(invalid.stderr).not.toContain('operation-id=');
      expect(seen).toHaveLength(2);
    });

    it('retries a dropped connection and an unknown outcome with the same id and body', async () => {
      const { env, seen } = await recorder((attempt, request, response) => {
        if (attempt === 1) request.socket.destroy();
        else if (attempt === 2)
          response
            .writeHead(503, { 'Content-Type': 'application/json' })
            .end('{"code":"operation-outcome-unknown","message":"unknown"}');
        else echo(request, response);
      });
      const body = '{"commands":[{"type":"CREATE_NODES"}]}';
      const result = await call(
        ['execute', '--json-file', '-'],
        env,
        Buffer.from(body),
        fast,
      );
      expect(result.code).toBe(0);
      expect(seen).toHaveLength(3);
      expect(seen[0]?.id).toMatch(UUID);
      expect(new Set(seen.map((attempt) => attempt.id)).size).toBe(1);
      expect(seen.map((attempt) => attempt.body)).toEqual([body, body, body]);
      // Only the final answer reaches stdout.
      expect(JSON.parse(result.stdout.toString()).operationId).toBe(
        seen[0]?.id,
      );
      expect(result.stderr).toContain('retrying with the same operation id');
      expect(result.stderr).not.toContain('operation-id=');
    });

    it('retries an attempt that gets no response in time', async () => {
      const { env, seen } = await recorder((attempt, request, response) => {
        if (attempt > 1) echo(request, response);
      });
      const result = await call(['execute', '--json', '{}'], env, undefined, {
        executeRetry: { backoffMs: [1], attemptTimeoutMs: 100 },
      });
      expect(result.code).toBe(0);
      expect(seen).toHaveLength(2);
      expect(seen[0]?.id).toBe(seen[1]?.id);
      expect(result.stderr).toContain('no response in time');
    });

    it.each([400, 409, 422])(
      'does not retry a %i rejection',
      async (status) => {
        const { env, seen } = await recorder((_attempt, _request, response) =>
          response
            .writeHead(status)
            .end('{"code":"operation-id-reused","message":"no"}'),
        );
        const result = await call(
          ['execute', '--json', '{}'],
          env,
          undefined,
          fast,
        );
        expect(result.code).toBe(1);
        expect(seen).toHaveLength(1);
        expect(result.stdout.toString()).toContain('operation-id-reused');
        expect(result.stderr).toContain(`status ${status}`);
        expect(result.stderr).not.toContain('operation-id=');
      },
    );

    it('does not retry a 503 that is not an unknown outcome', async () => {
      const { env, seen } = await recorder((_attempt, _request, response) =>
        response.writeHead(503).end('busy'),
      );
      const result = await call(
        ['execute', '--json', '{}'],
        env,
        undefined,
        fast,
      );
      expect(result.code).toBe(1);
      expect(seen).toHaveLength(1);
      expect(result.stderr).toContain(`operation-id=${seen[0]?.id}`);
    });

    it('gives up after four attempts and prints the request id with the error', async () => {
      const { env, seen } = await recorder((_attempt, request) =>
        request.socket.destroy(),
      );
      const result = await call(
        ['execute', '--json', '{}', '--operation-id', OPERATION],
        env,
        undefined,
        fast,
      );
      expect(result.code).toBe(1);
      expect(seen).toHaveLength(4);
      expect(seen.every((attempt) => attempt.id === OPERATION)).toBe(true);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr).toContain('Request failed after 4 attempts');
      expect(result.stderr).toContain(`huabu-rfs: operation-id=${OPERATION}\n`);
      expect(result.stderr).toContain(`--operation-id ${OPERATION}`);

      const unknown = await recorder((_attempt, _request, response) =>
        response
          .writeHead(503)
          .end('{"code":"operation-outcome-unknown","message":"unknown"}'),
      );
      const exhausted = await call(
        ['execute', '--json', '{}'],
        unknown.env,
        undefined,
        fast,
      );
      expect(exhausted.code).toBe(1);
      expect(unknown.seen).toHaveLength(4);
      expect(exhausted.stdout.toString()).toContain(
        'operation-outcome-unknown',
      );
      expect(exhausted.stderr).toContain(`operation-id=${unknown.seen[0]?.id}`);
    });

    it('stops within the time budget and never retries a local interrupt', async () => {
      const slow = await recorder(() => {});
      const bounded = await call(
        ['execute', '--json', '{}'],
        slow.env,
        undefined,
        {
          executeRetry: { backoffMs: [1], attemptTimeoutMs: 80, budgetMs: 150 },
        },
      );
      expect(bounded.code).toBe(1);
      expect(slow.seen.length).toBeGreaterThanOrEqual(1);
      expect(slow.seen.length).toBeLessThan(4);
      expect(bounded.stderr).toContain(`operation-id=${slow.seen[0]?.id}`);

      const controller = new AbortController();
      const hanging = await recorder(() => controller.abort());
      const interrupted = await call(
        ['execute', '--json', '{}'],
        hanging.env,
        undefined,
        { ...fast, signal: controller.signal },
      );
      expect(interrupted.code).toBe(130);
      expect(hanging.seen).toHaveLength(1);
      expect(interrupted.stderr).toContain('Local delivery interrupted');
      expect(interrupted.stderr).toContain(
        `operation-id=${hanging.seen[0]?.id}`,
      );
    });

    it('reads a stored result by request id without executing', async () => {
      const env = await server((request, response) => {
        expect(request.method).toBe('GET');
        if (request.url === `/rfs/space/execute/${OPERATION}`)
          response.end('{"operationId":"stored","replayed":true}');
        else response.writeHead(404).end('{"code":"operation_not_found"}');
      });
      const found = await call(['result', OPERATION.toUpperCase()], env);
      expect(found.code).toBe(0);
      expect(found.stdout.toString()).toBe(
        '{"operationId":"stored","replayed":true}',
      );
      const missing = await call(
        ['result', '22222222-2222-4222-8222-222222222222'],
        env,
      );
      expect(missing.code).toBe(1);
      expect(missing.stdout.toString()).toContain('operation_not_found');
      const invalid = await call(['result', '../skill'], env);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('Operation id must be a UUID');
    });
  });

  it('aborts local SSE delivery without pretending to cancel remote work', async () => {
    let first!: () => void;
    const observed = new Promise<void>((resolve) => {
      first = resolve;
    });
    const env = await server((_request, response) => {
      response.write(': running\n\n');
    });
    const controller = new AbortController();
    const stdout = output(() => first());
    const stderr = output();
    const pending = runRfs(['agent', 'prompt', 't', '--text', 'hello'], {
      env,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: controller.signal,
    });
    await observed;
    controller.abort();
    expect(await pending).toBe(130);
    expect(stderr.text()).toContain('does not cancel remote work');
    expect(stderr.text()).toContain('Remote outcome may be unknown');
  });
});
