/**
 * Remote File System (RFS) API routes — `/api/rfs/:canvasId/*`.
 *
 * The curl-native reachback surface for external agents (replaces the v1
 * node-CRUD `.mjs` reachback tool). Endpoints are all Bearer-gated by the
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
 * - `GET    capabilities*`   — discover direct query/command contracts.
 * - `POST   query`           — run one bounded canonical SpaceQuery.
 * - `POST   execute`         — execute validated agent Space commands.
 *
 * Errors keep the repo-standard `{ message }` shape and, on `4xx`/`5xx`, fold
 * a runnable `/skill` recovery command into the message (self-healing pull).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_SSE_EVENTS,
  RFS_HEARTBEAT_DEFAULT_SEC,
  RFS_HEARTBEAT_MAX_SEC,
  RFS_HEARTBEAT_MIN_SEC,
  createId,
  rfsAgentHeadersSchema,
  rfsAgentRequestSchema,
  rfsExecuteHeadersSchema,
  rfsExecuteRequestSchema,
  spaceQuerySchema,
  type RfsAgentEventMode,
  type RfsUploadResponse,
} from '@sediment/shared';

import { mimeForPath } from './mime.js';
import {
  lookupNodeByPath,
  resolveReadable,
  rfsMetaHeaders,
} from './node-meta.js';
import { resolveCanvasSkill } from './skill.js';
import {
  getCommandCapability,
  getQueryCapability,
  getRfsCapabilities,
} from './space-capabilities.js';
import { executeRfsCommands } from './space-execute.js';
import { loadAgent } from '../../prompt/index.js';
import {
  agenetes,
  INTERNAL_DRIVER_KIND,
  type BuiltinHandle,
} from '../agent/agenetes/drivers.js';
import { createChatSubmission } from '../agent/agenetes/handle.js';
import { runAgent, type StreamEvent } from '../agent/agent.service.js';
import { isPromptDebugEnabled } from '../agent/conversation/prompt/debug-prompt.js';
import { safeResolve } from '../agent/tools/handlers/fs-sandbox.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import { MissingWorldPortalError } from '../canvas/canvas-command-router.js';
import { CanvasNotFoundError } from '../canvas/canvas-executor.js';
import { executeSpaceQuery, SpaceQueryError } from '../canvas/space-query.js';
import { canvasAcpNamespace } from '../storage/paths.js';

import type { ChatEnvelope } from '../agent/conversation/envelope.js';
import type { Context } from '@earendil-works/pi-ai';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// ── Error helper: fold a runnable /skill recovery command into { message } ──

/**
 * Build the repo-standard error body. On any RFS failure the message embeds a
 * copy-pasteable command that fetches the full access guide, so an agent that
 * skipped the bootstrap or mis-formed a request is handed the fix on its first
 * fumble. `$HUABU_RFS_URL` / `$AGENTLET_TOKEN` are the agent's own env vars.
 */
function rfsError(
  reason: string,
  code?: string,
): { message: string; code?: string } {
  return {
    message:
      `${reason} To see how to use this Space, run: ` +
      `curl -sH "Authorization: Bearer $AGENTLET_TOKEN" "$HUABU_RFS_URL/skill"`,
    ...(code ? { code } : {}),
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

function createRfsEnvelope(prompt: string): ChatEnvelope {
  return {
    user: { text: prompt, attachments: [] },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      selection: {
        refs: [],
        selectedIds: [],
        imageAttachments: [],
        snapshotAttachments: [],
      },
    },
  };
}

function normalizeInternalEvent(event: StreamEvent): StreamEvent {
  if (event.type !== 'tool_call') return event;
  return {
    ...event,
    data: {
      ...event.data,
      internalToolName:
        event.data.internalToolName ??
        (event.data.title && event.data.title.length > 0
          ? event.data.title
          : undefined),
    },
  };
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

  // ── Direct Space operation discovery ──
  app.get('/:canvasId/capabilities', async (_request, reply) =>
    reply.send(getRfsCapabilities()),
  );

  app.get<{ Params: { canvasId: string; type: string } }>(
    '/:canvasId/capabilities/queries/:type',
    async (request, reply) => {
      const capability = getQueryCapability(request.params.type);
      if (!capability) {
        return reply
          .code(404)
          .send(
            rfsError(
              `Unsupported Space query type "${request.params.type}".`,
              'unsupported_query',
            ),
          );
      }
      return reply.send(capability);
    },
  );

  app.get<{ Params: { canvasId: string; type: string } }>(
    '/:canvasId/capabilities/commands/:type',
    async (request, reply) => {
      const capability = getCommandCapability(request.params.type);
      if (!capability) {
        return reply
          .code(404)
          .send(
            rfsError(
              `Unsupported Space command type "${request.params.type}".`,
              'unsupported_command',
            ),
          );
      }
      return reply.send(capability);
    },
  );

  // ── POST /:canvasId/query ──
  app.post<{ Params: { canvasId: string } }>(
    '/:canvasId/query',
    async (request, reply) => {
      const body = request.body;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      let json: unknown;
      try {
        json = JSON.parse(buffer.toString('utf8') || '{}');
      } catch {
        return reply
          .code(400)
          .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
      }
      const parsed = spaceQuerySchema.safeParse(json);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            rfsError(
              parsed.error.issues[0]?.message ?? 'Invalid Space query.',
              'validation_failed',
            ),
          );
      }

      try {
        return reply.send(
          await executeSpaceQuery(request.params.canvasId, parsed.data),
        );
      } catch (error) {
        if (error instanceof SpaceQueryError) {
          return reply.code(404).send(rfsError(error.message, error.code));
        }
        request.log.error(
          { err: error, canvasId: request.params.canvasId },
          'rfs Space query failed',
        );
        return reply
          .code(500)
          .send(rfsError('Failed to execute the Space query.'));
      }
    },
  );

  // ── POST /:canvasId/execute ──
  app.post<{ Params: { canvasId: string } }>(
    '/:canvasId/execute',
    async (request, reply) => {
      const body = request.body;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      let json: unknown;
      try {
        json = JSON.parse(buffer.toString('utf8') || '{}');
      } catch {
        return reply
          .code(400)
          .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
      }
      const parsed = rfsExecuteRequestSchema.safeParse(json);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            rfsError(
              parsed.error.issues[0]?.message ??
                'Invalid Space execution request.',
              'validation_failed',
            ),
          );
      }

      // Best-effort change attribution: when the agent forwards its
      // injected `HUABU_THREAD_ID` via `X-Huabu-Host-Thread-Id`, tag the
      // batch to that host conversation so its change-review card fills.
      // Absent / malformed → the write still applies, just unattributed.
      const parsedHeaders = rfsExecuteHeadersSchema.safeParse(request.headers);
      const hostThreadId = parsedHeaders.success
        ? parsedHeaders.data['x-huabu-host-thread-id']
        : undefined;

      try {
        return reply.send(
          await executeRfsCommands(request.params.canvasId, parsed.data, {
            hostThreadId,
          }),
        );
      } catch (error) {
        if (error instanceof CanvasNotFoundError) {
          return reply
            .code(404)
            .send(rfsError('Canvas not found.', 'canvas_not_found'));
        }
        if (error instanceof MissingWorldPortalError) {
          return reply
            .code(409)
            .send(rfsError(error.message, 'WORLD_PORTAL_MISSING'));
        }
        request.log.error(
          { err: error, canvasId: request.params.canvasId },
          'rfs Space execution failed',
        );
        return reply
          .code(500)
          .send(rfsError('Failed to execute the Space commands.'));
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
      const parsedHeaders = rfsAgentHeadersSchema.safeParse(request.headers);
      if (!parsedHeaders.success) {
        return reply
          .code(400)
          .send(
            rfsError(
              parsedHeaders.error.issues[0]?.message ??
                'Invalid RFS agent headers.',
              'validation_failed',
            ),
          );
      }

      // Body: JSON `{prompt, doneTextOnly?, heartbeatSec?}` or a raw text prompt.
      const body = request.body;
      const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      const contentType = request.headers['content-type'] ?? '';

      let prompt: string;
      let legacyEventMode: RfsAgentEventMode = 'final';
      let legacyHeartbeatSec: number | undefined;

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
          legacyEventMode = parsed.data.doneTextOnly ? 'final' : 'all';
        }
        legacyHeartbeatSec = parsed.data.heartbeatSec;
      } else {
        prompt = buf.toString('utf8').trim();
      }

      if (!prompt) {
        return reply
          .code(400)
          .send(rfsError('A non-empty prompt is required.'));
      }

      const requestedThreadId = parsedHeaders.data['x-huabu-thread-id'];
      const threadId = requestedThreadId ?? createId('reachback');
      const eventMode =
        parsedHeaders.data['x-huabu-event-mode'] ?? legacyEventMode;
      const heartbeatSec = clampHeartbeatSec(
        parsedHeaders.data['x-huabu-heartbeat-sec'] ?? legacyHeartbeatSec,
      );

      let liveHandle: BuiltinHandle | undefined;
      if (requestedThreadId) {
        const record = agenetes.record(
          canvasAcpNamespace(canvasId),
          requestedThreadId,
        );
        if (!record || record.spec.workloadType !== 'Deployment') {
          return reply
            .code(404)
            .send(
              rfsError(
                'No Deployment exists for this thread in the requested Space.',
                'thread_not_found',
              ),
            );
        }
        if (record.spec.kind !== INTERNAL_DRIVER_KIND) {
          return reply
            .code(409)
            .send(
              rfsError(
                'This thread uses an unsupported agent driver.',
                'unsupported_thread_kind',
              ),
            );
        }
        liveHandle = agenetes.get(requestedThreadId) as
          | BuiltinHandle
          | undefined;
        if (!liveHandle) {
          return reply
            .code(409)
            .send(
              rfsError(
                'The Deployment exists but its agent handle is not live.',
                'thread_not_live',
              ),
            );
        }
      }

      const releaseTurn = acquireAgentTurn(threadId);
      if (!releaseTurn) {
        return reply
          .code(409)
          .send(
            rfsError(
              'Another turn is already running for this thread.',
              'thread_busy',
            ),
          );
      }

      await streamAgent(reply, request, {
        canvasId,
        prompt,
        threadId,
        eventMode,
        heartbeatSec,
        liveHandle,
        releaseTurn,
      });
    },
  );
};

// ── Agent streaming ──

interface StreamAgentInput {
  canvasId: string;
  prompt: string;
  threadId: string;
  eventMode: RfsAgentEventMode;
  heartbeatSec: number;
  liveHandle?: BuiltinHandle;
  releaseTurn: () => void;
}

async function streamAgent(
  reply: FastifyReply,
  request: FastifyRequest,
  input: StreamAgentInput,
): Promise<void> {
  const {
    canvasId,
    prompt,
    threadId,
    eventMode,
    heartbeatSec,
    liveHandle,
    releaseTurn,
  } = input;
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

  const envelope = createRfsEnvelope(prompt);

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, SSE_HEADERS);
  raw.flushHeaders?.();
  raw.write(': ok\n\n');
  raw.write(`: threadId ${threadId}\n\n`);
  if (eventMode === 'all') {
    raw.write(
      `event: ${AGENT_SSE_EVENTS.Meta}\ndata: ${JSON.stringify({
        threadId,
        mode: 'operate',
      })}\n\n`,
    );
  }

  // Timer-driven heartbeats keep proxies / client timeouts at bay during a
  // long agent turn, independent of how often the agent actually emits.
  const heartbeat = setInterval(() => {
    raw.write(': ping\n\n');
  }, heartbeatSec * 1000);

  const abortController = new AbortController();
  const onClose = (): void => abortController.abort();
  request.raw.socket?.once('close', onClose);

  try {
    const logger = { info: (message: string) => request.log.info(message) };
    const stream = liveHandle
      ? liveHandle.run(
          createChatSubmission(envelope, [{ type: 'text', text: prompt }]),
          {
            signal: abortController.signal,
            logger,
            maxIterations: 20,
          },
        )
      : runAgent({
          scope: 'operate',
          workloadType: 'Deployment',
          threadId,
          canvasId,
          origin: { type: 'ai-operate' },
          envelope,
          context: {
            systemPrompt: loadAgent('operate', { canvasId }).systemPrompt,
            messages: [],
            tools: [],
          } satisfies Context,
          logger,
          signal: abortController.signal,
          maxIterations: 20,
        });

    for await (const rawEvent of stream) {
      const event = normalizeInternalEvent(rawEvent);
      if (event.type === 'tool_call') toolCalls += 1;
      else if (event.type === 'done') outcome = 'ok';
      else if (event.type === 'error') outcome = 'error';
      if (debug) logReachbackEvent(request, threadId, event);
      if (eventMode === 'final') {
        // Clean mode: only the final answer text reaches the wire, as
        // `data:` frames a `sed` one-liner can extract.
        if (event.type === 'done') writeDataText(raw, event.data.message);
        else if (event.type === 'error') {
          raw.write(
            `event: ${AGENT_SSE_EVENTS.Error}\ndata: ${JSON.stringify(
              event.data,
            )}\n\n`,
          );
        }
      } else {
        raw.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    }
    if (eventMode === 'all' && outcome !== 'error') {
      raw.write(`event: ${AGENT_SSE_EVENTS.End}\ndata: {}\n\n`);
    }
  } catch (err: unknown) {
    outcome = 'error';
    const message = err instanceof Error ? err.message : 'Internal agent error';
    raw.write(
      `event: ${AGENT_SSE_EVENTS.Error}\ndata: ${JSON.stringify({
        error: message,
      })}\n\n`,
    );
  } finally {
    clearInterval(heartbeat);
    request.raw.socket?.removeListener('close', onClose);
    releaseTurn();
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
