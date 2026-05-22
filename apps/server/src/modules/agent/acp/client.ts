/**
 * AcpAgentClient — drives one ACP session over a single agentlet
 * `AgentConnection`.
 *
 * Phase 1 scope (per docs/huabu-acp-client-plan.md §3.2 + Phase 1):
 *
 *   - `initialize()` — negotiate protocol version + capabilities
 *   - `newSession({ cwd })` — create a session, return sessionId
 *   - `prompt(sessionId, text, onUpdate, signal?)` — send user message,
 *     stream `session/update` notifications via callback, resolve with
 *     the final `{ stopReason }`
 *   - `cancel(sessionId)` — notify the agent to abort the current turn
 *
 * Out of scope for Phase 1 (handled by capability stubs that reject):
 *   - `fs/read_text_file`, `fs/write_text_file`            → Phase 3
 *   - `terminal/*`                                          → never
 *   - `session/request_permission`                          → Phase 3
 *
 * Out of scope for Phase 1 entirely:
 *   - reconnect / session/load                              → Phase 3+
 *   - tool_call / plan translation                          → Phase 2
 *
 * Design notes:
 *
 *   - One AcpAgentClient instance owns one ACP session. Don't reuse across
 *     sessions; construct a new one per debug invocation.
 *   - Registers a single `onMessage` handler on the connection that routes
 *     responses to pending request promises and notifications to the
 *     in-flight `prompt()` callback.
 *   - Any incoming JSON-RPC request from the agent is replied to with
 *     -32601 Method not implemented (until Phase 3 wires the capability
 *     router).
 */

import type { AcpSessionUpdate } from './translator.js';
import type { AgentConnection, AcpMessage } from '@agentlet/protocol';

const ACP_PROTOCOL_VERSION = 1;

const JSON_RPC_METHOD_NOT_FOUND = -32601;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** Subset of the ACP initialize response we care about in Phase 1. */
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
  private currentUpdateHandler: SessionUpdateHandler | null = null;
  private closed = false;
  private readonly logger: NonNullable<AcpAgentClientOptions['logger']>;

  constructor(
    private readonly connection: AgentConnection,
    opts: AcpAgentClientOptions = {},
  ) {
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
        // Phase 1 advertises ZERO capabilities so the agent shouldn't try
        // to call fs/* or terminal/*. If it does anyway we reply -32601.
        fs: { readTextFile: false, writeTextFile: false },
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
    if (this.currentUpdateHandler) {
      throw new Error('AcpAgentClient: another prompt is already in flight');
    }
    this.currentUpdateHandler = onUpdate;

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
      this.currentUpdateHandler = null;
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
    this.currentUpdateHandler = null;
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
        const params = (msg.params ?? {}) as { update?: AcpSessionUpdate };
        if (params.update && this.currentUpdateHandler) {
          this.currentUpdateHandler(params.update);
        }
        return;
      }
      this.logger.debug({ method: msg.method }, 'ignored ACP notification');
      return;
    }

    // 2b) Request from agent — Phase 1 has no client capabilities advertised,
    //     so reject everything with -32601. Phase 3 will wire the real router
    //     for fs/* + session/request_permission.
    this.logger.warn(
      { method: msg.method, id: msg.id },
      'agent called unimplemented client method',
    );
    this.sendErrorReply(
      msg.id,
      JSON_RPC_METHOD_NOT_FOUND,
      `Method not implemented in Phase 1: ${msg.method}`,
    );
  }
}
