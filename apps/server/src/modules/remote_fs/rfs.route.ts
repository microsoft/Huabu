// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Remote File System (RFS) API routes — `/api/rfs/:canvasId/*`.
 *
 * The curl-native reachback surface for external agents (replaces the v1
 * node-CRUD `.mjs` reachback tool). Endpoints are all Bearer-gated by the
 * global auth hook in `app.ts`, except the bundled root `GET skill`
 * bootstrap:
 *
 * - `GET    download/<path>` — fetch a canvas file as raw bytes. Node files
 *   also carry their metadata (id/type/label/src/locked + parent/child edges)
 *   in ASCII-safe `X-Huabu-*` response headers.
 * - `POST   upload/<file>`   — stage bytes into the shared `.upload/` scratch
 *   dir (rejects on collision — the agent self-suffixes).
 * - `DELETE upload/<file>`   — remove a staged payload.
 * - `POST   agent`           — create a visible Agent and optionally start it.
 * - `POST   agent/:threadId/prompt` — submit a turn to an existing Agent.
 * - `POST   task/create`     — create a durable Task and static Task Note.
 * - `POST   task/:taskId/run/create` — create and start one Task Run.
 * - `POST   task/:taskId/run/:runId/complete` — complete one running Task Run.
 * - `GET    agent/profiles`  — list available Agent Profiles.
 * - `GET    skill`           — pull the canvas-access guide (per-canvas
 *   override → bundled default).
 * - `GET    skill/:skillId`  — pull one authenticated advanced RFS guide.
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
  createTaskRequestSchema,
  completeTaskRunRequestSchema,
  createInteractiveViewRequestSchema,
  HUABU_AGENT_PROFILE_ID,
  interactiveViewLookupQuerySchema,
  interactiveViewResourceParamsSchema,
  rfsAgentCreateHeadersSchema,
  rfsAgentCreateRequestSchema,
  rfsAgentHeadersSchema,
  rfsAgentPromptRequestSchema,
  rfsExecuteHeadersSchema,
  rfsExecuteRequestSchema,
  replaceInteractiveViewStateRequestSchema,
  spaceQuerySchema,
  startTaskRunRequestSchema,
  type CreateTaskResponse,
  type CompleteTaskRunResponse,
  type CreateInteractiveViewRequest,
  type RfsAgentEventMode,
  type RfsAgentCreateResponse,
  type RfsAgentProfilesResponse,
  type RfsUploadResponse,
  type AgentStreamEvent,
  type StartTaskRunResponse,
} from '@huabu/shared';

import { mimeForPath } from './mime.js';
import {
  lookupNodeByPath,
  resolveReadable,
  rfsMetaHeaders,
} from './node-meta.js';
import {
  resolveBundledRootSkill,
  resolveCanvasSkill,
  resolveFocusedSkill,
} from './skill.js';
import {
  getCommandCapability,
  getQueryCapability,
  getRfsCapabilities,
} from './space-capabilities.js';
import { executeRfsCommands } from './space-execute.js';
import {
  AgentNodeCreationError,
  agentNodeService,
  resolveAgentNodePosition,
} from '../agent/agent-node.service.js';
import {
  agentThreadResolver,
  AgentThreadResolutionError,
} from '../agent/agent-thread-resolver.js';
import {
  AgentThreadBusyError,
  agentThreadService,
  type AgentThreadInvocation,
} from '../agent/agent-thread.service.js';
import { buildChatEnvelope } from '../agent/conversation/envelope.js';
import { isPromptDebugEnabled } from '../agent/conversation/prompt/debug-prompt.js';
import {
  listAvailableAgentProfiles,
  SelectableAgentProfileError,
} from '../agent/selectable-agent-profile.js';
import { safeResolve } from '../agent/tools/handlers/fs-sandbox.js';
import { MissingWorldPortalError } from '../canvas/canvas-command-router.js';
import { CanvasNotFoundError } from '../canvas/canvas-executor.js';
import { executeSpaceQuery, SpaceQueryError } from '../canvas/space-query.js';
import {
  InteractiveViewServiceError,
  interactiveViewService,
} from '../interactive-view/interactive-view.service.js';
import {
  RunCompletionError,
  runCompletionService,
} from '../task/run-completion.service.js';
import { RunLaunchError, runLauncher } from '../task/run-launcher.js';
import { TaskCreationError, taskService } from '../task/task.service.js';

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
  details?: unknown,
): { message: string; code?: string; details?: unknown } {
  return {
    message: `${reason} To see how to use this Space, run: curl -fsS "$HUABU_RFS_URL/skill"`,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function interactiveViewStatus(error: InteractiveViewServiceError): number {
  switch (error.code) {
    case 'canvas_not_found':
    case 'view_not_found':
      return 404;
    case 'view_conflict':
      return 409;
    case 'invalid_definition':
    case 'invalid_state':
    case 'invalid_owner_thread':
    case 'renderer_not_found':
      return 400;
    default:
      return 500;
  }
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
  event: AgentStreamEvent,
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
        const guide = request.headers.authorization
          ? resolveCanvasSkill(canvasId)
          : resolveBundledRootSkill();
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

  app.get<{ Params: { canvasId: string; skillId: string } }>(
    '/:canvasId/skill/:skillId',
    async (request, reply) => {
      const guide = resolveFocusedSkill(request.params.skillId);
      if (!guide) {
        return reply
          .code(404)
          .send(
            rfsError(
              `Unknown advanced skill "${request.params.skillId}".`,
              'skill_not_found',
            ),
          );
      }
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .send(guide);
    },
  );

  // ── Interactive Views ──
  app.get<{
    Params: { canvasId: string };
    Querystring: { viewKey?: string };
  }>('/:canvasId/interactive-views', async (request, reply) => {
    const query = interactiveViewLookupQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(rfsError('Invalid Interactive View query.', 'validation_failed'));
    }
    try {
      return reply.send({
        views: await interactiveViewService.list(
          request.params.canvasId,
          query.data.viewKey,
        ),
      });
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(interactiveViewStatus(error))
          .send(rfsError(error.message, error.code));
      }
      throw error;
    }
  });

  app.post<{
    Params: { canvasId: string };
    Body: CreateInteractiveViewRequest;
  }>('/:canvasId/interactive-views', async (request, reply) => {
    let json: unknown;
    try {
      json = JSON.parse(
        Buffer.isBuffer(request.body)
          ? request.body.toString('utf8') || '{}'
          : '{}',
      );
    } catch {
      return reply
        .code(400)
        .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
    }
    const parsed = createInteractiveViewRequestSchema.safeParse(json);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          rfsError(
            parsed.error.issues[0]?.message ??
              'Invalid Interactive View request.',
            'validation_failed',
          ),
        );
    }
    try {
      const resource = await interactiveViewService.create(
        request.params.canvasId,
        parsed.data,
      );
      return reply.code(201).send(resource);
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(interactiveViewStatus(error))
          .send(rfsError(error.message, error.code));
      }
      throw error;
    }
  });

  app.get<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/interactive-views/:nodeId', async (request, reply) => {
    const params = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    if (!params.success) {
      return reply
        .code(400)
        .send(
          rfsError('Invalid Interactive View identity.', 'validation_failed'),
        );
    }
    try {
      return reply.send(
        await interactiveViewService.get(
          params.data.canvasId,
          params.data.nodeId,
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(interactiveViewStatus(error))
          .send(rfsError(error.message, error.code));
      }
      throw error;
    }
  });

  app.get<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/interactive-views/:nodeId/runtime', async (request, reply) => {
    const params = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    if (!params.success) {
      return reply
        .code(400)
        .send(
          rfsError('Invalid Interactive View identity.', 'validation_failed'),
        );
    }
    try {
      return reply.send(
        await interactiveViewService.runtimeSnapshot(
          params.data.canvasId,
          params.data.nodeId,
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(interactiveViewStatus(error))
          .send(rfsError(error.message, error.code));
      }
      throw error;
    }
  });

  app.put<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/interactive-views/:nodeId/state', async (request, reply) => {
    const params = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    let json: unknown;
    try {
      json = JSON.parse(
        Buffer.isBuffer(request.body)
          ? request.body.toString('utf8') || '{}'
          : '{}',
      );
    } catch {
      return reply
        .code(400)
        .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
    }
    const body = replaceInteractiveViewStateRequestSchema.safeParse(json);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(
          rfsError(
            'Invalid Interactive View state replacement.',
            'validation_failed',
          ),
        );
    }
    try {
      return reply.send(
        await interactiveViewService.replaceState(
          params.data.canvasId,
          params.data.nodeId,
          body.data.revision,
          body.data.value,
          'trusted-agent',
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply.code(interactiveViewStatus(error)).send(
          rfsError(
            error.message,
            error.code,
            error.conflict
              ? {
                  currentRevision: error.conflict.currentRevision,
                  currentState: error.conflict.currentState,
                }
              : undefined,
          ),
        );
      }
      throw error;
    }
  });

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

      const lookup = await lookupNodeByPath(canvasId, physicalRel);

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

  // ── Task creation and Run launch ──
  app.get<{ Params: { canvasId: string } }>(
    '/:canvasId/agent/profiles',
    async (_request, reply) => {
      try {
        const response: RfsAgentProfilesResponse = {
          profiles: listAvailableAgentProfiles(),
        };
        return reply.send(response);
      } catch (error) {
        if (
          error instanceof SelectableAgentProfileError &&
          error.code === 'registry_unavailable'
        ) {
          return reply.code(503).send(rfsError(error.message, error.code));
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { canvasId: string } }>(
    '/:canvasId/task/create',
    async (request, reply) => {
      const body = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : '';
      let json: unknown;
      try {
        json = JSON.parse(body || '{}');
      } catch {
        return reply
          .code(400)
          .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
      }
      const parsed = createTaskRequestSchema.safeParse(json);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            rfsError(
              parsed.error.issues[0]?.message ?? 'Invalid Task request.',
              'validation_failed',
            ),
          );
      }

      try {
        const task = await taskService.create(
          request.params.canvasId,
          parsed.data,
        );
        const response: CreateTaskResponse = { task };
        return reply.code(201).send(response);
      } catch (error) {
        if (error instanceof TaskCreationError) {
          const status =
            error.code === 'invalid_input'
              ? 400
              : error.code === 'profile_registry_unavailable'
                ? 503
                : ['canvas_not_found', 'profile_not_found'].includes(error.code)
                  ? 404
                  : 500;
          const reason = error.createdAnchorNodeId
            ? `${error.message} Created Task Note: ${error.createdAnchorNodeId}.`
            : error.message;
          return reply.code(status).send(rfsError(reason, error.code));
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { canvasId: string; taskId: string } }>(
    '/:canvasId/task/:taskId/run/create',
    async (request, reply) => {
      const body = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : '';
      let json: unknown;
      try {
        json = JSON.parse(body || '{}');
      } catch {
        return reply
          .code(400)
          .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
      }
      const parsed = startTaskRunRequestSchema.safeParse(json);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            rfsError(
              parsed.error.issues[0]?.message ?? 'Invalid Run request.',
              'validation_failed',
            ),
          );
      }

      try {
        const run = await runLauncher.start(
          request.params.canvasId,
          request.params.taskId,
          parsed.data,
          { logger: request.log },
        );
        const response: StartTaskRunResponse = { run };
        return reply.code(201).send(response);
      } catch (error) {
        if (error instanceof RunLaunchError) {
          const status =
            error.code === 'invalid_input'
              ? 400
              : error.code === 'profile_registry_unavailable'
                ? 503
                : ['task_not_found', 'profile_not_found'].includes(error.code)
                  ? 404
                  : error.code === 'root_position_failed'
                    ? 409
                    : 500;
          const partial = [
            error.runId ? `Run: ${error.runId}.` : '',
            error.rootNodeId ? `Root node: ${error.rootNodeId}.` : '',
            error.rootThreadId ? `Root thread: ${error.rootThreadId}.` : '',
          ]
            .filter(Boolean)
            .join(' ');
          const reason = partial
            ? `${error.message} ${partial}`
            : error.message;
          return reply.code(status).send(rfsError(reason, error.code));
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: { canvasId: string; taskId: string; runId: string };
  }>('/:canvasId/task/:taskId/run/:runId/complete', async (request, reply) => {
    const body = Buffer.isBuffer(request.body)
      ? request.body.toString('utf8')
      : '';
    let json: unknown;
    try {
      json = JSON.parse(body || '{}');
    } catch {
      return reply
        .code(400)
        .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
    }
    const parsed = completeTaskRunRequestSchema.safeParse(json);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          rfsError(
            parsed.error.issues[0]?.message ??
              'Invalid Run completion request.',
            'validation_failed',
          ),
        );
    }

    try {
      const run = await runCompletionService.complete(
        request.params.canvasId,
        request.params.taskId,
        request.params.runId,
        parsed.data,
      );
      const response: CompleteTaskRunResponse = { run };
      return reply.send(response);
    } catch (error) {
      if (error instanceof RunCompletionError) {
        const status =
          error.code === 'invalid_input'
            ? 400
            : ['task_not_found', 'run_not_found'].includes(error.code)
              ? 404
              : ['run_not_running', 'completion_conflict'].includes(error.code)
                ? 409
                : 500;
        return reply.code(status).send(rfsError(error.message, error.code));
      }
      throw error;
    }
  });

  // ── POST /:canvasId/agent ──
  app.post<{ Params: { canvasId: string } }>(
    '/:canvasId/agent',
    async (request, reply) => {
      const { canvasId } = request.params;
      const parsedHeaders = rfsAgentCreateHeadersSchema.safeParse(
        request.headers,
      );
      if (!parsedHeaders.success) {
        return reply
          .code(400)
          .send(rfsError('Invalid Agent creation headers.'));
      }

      const body = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : '';
      const contentType = request.headers['content-type'] ?? '';
      let creation: {
        profileId: string;
        prompt?: string;
        position?: { x: number; y: number };
        parentThreadId?: string;
        workingDirPath?: string;
        additionalInitialPreamble?: string;
      };
      if (contentType.includes('application/json')) {
        let json: unknown;
        try {
          json = JSON.parse(body || '{}');
        } catch {
          return reply
            .code(400)
            .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
        }
        const parsed = rfsAgentCreateRequestSchema.safeParse(json);
        if (!parsed.success) {
          return reply
            .code(400)
            .send(
              rfsError(
                parsed.error.issues[0]?.message ??
                  'Invalid Agent creation request.',
                'validation_failed',
              ),
            );
        }
        creation = parsed.data;
      } else {
        const prompt = body.trim();
        if (!prompt) {
          return reply
            .code(400)
            .send(rfsError('A non-empty prompt is required.'));
        }
        creation = { profileId: HUABU_AGENT_PROFILE_ID, prompt };
      }

      const start = parsedHeaders.data['x-huabu-agent-start'] ?? true;
      if (!start && !contentType.includes('application/json')) {
        return reply
          .code(400)
          .send(
            rfsError(
              'Create-only Agent requests must use application/json.',
              'invalid_creation_mode',
            ),
          );
      }
      if (start && !creation.prompt) {
        return reply
          .code(400)
          .send(
            rfsError(
              'An initial prompt is required when X-Huabu-Agent-Start is true.',
              'prompt_required',
            ),
          );
      }
      if (!start && creation.prompt) {
        return reply
          .code(400)
          .send(
            rfsError(
              'Create-only Agent requests must omit prompt.',
              'prompt_not_allowed',
            ),
          );
      }

      const parentThreadId =
        creation.parentThreadId ?? parsedHeaders.data['x-huabu-host-thread-id'];
      let parentNodeId;
      let parentLookupFailed = false;
      if (parentThreadId) {
        try {
          parentNodeId = await agentThreadResolver.resolveAgentNodeId(
            canvasId,
            parentThreadId,
          );
        } catch (error) {
          parentLookupFailed = true;
          request.log.warn(
            { error, canvasId, parentThreadId },
            'rfs Agent parent lookup failed; creating without connection',
          );
        }
      }

      let position;
      try {
        position =
          creation.position ??
          (await resolveAgentNodePosition(canvasId, parentNodeId ?? undefined));
      } catch (error) {
        if (
          error instanceof AgentNodeCreationError &&
          error.code === 'canvas_not_found'
        ) {
          return reply.code(404).send(rfsError(error.message, error.code));
        }
        throw error;
      }

      let created;
      try {
        created = await agentNodeService.create({
          canvasId,
          profileId: creation.profileId,
          position,
          ...(parentNodeId
            ? {
                anchor: {
                  kind: 'delegated' as const,
                  parentAgentNodeId: parentNodeId,
                },
              }
            : {}),
          launchOverrides: {
            ...(creation.workingDirPath !== undefined
              ? { workingDirPath: creation.workingDirPath }
              : {}),
            ...(creation.additionalInitialPreamble !== undefined
              ? {
                  additionalInitialPreamble: creation.additionalInitialPreamble,
                }
              : {}),
          },
        });
      } catch (error) {
        if (error instanceof AgentNodeCreationError) {
          const status =
            error.code === 'canvas_not_found'
              ? 404
              : error.code === 'profile_registry_unavailable'
                ? 503
                : error.code === 'profile_not_selectable'
                  ? 404
                  : ['invalid_launch_overrides', 'invalid_position'].includes(
                        error.code,
                      )
                    ? 400
                    : 500;
          const code =
            error.code === 'profile_not_selectable'
              ? 'profile_not_found'
              : error.code;
          const message =
            error.code === 'profile_not_selectable'
              ? `Agent Profile ${creation.profileId} is unavailable.`
              : error.message;
          return reply.code(status).send(rfsError(message, code));
        }
        throw error;
      }

      const eventMode = parsedHeaders.data['x-huabu-event-mode'] ?? 'final';
      const heartbeatSec = clampHeartbeatSec(
        parsedHeaders.data['x-huabu-heartbeat-sec'],
      );
      const warnings: RfsAgentCreateResponse['warnings'] = [];
      let parentConnection: RfsAgentCreateResponse['parentConnection'] =
        'not_requested';
      if (parentThreadId) {
        if (parentLookupFailed || created.parentConnection === 'failed') {
          parentConnection = 'failed';
          warnings.push({
            code: 'parent_connection_failed',
            message: 'The Agent was created without a parent connection.',
          });
        } else if (!parentNodeId) {
          parentConnection = 'not_found';
          warnings.push({
            code: 'parent_not_found',
            message:
              'No Agent Node was found for the requested parent thread; the Agent was created without a parent connection.',
          });
        } else {
          parentConnection = 'connected';
        }
      }

      const response: RfsAgentCreateResponse = {
        nodeId: created.nodeId,
        threadId: created.threadId,
        profileId: created.profileId,
        parentConnection,
        warnings,
      };
      if (!start) return reply.code(201).send(response);
      const initialPrompt = creation.prompt;
      if (!initialPrompt) {
        return reply
          .code(400)
          .send(rfsError('An initial prompt is required.', 'prompt_required'));
      }

      const target = await agentThreadService.resolveFixedTarget(
        canvasId,
        created.threadId,
      );
      if (!target) {
        return reply
          .code(500)
          .send(
            rfsError(
              `Agent ${created.nodeId} was created with thread ${created.threadId}, but its first turn could not resolve the new conversation.`,
              'agent_resolution_failed',
            ),
          );
      }
      let envelope;
      try {
        envelope = await buildChatEnvelope({
          content: initialPrompt,
          anchorNodeId: target.nodeId,
          canvasId,
          logger: request.log,
        });
      } catch (error) {
        request.log.error(
          {
            error,
            canvasId,
            nodeId: created.nodeId,
            threadId: created.threadId,
          },
          'rfs created Agent prompt preparation failed',
        );
        return reply
          .code(500)
          .send(
            rfsError(
              `Agent ${created.nodeId} was created with thread ${created.threadId}, but its first prompt could not be prepared.`,
              'prompt_preparation_failed',
            ),
          );
      }
      let invocation;
      try {
        invocation = await agentThreadService.invoke({
          threadId: created.threadId,
          canvasId,
          content: initialPrompt,
          mode: 'operate',
          envelope,
          fixedTarget: target,
          logger: request.log,
        });
      } catch (error) {
        if (error instanceof AgentThreadBusyError) {
          return reply.code(409).send(rfsError(error.message, 'thread_busy'));
        }
        request.log.error(
          {
            error,
            canvasId,
            nodeId: created.nodeId,
            threadId: created.threadId,
          },
          'rfs created Agent invocation failed',
        );
        return reply
          .code(500)
          .send(
            rfsError(
              `Agent ${created.nodeId} was created with thread ${created.threadId}, but its first turn could not start.`,
              'invocation_failed',
            ),
          );
      }
      await streamAgent(reply, request, {
        canvasId,
        prompt: initialPrompt,
        threadId: created.threadId,
        eventMode,
        heartbeatSec,
        invocation,
        created: response,
        statusCode: 201,
      });
    },
  );

  // ── POST /:canvasId/agent/:threadId/prompt ──
  app.post<{ Params: { canvasId: string; threadId: string } }>(
    '/:canvasId/agent/:threadId/prompt',
    async (request, reply) => {
      const { canvasId, threadId } = request.params;
      const parsedHeaders = rfsAgentHeadersSchema.safeParse(request.headers);
      if (!parsedHeaders.success) {
        return reply
          .code(400)
          .send(rfsError('Invalid Agent prompt headers.', 'validation_failed'));
      }
      const body = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : '';
      const contentType = request.headers['content-type'] ?? '';
      let prompt: string;
      let eventMode: RfsAgentEventMode =
        parsedHeaders.data['x-huabu-event-mode'] ?? 'final';
      let heartbeatSec = parsedHeaders.data['x-huabu-heartbeat-sec'];
      if (contentType.includes('application/json')) {
        let json: unknown;
        try {
          json = JSON.parse(body || '{}');
        } catch {
          return reply
            .code(400)
            .send(rfsError('Request body is not valid JSON.', 'invalid_json'));
        }
        const parsed = rfsAgentPromptRequestSchema.safeParse(json);
        if (!parsed.success) {
          return reply
            .code(400)
            .send(
              rfsError('Invalid Agent prompt request.', 'validation_failed'),
            );
        }
        prompt = parsed.data.prompt;
        eventMode =
          parsedHeaders.data['x-huabu-event-mode'] ??
          parsed.data.eventMode ??
          'final';
        heartbeatSec ??= parsed.data.heartbeatSec;
      } else {
        prompt = body.trim();
      }
      if (!prompt) {
        return reply
          .code(400)
          .send(rfsError('A non-empty prompt is required.'));
      }

      let target;
      try {
        target = await agentThreadService.resolveFixedTarget(
          canvasId,
          threadId,
        );
      } catch (error) {
        if (error instanceof AgentThreadResolutionError) {
          return reply
            .code(error.code === 'canvas_not_found' ? 404 : 409)
            .send(rfsError(error.message, 'invalid_thread_binding'));
        }
        throw error;
      }
      if (!target) {
        return reply
          .code(404)
          .send(
            rfsError(
              'No Agent Node exists for this thread in the requested Space.',
              'thread_not_found',
            ),
          );
      }

      const envelope = await buildChatEnvelope({
        content: prompt,
        anchorNodeId: target.nodeId,
        canvasId,
        logger: request.log,
      });
      let invocation;
      try {
        invocation = await agentThreadService.invoke({
          threadId,
          canvasId,
          content: prompt,
          mode: 'operate',
          envelope,
          fixedTarget: target,
          logger: request.log,
        });
      } catch (error) {
        if (error instanceof AgentThreadBusyError) {
          return reply.code(409).send(rfsError(error.message, 'thread_busy'));
        }
        throw error;
      }
      await streamAgent(reply, request, {
        canvasId,
        prompt,
        threadId,
        eventMode,
        heartbeatSec: clampHeartbeatSec(heartbeatSec),
        invocation,
        statusCode: 200,
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
  invocation: AgentThreadInvocation;
  statusCode: 200 | 201;
  created?: RfsAgentCreateResponse;
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
    invocation,
    statusCode,
    created,
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

  const raw = reply.raw;
  try {
    reply.hijack();
    raw.writeHead(statusCode, SSE_HEADERS);
    raw.flushHeaders?.();
    raw.write(': ok\n\n');
    raw.write(`: threadId ${threadId}\n\n`);
    if (created) {
      raw.write(`event: created\ndata: ${JSON.stringify(created)}\n\n`);
    }
    if (eventMode === 'all') {
      raw.write(
        `event: ${AGENT_SSE_EVENTS.Meta}\ndata: ${JSON.stringify({
          threadId,
          mode: 'operate',
        })}\n\n`,
      );
    }
  } catch (error) {
    await invocation.dispose(error);
    throw error;
  }

  let clientConnected = true;
  // Timer-driven heartbeats keep proxies / client timeouts at bay during a
  // long agent turn, independent of how often the agent actually emits.
  const heartbeat = setInterval(() => {
    if (clientConnected) raw.write(': ping\n\n');
  }, heartbeatSec * 1000);

  const onClose = (): void => {
    clientConnected = false;
  };
  request.raw.socket?.once('close', onClose);

  try {
    for await (const event of invocation.events) {
      if (event.type === 'tool_call') toolCalls += 1;
      else if (event.type === 'done') outcome = 'ok';
      else if (event.type === 'error') outcome = 'error';
      if (debug) logReachbackEvent(request, threadId, event);
      if (eventMode === 'final') {
        // Clean mode: only the final answer text reaches the wire, as
        // `data:` frames a `sed` one-liner can extract.
        if (event.type === 'done' && clientConnected) {
          writeDataText(raw, event.data.message);
        } else if (event.type === 'error' && clientConnected) {
          raw.write(
            `event: ${AGENT_SSE_EVENTS.Error}\ndata: ${JSON.stringify(
              event.data,
            )}\n\n`,
          );
        }
      } else if (clientConnected) {
        raw.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    }
    if (clientConnected && eventMode === 'all' && outcome !== 'error') {
      raw.write(`event: ${AGENT_SSE_EVENTS.End}\ndata: {}\n\n`);
    }
  } catch (err: unknown) {
    outcome = 'error';
    const message = err instanceof Error ? err.message : 'Internal agent error';
    if (clientConnected) {
      raw.write(
        `event: ${AGENT_SSE_EVENTS.Error}\ndata: ${JSON.stringify({
          error: message,
        })}\n\n`,
      );
    }
  } finally {
    clearInterval(heartbeat);
    request.raw.socket?.removeListener('close', onClose);
    if (clientConnected) raw.end();
    if (debug) {
      if (outcome === 'incomplete' && invocation.signal.aborted) {
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
