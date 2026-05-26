/**
 * AcpAgentClient — drives one ACP session over a single agentlet
 * `AgentConnection`.
 *
 * Currently supported:
 *
 *   - `initialize()` — negotiate protocol version + capabilities
 *   - `newSession({ cwd })` — create a session, return sessionId
 *   - `prompt(sessionId, text, onUpdate, signal?)` — send user message,
 *     stream `session/update` notifications via callback, resolve with
 *     the final `{ stopReason }`
 *   - `cancel(sessionId)` — notify the agent to abort the current turn
 *
 * Capability handlers:
 *   - `fs/read_text_file`          — wired to capabilities/fs.ts (sandbox
 *                                    + `/canvas/` vfs prefix + allowlist)
 *   - `fs/write_text_file`         — explicit reject (-32601); read-only
 *   - `terminal/*`                 — never implemented; reject (-32601)
 *   - `session/request_permission` — stub (-32601) until the backend
 *                                    gate + UI land
 *
 * Not yet supported at all:
 *   - reconnect / session/load
 *   - tool_call / plan translation
 *
 * Design notes:
 *
 *   - One AcpAgentClient instance is bound to exactly **one Sediment
 *     canvas** (via `opts.canvasId` in the constructor). All sessions
 *     opened on this client inherit that canvas as their sandbox scope.
 *     A thread that rebinds to a different canvas must rebuild the
 *     client (enforced by `session-registry`).
 *   - One AcpAgentClient instance can still own multiple ACP sessions
 *     on a single agentlet `AgentConnection`, keyed by sessionId.
 *   - Registers a single `onMessage` handler on the connection that routes
 *     responses to pending request promises and `session/update`
 *     notifications to the per-session update handler installed by the
 *     in-flight `prompt(sessionId, ...)` call.
 *   - Incoming JSON-RPC requests from the agent go through
 *     `routeAgentRequest`. `fs/read_text_file` is live (sandbox +
 *     allowlist); the remaining capabilities are still stubs that
 *     return -32601 with the agreed wire method name. New capability
 *     handlers (permission gate, etc.) plug into the router as they
 *     land.
 */

import { FsCapabilityError, handleFsReadTextFile } from './capabilities/fs.js';

import type { AcpSessionUpdate } from './translator.js';
import type { AgentConnection, AcpMessage } from '@agentlet/protocol';

const ACP_PROTOCOL_VERSION = 1;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** Subset of the ACP initialize response we care about. */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name: string; version: string; title?: string };
  authMethods?: Array<{ id: string; name: string }>;
}

/** Subset of the ACP session/new response we care about. */
export interface AcpNewSessionResult {
  sessionId: string;
  modes?: unknown;
  configOptions?: unknown;
}

/** Subset of the ACP session/prompt response. */
export interface AcpPromptResult {
  stopReason:
    | 'end_turn'
    | 'max_tokens'
    | 'max_turn_requests'
    | 'refusal'
    | 'cancelled'
    | (string & {});
}

export interface AcpAgentClientOptions {
  /**
   * Sediment canvasId this client is bound to. Plumbed all the way from
   * `agent.route.ts` so capability handlers (fs sandbox, permission gate)
   * can scope their checks to the correct canvas directory. Constant for
   * the lifetime of the client — rebinding a thread to a different
   * canvas requires rebuilding the client (enforced in service.ts).
   *
   * Typed as optional because `agentRequestSchema.canvasId` is optional;
   * the fs sandbox (once implemented) will reject any fs/* call when
   * this is empty, so an external dispatch without a canvas cannot
   * access any Huabu file.
   */
  canvasId?: string;
  /** Optional logger; defaults to console. */
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

type SessionUpdateHandler = (update: AcpSessionUpdate) => void;

export class AcpAgentClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /**
   * Per-session update handlers keyed by sessionId. A handler is installed
   * for the duration of a `prompt()` call and removed in `finally`. Multiple
   * sessions on the same client can be in flight concurrently as long as
   * they have distinct sessionIds.
   */
  private readonly updateHandlers = new Map<string, SessionUpdateHandler>();
  private closed = false;
  private readonly logger: NonNullable<AcpAgentClientOptions['logger']>;
  /** Canvas scope for sandbox + permission checks. See AcpAgentClientOptions.canvasId. Empty string = “no canvas” (fs/* will be rejected). */
  readonly canvasId: string;

  constructor(
    private readonly connection: AgentConnection,
    opts: AcpAgentClientOptions,
  ) {
    this.canvasId = opts.canvasId ?? '';
    this.logger = opts.logger ?? {
      debug: (o, m) => console.debug('[acp-client]', m ?? '', o),
      warn: (o, m) => console.warn('[acp-client]', m ?? '', o),
      error: (o, m) => console.error('[acp-client]', m ?? '', o),
    };
    this.connection.onMessage((msg) => this.handleIncoming(msg));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async initialize(): Promise<AcpInitializeResult> {
    const result = (await this.sendRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        // Read is handled by acp/capabilities/fs.ts (sandbox +
        // /canvas/ vfs prefix + allowlist). Write stays closed —
        // there is no compelling v1 use case and writing canvas node
        // files would race with the live UI. `terminal` stays false
        // forever; agents that need a shell use their own local Bash
        // tool. `session/request_permission` is an implicit
        // capability and is not declared here.
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'sediment',
        version: '0.1.0',
      },
    })) as AcpInitializeResult;
    return result;
  }

  async newSession(opts: { cwd: string }): Promise<string> {
    const result = (await this.sendRequest('session/new', {
      cwd: opts.cwd,
      mcpServers: [],
    })) as AcpNewSessionResult;
    return result.sessionId;
  }

  /**
   * Send a user prompt. Each `session/update` notification arriving during
   * the turn is forwarded to `onUpdate`. Promise resolves when the agent
   * returns the prompt response (i.e. turn is over). If `signal` aborts,
   * a `session/cancel` notification is sent and the promise rejects.
   */
  async prompt(
    sessionId: string,
    text: string,
    onUpdate: SessionUpdateHandler,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    if (this.updateHandlers.has(sessionId)) {
      throw new Error(
        `AcpAgentClient: another prompt is already in flight for session ${sessionId}`,
      );
    }
    this.updateHandlers.set(sessionId, onUpdate);

    const abortListener = () => {
      void this.cancel(sessionId).catch((e) => {
        this.logger.warn(
          { err: String(e) },
          'session/cancel after abort failed',
        );
      });
    };
    signal?.addEventListener('abort', abortListener);

    try {
      const result = (await this.sendRequest('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      })) as AcpPromptResult;
      return result;
    } finally {
      this.updateHandlers.delete(sessionId);
      signal?.removeEventListener('abort', abortListener);
    }
  }

  /** Notify the agent to abort the current turn. Fire-and-forget. */
  async cancel(sessionId: string): Promise<void> {
    this.sendNotification('session/cancel', { sessionId });
  }

  /** Mark this client as closed and reject all pending promises. */
  shutdown(reason = 'client_shutdown'): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`AcpAgentClient closed: ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.updateHandlers.clear();
  }

  /** True if this client has been closed via `shutdown()`. */
  get isClosed(): boolean {
    return this.closed;
  }

  // ── Internal: JSON-RPC plumbing ─────────────────────────────────────────

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error('AcpAgentClient is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.connection.send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    this.connection.send({ jsonrpc: '2.0', method, params });
  }

  private sendErrorReply(
    id: string | number,
    code: number,
    message: string,
  ): void {
    this.connection.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private handleIncoming(msg: AcpMessage): void {
    // 1) Response to one of our outgoing requests?
    if ('id' in msg && !('method' in msg)) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) {
        this.logger.warn({ id: msg.id }, 'response for unknown request id');
        return;
      }
      this.pending.delete(msg.id as number);
      if ('error' in msg) {
        pending.reject(
          new Error(`ACP error ${msg.error.code}: ${msg.error.message}`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2) Notification or request from the agent.
    if (!('method' in msg)) {
      this.logger.warn({ msg }, 'malformed ACP message (no method, no id)');
      return;
    }

    // 2a) Notification (no id) — currently only session/update is interesting.
    if (!('id' in msg)) {
      if (msg.method === 'session/update') {
        const params = (msg.params ?? {}) as {
          sessionId?: string;
          update?: AcpSessionUpdate;
        };
        const sessionId = params.sessionId;
        if (params.update && typeof sessionId === 'string') {
          const handler = this.updateHandlers.get(sessionId);
          if (handler) {
            handler(params.update);
          } else {
            this.logger.debug(
              { sessionId, sessionUpdate: params.update.sessionUpdate },
              'session/update for unknown session — no handler registered',
            );
          }
        }
        return;
      }
      this.logger.debug({ method: msg.method }, 'ignored ACP notification');
      return;
    }

    // 2b) Request from agent — route through the capability dispatcher.
    //     Every branch currently returns -32601 with the agreed wire
    //     method name; capability handlers will be filled in as they
    //     land (fs/read_text_file, session/request_permission, …).
    this.routeAgentRequest(msg.method, msg.id, msg.params);
  }

  /**
   * Capability router for incoming agent→client requests.
   *
   *   - `fs/read_text_file`          → handleFsReadTextFile (sandbox + allowlist)
   *   - `fs/write_text_file`         → explicit reject (v1 is read-only)
   *   - `session/request_permission` → stub: rejected with -32601 until the
   *                                    backend gate + UI land
   *   - `terminal/*`                 → never implemented server-side
   *
   * `params` is forwarded untouched; capability handlers are responsible
   * for their own validation.
   */
  private routeAgentRequest(
    method: string,
    id: string | number,
    params: unknown,
  ): void {
    switch (method) {
      case 'fs/read_text_file':
        this.handleFsRead(id, params);
        return;
      case 'fs/write_text_file':
        // Advertised as unsupported via clientCapabilities; an agent
        // calling it anyway gets a precise reject so the operator can
        // see what was attempted.
        this.logger.warn(
          { method, id, canvasId: this.canvasId },
          'agent attempted fs/write_text_file — read-only in this Sediment version',
        );
        this.sendErrorReply(
          id,
          JSON_RPC_METHOD_NOT_FOUND,
          'fs/write_text_file is not implemented (Sediment is read-only over ACP in this version)',
        );
        return;
      case 'session/request_permission':
        // Permission gate will land alongside the UI; until then we
        // -32601 so the agent does not assume an implicit allow.
        this.logger.warn(
          { method, id, canvasId: this.canvasId },
          'agent called session/request_permission — handler not yet implemented',
        );
        this.sendErrorReply(
          id,
          JSON_RPC_METHOD_NOT_FOUND,
          'session/request_permission is not yet implemented',
        );
        return;
      default:
        // Includes terminal/* (never implemented) and any unknown method.
        this.logger.warn(
          { method, id, canvasId: this.canvasId },
          'agent called unknown / unsupported client method',
        );
        this.sendErrorReply(
          id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not implemented: ${method}`,
        );
        return;
    }
  }

  /**
   * Dispatch one `fs/read_text_file` call to the capability handler
   * and translate the (sync, may-throw) result into a JSON-RPC reply.
   * Failure mapping:
   *   - `FsCapabilityError`  → reply with its own code + message
   *   - anything else        → -32603 internal_error with sanitised text
   */
  private handleFsRead(id: string | number, params: unknown): void {
    try {
      const result = handleFsReadTextFile(this.canvasId, params);
      this.connection.send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (e instanceof FsCapabilityError) {
        this.logger.warn(
          { id, canvasId: this.canvasId, code: e.code, message: e.message },
          'fs/read_text_file refused',
        );
        this.sendErrorReply(id, e.code, e.message);
        return;
      }
      this.logger.error(
        {
          id,
          canvasId: this.canvasId,
          err: e instanceof Error ? e.message : String(e),
        },
        'fs/read_text_file failed with unexpected error',
      );
      this.sendErrorReply(
        id,
        JSON_RPC_INTERNAL_ERROR,
        'fs/read_text_file: internal error',
      );
    }
  }
}
