// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { CommanderError } from 'commander';

import {
  RFS_HEADERS,
  RFS_SKILL_CLIENT_HEADER,
  agentTurnAcceptedSchema,
} from '@huabu/shared';
import { serviceParamsSchema } from '@huabu/shared/service-package';

import {
  createRfsProgram,
  segment,
  type InputOptions,
  type DownloadOptions,
  type UploadOptions,
} from './rfs-cli.js';
import { installServicePackage } from './rfs-service.js';

const SKILL_CLIENT_HEADERS = { [RFS_SKILL_CLIENT_HEADER]: 'rfs-cli' };

function header(value: string, name: string): string {
  if (!value || /[^\x20-\x7e\x80-\xff]/.test(value))
    throw new Error(`${name} is not a safe HTTP header value`);
  return value;
}
function connection(env: NodeJS.ProcessEnv) {
  const token = env.HUABU_RFS_TOKEN?.trim() || env.AGENTLET_TOKEN;
  if (!env.HUABU_RFS_URL || !token)
    throw new Error('HUABU_RFS_URL and a reachback credential are required');
  let url: URL;
  try {
    url = new URL(env.HUABU_RFS_URL);
  } catch {
    throw new Error('HUABU_RFS_URL must be an HTTP(S) base URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'HUABU_RFS_URL must be an HTTP(S) base URL without credentials, query or fragment',
    );
  return {
    base: url.href.replace(/\/+$/, ''),
    headers: {
      Authorization: header(`Bearer ${token}`, 'HUABU_RFS_TOKEN'),
    },
  };
}
async function input(
  values: InputOptions,
  stdin: Readable,
  jsonOnly: boolean,
  signal: AbortSignal,
) {
  const names = ['json', 'jsonFile', 'text', 'textFile'] as const;
  const selected = names.filter((name) => values[name] !== undefined);
  const [name] = selected;
  if (selected.length !== 1 || name === undefined)
    throw new Error(
      'Provide exactly one input: --json, --json-file, --text or --text-file',
    );
  if (jsonOnly && !name.startsWith('json'))
    throw new Error('This command requires a JSON input source');
  const value = values[name];
  if (value === undefined) throw new Error('Input source is missing');
  const bytes = name.endsWith('File')
    ? value === '-'
      ? await collect(stdin, signal)
      : await readFile(value)
    : Buffer.from(value);
  return {
    bytes,
    contentType: name.startsWith('json') ? 'application/json' : 'text/plain',
  };
}
async function collect(stream: Readable, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    stream,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    { signal },
  );
  return Buffer.concat(chunks);
}
async function deliver(
  response: Response,
  destination: Writable,
  end: boolean,
  maximumBytes = Infinity,
  onChunk?: (received: number) => void,
) {
  async function* bytes() {
    if (!response.body) return;
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        received += result.value.byteLength;
        if (received > maximumBytes)
          throw new Error('Service archive exceeds download size limit');
        onChunk?.(received);
        yield result.value;
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  await pipeline(Readable.from(bytes()), destination, { end });
}

async function readAcceptance(response: Response, threadId: string) {
  if (
    !response.headers.get('content-type')?.includes('text/event-stream') ||
    !response.body
  ) {
    throw new Error('Expected an Agent acceptance event stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Stream ended without confirmed acceptance');
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (frame.length > 65536)
          throw new Error('Agent event exceeds size limit');
        let type = '';
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:'))
            data.push(line.slice(5).replace(/^ /, ''));
        }
        if (type === 'accepted') {
          const acceptance = agentTurnAcceptedSchema.parse(
            JSON.parse(data.join('\n')),
          );
          if (acceptance.threadId !== threadId) {
            throw new Error(
              'Acceptance Thread does not match the requested Thread',
            );
          }
          return acceptance;
        }
        if (['error', 'done', 'end'].includes(type)) {
          throw new Error(`Agent emitted ${type} before confirmed acceptance`);
        }
      }
      if (buffer.length > 65536)
        throw new Error('Agent event exceeds size limit');
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function downloadRevision(response: Response): string | undefined {
  const etag = response.headers.get('etag');
  if (!etag) return undefined;
  const strong = etag.startsWith('W/') ? etag.slice(2) : etag;
  return strong.startsWith('"') && strong.endsWith('"')
    ? strong.slice(1, -1)
    : strong;
}

function downloadMetadata(response: Response) {
  const length = response.headers.get('content-length');
  const size = length === null ? undefined : Number(length);
  const revision = downloadRevision(response);
  const contentType = response.headers.get('content-type');
  const id = response.headers.get(RFS_HEADERS.nodeId);
  const type = response.headers.get(RFS_HEADERS.nodeType);
  const label = response.headers.get(RFS_HEADERS.nodeLabel);
  const src = response.headers.get(RFS_HEADERS.src);
  const locked = response.headers.get(RFS_HEADERS.locked);
  const edges = response.headers.get(RFS_HEADERS.edges);
  const node =
    id && type
      ? {
          id,
          type,
          ...(label === null ? {} : { label: decodeURIComponent(label) }),
          ...(src === null ? {} : { src }),
          ...(locked === null ? {} : { locked: locked === 'true' }),
          ...(edges === null ? {} : { edges: JSON.parse(edges) as unknown }),
        }
      : undefined;
  return {
    ...(size !== undefined && Number.isSafeInteger(size) && size >= 0
      ? { size }
      : {}),
    ...(revision === undefined ? {} : { revision }),
    ...(contentType === null ? {} : { contentType }),
    ...(node === undefined ? {} : { node }),
  };
}

function cliErrorBody(body: string): string {
  return body
    .replace('curl -fsS "$HUABU_RFS_URL/skill"', 'huabu-rfs get-skill')
    .replace('curl -fsS \\"$HUABU_RFS_URL/skill\\"', 'huabu-rfs get-skill');
}

function streamBody(source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else if (typeof result.value === 'string')
        controller.enqueue(new Uint8Array(Buffer.from(result.value)));
      else if (result.value instanceof Uint8Array)
        controller.enqueue(new Uint8Array(result.value));
      else throw new Error('Upload input must contain bytes');
    },
    async cancel() {
      source.destroy();
      await iterator.return?.();
    },
  });
}

export interface RfsIO {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  helpTimeoutMs?: number;
}

export async function runRfs(args: string[], io: RfsIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const controller = new AbortController();
  const signal = io.signal
    ? AbortSignal.any([io.signal, controller.signal])
    : controller.signal;
  let mutation = false;
  let sent = false;
  let uploadStream: Readable | undefined;
  let temporary: string | undefined;
  const diagnostic = (message: string) =>
    stderr.write(`huabu-rfs: ${message}\n`);
  const event = (value: object) => stdout.write(`${JSON.stringify(value)}\n`);
  let code = 0;
  interface Request {
    path: string;
    method?: string;
    body?: RequestInit['body'];
    duplex?: 'half';
    headers?: Record<string, string>;
    mutation?: boolean;
    correlate?: boolean;
    download?: DownloadOptions;
    usage?: string;
    service?: { id: string; folder: string };
    acceptedThread?: string;
  }
  async function send(request: Request) {
    const config = connection(env);
    const headers: Record<string, string> = {
      ...config.headers,
      ...request.headers,
    };
    if (request.correlate) {
      if (env.HUABU_THREAD_ID !== undefined)
        headers['X-Huabu-Host-Thread-Id'] = header(
          env.HUABU_THREAD_ID,
          'HUABU_THREAD_ID',
        );
      else
        diagnostic(
          'HUABU_THREAD_ID is absent; proceeding without host-thread correlation.',
        );
    }
    mutation = request.mutation === true;
    sent = true;
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
      duplex: request.duplex,
      redirect: 'manual',
      signal: request.acceptedThread
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : signal,
    };
    const response = await fetch(`${config.base}${request.path}`, init);
    const download = request.download;
    if (download && response.status === 304) {
      event({
        event: 'not_modified',
        output: resolve(download.output),
        ...downloadMetadata(response),
      });
      return;
    }
    if (!response.ok) {
      const body = cliErrorBody(
        Buffer.from(await response.arrayBuffer()).toString(),
      );
      if (download)
        diagnostic(`Download failed (status ${response.status}): ${body}`);
      else {
        stdout.write(body);
        diagnostic(
          `Request failed (status ${response.status}); response body is on stdout.`,
        );
      }
      code = 1;
      return;
    }
    if (request.acceptedThread) {
      event(await readAcceptance(response, request.acceptedThread));
    } else if (response.ok && request.service) {
      const target = await installServicePackage(
        request.service.id,
        request.service.folder,
        (file, limit) =>
          deliver(
            response,
            createWriteStream(file, { flags: 'wx', mode: 0o600 }),
            true,
            limit,
          ),
        signal,
      );
      stdout.write(`${target}\n`);
    } else if (download) {
      const target = resolve(download.output);
      const metadata = downloadMetadata(response);
      temporary = await mkdtemp(join(dirname(target), '.huabu-rfs-'));
      let received = 0;
      event({
        event: 'download_started',
        output: target,
        ...metadata,
      });
      const progress = setInterval(() => {
        event({
          event: 'download_progress',
          output: target,
          received,
          ...('size' in metadata ? { size: metadata.size } : {}),
        });
      }, 5000);
      progress.unref();
      try {
        await deliver(
          response,
          createWriteStream(join(temporary, 'body'), { flags: 'wx' }),
          true,
          Infinity,
          (value) => {
            received = value;
          },
        );
        await rename(join(temporary, 'body'), target);
      } finally {
        clearInterval(progress);
      }
      event({
        event: 'download_completed',
        output: target,
        received,
        ...metadata,
      });
    } else {
      if (response.ok && request.usage) stdout.write(request.usage);
      await deliver(response, stdout, false);
    }
    code = 0;
  }
  async function post(
    path: string,
    options: InputOptions,
    jsonOnly: boolean,
    correlate = false,
    acceptedThread?: string,
  ) {
    const source = await input(
      options,
      stdin,
      jsonOnly || options.noStart === true,
      signal,
    );
    await send({
      path,
      method: 'POST',
      body: new Uint8Array(source.bytes),
      headers: {
        'Content-Type': source.contentType,
        ...(options.noStart ? { 'X-Huabu-Agent-Start': 'false' } : {}),
        ...(acceptedThread ? { 'X-Huabu-Event-Mode': 'all' } : {}),
      },
      mutation: path !== '/query',
      correlate,
      acceptedThread,
    });
  }
  function serviceId(id: string) {
    const parsed = serviceParamsSchema.safeParse({ serviceId: id });
    if (!parsed.success) throw new Error('Invalid Service id');
    return parsed.data.serviceId;
  }
  async function liveHelp() {
    const plan = cli.liveHelp();
    const config = (() => {
      try {
        return connection(env);
      } catch (error) {
        diagnostic(
          `Live Server contract unavailable: ${error instanceof Error ? error.message : String(error)}. Local usage only.`,
        );
        return undefined;
      }
    })();
    if (!config) return;
    const helpSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(io.helpTimeoutMs ?? 3000),
    ]);
    for (const [path, skill, label] of [
      [plan.guide, true, 'Skill'],
      [plan.capability, false, 'operation contract'],
    ] as const) {
      if (!path) continue;
      try {
        const response = await fetch(`${config.base}${path}`, {
          headers: {
            ...config.headers,
            ...(skill ? SKILL_CLIENT_HEADERS : {}),
          },
          redirect: 'manual',
          signal: helpSignal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        stdout.write(`\nLive ${label}\n${text}\n`);
      } catch (error) {
        diagnostic(
          `Live Server contract unavailable (${label}): ${error instanceof Error ? error.message : String(error)}. Live help may be incomplete; local usage remains available.`,
        );
      }
    }
  }
  const cli = createRfsProgram(
    {
      rootHelp: async () => {
        cli.program.outputHelp();
        await liveHelp();
      },
      getSkill: (id, usage) =>
        send({
          path: id ? `/skill/${segment(id)}` : '/skill',
          headers: SKILL_CLIENT_HEADERS,
          usage: id ? undefined : usage,
        }),
      query: (options) => post('/query', options, true),
      execute: (options) => post('/execute', options, true, true),
      download: async (path, options) => {
        const url = `/download/${path.split('/').map(segment).join('/')}`;
        if (!options.output) throw new Error('--output must be nonempty');
        await send({
          path: url,
          download: options,
          headers:
            options.ifRevision === undefined
              ? undefined
              : {
                  'If-None-Match': header(
                    JSON.stringify(options.ifRevision),
                    '--if-revision',
                  ),
                },
        });
      },
      upload: async (name, options: UploadOptions) => {
        const path = `/upload/${segment(name)}`;
        const selected =
          Number(options.file !== undefined) + Number(options.delete === true);
        if (selected !== 1)
          throw new Error('Provide exactly one of --file or --delete');
        if (options.delete) {
          await send({ path, method: 'DELETE', mutation: true });
          return;
        }
        const file = options.file;
        if (!file) throw new Error('Upload file path must be nonempty');
        uploadStream = file === '-' ? stdin : createReadStream(file);
        if (file !== '-') await once(uploadStream, 'open');
        await send({
          path,
          method: 'POST',
          body: streamBody(uploadStream),
          duplex: 'half',
          headers: { 'Content-Type': 'application/octet-stream' },
          mutation: true,
        });
      },
      profiles: () => send({ path: '/agent/profiles' }),
      create: (options) => post('/agent', options, false, true),
      prompt: (thread, options) =>
        post(
          `/agent/${segment(thread)}/prompt`,
          options,
          false,
          false,
          options.untilAccepted ? thread : undefined,
        ),
      services: () => send({ path: '/services' }),
      serviceSkill: (id) => send({ path: `/services/${serviceId(id)}/skill` }),
      serviceManifest: (id) =>
        send({ path: `/services/${serviceId(id)}/manifest` }),
      serviceDownload: async (id, folder) => {
        if (!folder) throw new Error('--out-folder must be nonempty');
        const validId = serviceId(id);
        await send({
          path: `/download/services/${validId}.zip`,
          service: { id: validId, folder },
        });
      },
    },
    (text) => {
      stdout.write(text);
    },
  );
  try {
    try {
      await cli.program.parseAsync(args, { from: 'user' });
    } catch (error) {
      if (
        !(error instanceof CommanderError) ||
        error.code !== 'commander.helpDisplayed'
      )
        throw error;
      await liveHelp();
    }
    return code;
  } catch (error) {
    controller.abort();
    diagnostic(
      signal.aborted && io.signal?.aborted
        ? 'Local delivery interrupted; this does not cancel remote work.'
        : error instanceof Error
          ? error.message
          : String(error),
    );
    if (mutation && sent)
      diagnostic(
        'Remote outcome may be unknown. Inspect state before any further mutation; do not blindly resend.',
      );
    return io.signal?.aborted ? 130 : 1;
  } finally {
    if (uploadStream && uploadStream !== stdin) uploadStream.destroy();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.exitCode = await runRfs(process.argv.slice(2), {
    signal: controller.signal,
  });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
