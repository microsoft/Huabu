/**
 * Remote File System (RFS) API routes — `/api/rfs/:canvasId/*`.
 *
 * The curl-native reachback surface for external agents (replaces the v1
 * node-CRUD `.mjs` reachback tool). Four endpoints, all Bearer-gated by the
 * global auth hook in `app.ts`:
 *
 * - `GET    download/<path>` — fetch a canvas file as raw bytes. Node files
 *   also carry their metadata (id/type/label/src/locked + parent/child edges)
 *   in ASCII-safe `X-Huabu-*` response headers.
 * - `POST   upload/<file>`   — stage bytes into the shared `.upload/` scratch
 *   dir (rejects on collision — the agent self-suffixes).
 * - `DELETE upload/<file>`   — remove a staged payload.
 * - `POST   agent`           — talk to the canvas-internal agent; always
 *   streams `text/event-stream` (heartbeats + plain-text answer frames).
 * - `GET    skill`           — pull the canvas-access guide (per-canvas
 *   override → bundled default).
 *
 * Errors keep the repo-standard `{ message }` shape and, on `4xx`/`5xx`, fold
 * a runnable `/skill` recovery command into the message (self-healing pull).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RFS_HEARTBEAT_DEFAULT_SEC,
  RFS_HEARTBEAT_MAX_SEC,
  RFS_HEARTBEAT_MIN_SEC,
  createId,
  rfsAgentRequestSchema,
  type RfsUploadResponse,
} from '@sediment/shared';

import { mimeForPath } from './mime.js';
import {
  lookupNodeByPath,
  resolveReadable,
  rfsMetaHeaders,
} from './node-meta.js';
import { resolveCanvasSkill } from './skill.js';
import { loadAgent } from '../../prompt/index.js';
import { runAgent, type StreamEvent } from '../agent/agent.service.js';
import { isPromptDebugEnabled } from '../agent/conversation/prompt/debug-prompt.js';
import { safeResolve } from '../agent/tools/handlers/fs-sandbox.js';

import type { Context, UserMessage } from '@earendil-works/pi-ai';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// ── Error helper: fold a runnable /skill recovery command into { message } ──

/**
 * Build the repo-standard error body. On any RFS failure the message embeds a
 * copy-pasteable command that fetches the full access guide, so an agent that
 * skipped the bootstrap or mis-formed a request is handed the fix on its first
 * fumble. `$HUABU_RFS_URL` / `$AGENTLET_TOKEN` are the agent's own env vars.
 */
function rfsError(reason: string): { message: string } {
  return {
    message:
      `${reason} To see how to use this Space, run: ` +
      `curl -sH "Authorization: Bearer $AGENTLET_TOKEN" "$HUABU_RFS_URL/skill"`,
  };
}

/**
 * Whether a request's `If-None-Match` matches the current `etag`, i.e. the
 * conditional GET should short-circuit to `304 Not Modified`. Accepts `*`
 * (match anything) or a comma-separated list of quoted ETags; a leading `W/`
 * weak-validator prefix is stripped before comparison. Node revisions are
 * strong, exact tokens, so a plain equality over the unwrapped value suffices.
 */
function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const unwrap = (s: string): string => s.trim().replace(/^W\//, '');
  const target = unwrap(etag);
  return raw
    .split(',')
    .map(unwrap)
    .some((candidate) => candidate === '*' || candidate === target);
}

// ── SSE helpers ──

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Emit plain text as one-or-more `data:` frames (one per line) followed by the
 * frame terminator. A consumer recovers the text verbatim with
 * `sed -n 's/^data: //p'`; `:` heartbeat comments are ignored by that filter.
 */
function writeDataText(raw: NodeJS.WritableStream, text: string): void {
  for (const line of text.split(/\r?\n/)) raw.write(`data: ${line}\n`);
  raw.write('\n');
}

/** Clamp a caller-supplied heartbeat cadence into the allowed range. */
function clampHeartbeatSec(sec: number | undefined): number {
  if (sec === undefined) return RFS_HEARTBEAT_DEFAULT_SEC;
  return Math.min(RFS_HEARTBEAT_MAX_SEC, Math.max(RFS_HEARTBEAT_MIN_SEC, sec));
}

// ── Reachback ask-agent debug logging (gated by HUABU_DEBUG_PROMPT) ──

/** Truncate a value to keep a single debug log line readable. */
function truncForLog(text: string, max = 500): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/**
 * Trace one reachback agent event to `server.log`. Covers the pieces useful
 * for post-mortem — which tool ran with what args, its success/failure and
 * result, and the final answer / error — while skipping the high-frequency
 * per-token `text_delta` / `thinking_delta` events. No-op unless the caller
 * has already checked {@link isPromptDebugEnabled}.
 */
function logReachbackEvent(
  request: FastifyRequest,
  threadId: string,
  event: StreamEvent,
): void {
  const tag = `[reachback ${threadId}]`;
  switch (event.type) {
    case 'tool_call':
      request.log.info(
        `${tag} → tool ${event.data.internalToolName} ${truncForLog(
          JSON.stringify(event.data.rawInput ?? {}),
        )}`,
      );
      break;
    case 'tool_call_update':
      request.log.info(
        `${tag} ← tool ${event.data.status} ${truncForLog(
          String(event.data.rawOutput ?? ''),
        )}`,
      );
      break;
    case 'done':
      request.log.info(`${tag} done: ${truncForLog(event.data.message)}`);
      break;
    case 'error':
      request.log.warn(`${tag} error: ${truncForLog(event.data.error)}`);
      break;
    default:
      break;
  }
}

// ── Route plugin ──

const rfsRoutes: FastifyPluginAsync = async (app) => {
  // Consume every request body as raw bytes within this plugin: uploads are
  // arbitrary binary, and the `agent` endpoint accepts either a JSON body or a
  // raw text prompt. Handlers interpret the Buffer per Content-Type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // ── GET /:canvasId/skill ──
  app.get<{ Params: { canvasId: string } }>(
    '/:canvasId/skill',
    async (request, reply) => {
      const { canvasId } = request.params;
      try {
        const guide = resolveCanvasSkill(canvasId);
        return reply
          .header('Content-Type', 'text/markdown; charset=utf-8')
          .send(guide);
      } catch (err) {
        request.log.error({ err, canvasId }, 'rfs skill resolve failed');
        return reply
          .code(500)
          .send(rfsError('Failed to load the canvas access guide.'));
      }
    },
  );

  // ── GET /:canvasId/download/* ──
  app.get<{ Params: { canvasId: string; '*': string } }>(
    '/:canvasId/download/*',
    async (request, reply) => {
      const { canvasId } = request.params;
      const requestRel = request.params['*'];
      if (!requestRel) {
        return reply
          .code(400)
          .send(rfsError('A download path is required (download/<path>).'));
      }

      let absPath: string;
      let physicalRel: string;
      try {
        ({ absPath, physicalRel } = resolveReadable(canvasId, requestRel));
      } catch {
        return reply
          .code(400)
          .send(rfsError(`Path "${requestRel}" is not readable.`));
      }

      if (!existsSync(absPath) || !statSync(absPath).isFile()) {
        return reply.code(404).send(rfsError(`No file at "${requestRel}".`));
      }

      const lookup = lookupNodeByPath(canvasId, physicalRel);

      // Node files carry a revision ETag (hash of authored content) so an
      // agent can conditional-GET: an unchanged node returns `304` and the
      // agent reuses its cached copy instead of re-reading. Non-node files
      // Non-node files have no node revision and are served
      // unconditionally.
      if (lookup?.meta.rev) {
        const etag = `"${lookup.meta.rev}"`;
        reply.header('ETag', etag);
        if (ifNoneMatchSatisfied(request.headers['if-none-match'], etag)) {
          return reply.code(304).send();
        }
      }

      // Raw bytes (+ X-Huabu-* headers for node files).
      if (lookup) reply.headers(rfsMetaHeaders(lookup));
      return reply
        .header('Content-Type', mimeForPath(absPath))
        .send(createReadStream(absPath));
    },
  );

  // ── POST /:canvasId/upload/* ──
  app.post<{ Params: { canvasId: string; '*': string } }>(
    '/:canvasId/upload/*',
    async (request, reply) => {
      const { canvasId } = request.params;
      const filename = request.params['*'];
      if (!filename) {
        return reply
          .code(400)
          .send(rfsError('An upload filename is required (upload/<file>).'));
      }

      let absPath: string;
      try {
        absPath = safeResolve(canvasId, path.join('.upload', filename));
      } catch {
        return reply
          .code(400)
          .send(rfsError(`Upload path "${filename}" is not allowed.`));
      }

      if (existsSync(absPath)) {
        return reply
          .code(409)
          .send(
            rfsError(
              `A file already named "upload/${filename}" exists; ` +
                `choose a different name (overwrite is not allowed).`,
            ),
          );
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply
          .code(400)
          .send(rfsError('Upload body must be the raw file bytes.'));
      }

      try {
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, body);
      } catch (err) {
        request.log.error({ err, canvasId, filename }, 'rfs upload failed');
        return reply
          .code(500)
          .send(rfsError(`Failed to store "upload/${filename}".`));
      }

      const payload: RfsUploadResponse = {
        path: `upload/${filename}`,
        size: body.length,
      };
      return reply.code(201).send(payload);
    },
  );

  // ── DELETE /:canvasId/upload/* ──
  app.delete<{ Params: { canvasId: string; '*': string } }>(
    '/:canvasId/upload/*',
    async (request, reply) => {
      const { canvasId } = request.params;
      const filename = request.params['*'];
      if (!filename) {
        return reply
          .code(400)
          .send(rfsError('An upload filename is required (upload/<file>).'));
      }

      let absPath: string;
      try {
        absPath = safeResolve(canvasId, path.join('.upload', filename));
      } catch {
        return reply
          .code(400)
          .send(rfsError(`Upload path "${filename}" is not allowed.`));
      }

      if (!existsSync(absPath)) {
        return reply
          .code(404)
          .send(rfsError(`No staged file at "upload/${filename}".`));
      }
      await rm(absPath, { force: true });
      return reply.code(204).send();
    },
  );

  // ── POST /:canvasId/agent ── (always SSE)
  app.post<{ Params: { canvasId: string } }>(
    '/:canvasId/agent',
    async (request, reply) => {
      const { canvasId } = request.params;

      // Body: JSON `{prompt, doneTextOnly?, heartbeatSec?}` or a raw text prompt.
      const body = request.body;
      const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      const contentType = request.headers['content-type'] ?? '';

      let prompt: string;
      let doneTextOnly = true;
      let heartbeatSec: number | undefined;

      if (contentType.includes('application/json')) {
        let json: unknown;
        try {
          json = JSON.parse(buf.toString('utf8') || '{}');
        } catch {
          return reply
            .code(400)
            .send(rfsError('Request body is not valid JSON.'));
        }
        const parsed = rfsAgentRequestSchema.safeParse(json);
        if (!parsed.success) {
          return reply.code(400).send(rfsError('Invalid agent request body.'));
        }
        prompt = parsed.data.prompt;
        if (parsed.data.doneTextOnly !== undefined) {
          doneTextOnly = parsed.data.doneTextOnly;
        }
        heartbeatSec = parsed.data.heartbeatSec;
      } else {
        prompt = buf.toString('utf8').trim();
      }

      if (!prompt) {
        return reply
          .code(400)
          .send(rfsError('A non-empty prompt is required.'));
      }

      await streamAgent(reply, request, {
        canvasId,
        prompt,
        doneTextOnly,
        heartbeatSec: clampHeartbeatSec(heartbeatSec),
      });
    },
  );
};

// ── Agent streaming ──

interface StreamAgentInput {
  canvasId: string;
  prompt: string;
  doneTextOnly: boolean;
  heartbeatSec: number;
}

async function streamAgent(
  reply: FastifyReply,
  request: FastifyRequest,
  input: StreamAgentInput,
): Promise<void> {
  const { canvasId, prompt, doneTextOnly, heartbeatSec } = input;
  const threadId = createId('reachback');
  const debug = isPromptDebugEnabled();
  const startedAt = Date.now();
  let toolCalls = 0;
  let outcome: 'ok' | 'error' | 'aborted' | 'incomplete' = 'incomplete';
  if (debug) {
    // BEGIN banner. Grep `ask-huabu` to list every round's boundaries, or
    // grep the `reachback-…` threadId (shown here) to pull one whole round.
    request.log.info(
      `[reachback ${threadId}] ┏━ ask-huabu BEGIN · canvas=${canvasId} · prompt: ${truncForLog(
        prompt,
      )}`,
    );
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    timestamp: Date.now(),
  };
  const context: Context = {
    systemPrompt: loadAgent('operate', { canvasId }).systemPrompt,
    messages: [userMessage],
    tools: [],
  };

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, SSE_HEADERS);
  raw.flushHeaders?.();
  raw.write(': ok\n\n');

  // Timer-driven heartbeats keep proxies / client timeouts at bay during a
  // long agent turn, independent of how often the agent actually emits.
  const heartbeat = setInterval(() => {
    raw.write(': ping\n\n');
  }, heartbeatSec * 1000);

  const abortController = new AbortController();
  const onClose = (): void => abortController.abort();
  request.raw.socket?.once('close', onClose);

  try {
    const stream = runAgent({
      scope: 'operate',
      canvasId,
      origin: { type: 'ai-operate' },
      context,
      logger: { info: (m: string) => request.log.info(m) },
      signal: abortController.signal,
      maxIterations: 20,
    });

    for await (const event of stream) {
      if (event.type === 'tool_call') toolCalls += 1;
      else if (event.type === 'done') outcome = 'ok';
      else if (event.type === 'error') outcome = 'error';
      if (debug) logReachbackEvent(request, threadId, event);
      if (doneTextOnly) {
        // Clean mode: only the final answer text reaches the wire, as
        // `data:` frames a `sed` one-liner can extract.
        if (event.type === 'done') writeDataText(raw, event.data.message);
      } else {
        raw.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    }
    // threadId as a comment so it never pollutes the plain-text answer.
    raw.write(`: threadId ${threadId}\n\n`);
  } catch (err: unknown) {
    outcome = 'error';
    const message = err instanceof Error ? err.message : 'Internal agent error';
    raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    request.raw.socket?.removeListener('close', onClose);
    raw.end();
    if (debug) {
      if (outcome === 'incomplete' && abortController.signal.aborted) {
        outcome = 'aborted';
      }
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      // END banner mirrors BEGIN: same `ask-huabu` token + threadId, plus
      // outcome / elapsed / tool count for quick scanning.
      request.log.info(
        `[reachback ${threadId}] ┗━ ask-huabu END · ${outcome} · ${secs}s · ${toolCalls} tools · canvas=${canvasId}`,
      );
    }
  }
}

export default rfsRoutes;
