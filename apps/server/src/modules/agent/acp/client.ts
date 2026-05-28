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
 *   - `session/request_permission` — auto-allow (local-agent threat
 *                                    model). The agent’s OS permissions
 *                                    are the real boundary; a UI gate
 *                                    can layer on later without breaking
 *                                    wire compat.
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

import type { AgentConnection, AcpMessage } from '@agentlet/protocol';
import type { AcpSessionUpdate } from '@sediment/shared';

const ACP_PROTOCOL_VERSION = 1;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * ACP `PermissionOption` (subset). Each option offered by the agent
 * carries a stable `optionId` (echoed back in the response) and an
 * orientation `kind` that the client uses to pick a default.
 */
interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: 'allow_always' | 'allow_once' | 'reject_once' | 'reject_always';
}

/**
 * Pick the most-permissive option from a permission request.
 *
 *   1. `allow_always` (best — sticks for the session, fewer round-trips)
 *   2. `allow_once`
 *   3. First option whose `kind` is not in the `reject_*` family
 *   4. First option (last-resort — caller has already decided)
 *
 * Exported for testing.
 */
export function pickPermissionOption(
  options: ReadonlyArray<PermissionOption>,
): PermissionOption {
  const byKind = (k: PermissionOption['kind']) =>
    options.find((o) => o.kind === k);
  return (
    byKind('allow_always') ??
    byKind('allow_once') ??
    options.find(
      (o) => o.kind !== 'reject_once' && o.kind !== 'reject_always',
    ) ??
    options[0]
  );
}

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
    info: (obj: unknown, msg?: string) => void;
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
  /**
   * Long-lived per-session listeners installed via
   * {@link registerSessionListener}. Coexist with the turn-scoped
   * `updateHandlers`: both fire for every `session/update` on the
   * session id. Used to capture out-of-turn notifications (e.g.
   * `available_commands_update`, which the spec allows the agent to
   * push at any time and which typically arrives shortly after
   * `session/new` resolves — before any prompt is in flight).
   */
  private readonly sessionListeners = new Map<
    string,
    Set<SessionUpdateHandler>
  >();
  /**
   * Bounded ring buffer of `session/update` notifications that arrived
   * BEFORE any turn handler or session listener was registered for
   * their sessionId. Replayed when {@link registerSessionListener} is
   * called for that sessionId, then dropped.
   *
   * Motivating race: many ACP agents push
   * `available_commands_update` **before** their `session/new`
   * response on the wire (agentlet's own UI compensates for the same
   * ordering in `stores/session.ts`). Without buffering, the caller
   * has no chance to install a listener in time: the
   * `await sendRequest('session/new', …)` promise only resolves
   * after the response arrives, so any listener registration must
   * follow — by which point the earlier notification has already
   * been seen by `handleIncoming` with no handlers and silently
   * dropped. The bug surfaces as a permanently-empty slash-command
   * list for the thread.
   *
   * Size cap per sessionId is a defensive memory bound — in practice
   * the orphan window is one or two updates wide. Once a listener
   * registers we drain and forget; sessions that never get a listener
   * keep at most {@link MAX_ORPHAN_UPDATES_PER_SESSION} updates and
   * are cleared on {@link shutdown}.
   */
  private readonly orphanUpdates = new Map<string, AcpSessionUpdate[]>();
  private static readonly MAX_ORPHAN_UPDATES_PER_SESSION = 32;
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
      info: (o, m) => console.info('[acp-client]', m ?? '', o),
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

  /**
   * Install a long-lived listener for every `session/update` arriving on
   * `sessionId`, regardless of whether a `prompt()` turn is in flight.
   * Use for out-of-turn metadata pushes — the canonical example is
   * `available_commands_update`, which the spec allows the agent to push
   * at any time (typically right after `session/new`).
   *
   * Multiple listeners are supported; each is invoked in registration order.
   * Returns a disposer; call it during cleanup to avoid leaks.
   *
   * Listeners run in addition to (not instead of) the turn-scoped handler
   * installed by `prompt()`. So a `session/update` arriving during a turn
   * fires BOTH the turn handler and any registered session listeners.
   *
   * Replays {@link orphanUpdates} for `sessionId` synchronously to the
   * newly-registered handler before returning, so notifications that
   * arrived before any listener existed (the canonical race: agent
   * pushes `available_commands_update` BEFORE the `session/new`
   * response) are delivered exactly once. The orphan buffer for
   * `sessionId` is then cleared.
   */
  registerSessionListener(
    sessionId: string,
    handler: SessionUpdateHandler,
  ): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(handler);
    // Drain orphan buffer for this sessionId. Done AFTER adding the
    // handler to the set so a (hypothetical) re-entrant
    // registerSessionListener from inside the replayed handler sees a
    // stable state. We fire the just-registered handler with each
    // buffered update; any OTHER listeners that race-registered in
    // the same tick already had their chance via the live path and
    // won't see replays — which is correct, they were attached AFTER
    // the orphan arrived.
    const orphans = this.orphanUpdates.get(sessionId);
    if (orphans && orphans.length > 0) {
      this.orphanUpdates.delete(sessionId);
      for (const update of orphans) {
        try {
          handler(update);
        } catch (e) {
          this.logger.warn(
            { sessionId, err: String(e) },
            'session/update orphan replay handler threw',
          );
        }
      }
    }
    return () => {
      const current = this.sessionListeners.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  /** Mark this client as closed and reject all pending promises. */
  shutdown(reason = 'client_shutdown'): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`AcpAgentClient closed: ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.updateHandlers.clear();
    this.sessionListeners.clear();
    this.orphanUpdates.clear();
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
          // Fan-out: BOTH the turn-scoped handler (if a prompt is in
          // flight) and every long-lived session listener fire. Out-of-turn
          // updates (e.g. `available_commands_update` arriving right
          // after `session/new`) only have listeners — they would be
          // silently dropped without this branch.
          const turnHandler = this.updateHandlers.get(sessionId);
          const listeners = this.sessionListeners.get(sessionId);
          if (turnHandler) {
            try {
              turnHandler(params.update);
            } catch (e) {
              this.logger.warn(
                { sessionId, err: String(e) },
                'session/update turn handler threw',
              );
            }
          }
          if (listeners && listeners.size > 0) {
            for (const listener of listeners) {
              try {
                listener(params.update);
              } catch (e) {
                this.logger.warn(
                  { sessionId, err: String(e) },
                  'session/update listener threw',
                );
              }
            }
          }
          if (!turnHandler && (!listeners || listeners.size === 0)) {
            // No handler yet — buffer for later replay via
            // registerSessionListener. Bounded ring: drop oldest if
            // we exceed MAX_ORPHAN_UPDATES_PER_SESSION. See the
            // orphanUpdates field comment for why this matters
            // (agent pushes available_commands_update before the
            // session/new response).
            let buf = this.orphanUpdates.get(sessionId);
            if (!buf) {
              buf = [];
              this.orphanUpdates.set(sessionId, buf);
            }
            buf.push(params.update);
            if (buf.length > AcpAgentClient.MAX_ORPHAN_UPDATES_PER_SESSION) {
              buf.shift();
            }
            this.logger.debug(
              {
                sessionId,
                sessionUpdate: params.update.sessionUpdate,
                bufferedCount: buf.length,
              },
              'session/update buffered (no handler yet)',
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
   *   - `session/request_permission` → handleSessionRequestPermission
   *                                    (auto-allow; see method JSDoc)
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
    // Observability probe: every agent→client request goes through
    // here. At info-level so it shows up in the default log stream —
    // this is how we tell whether an external agent (Copilot, Claude,
    // …) actually exercises ACP fs/permission capabilities or just
    // uses its own native tools. Cheap; one line per agent→client RPC.
    // Demote to debug once the integration is no longer being validated.
    this.logger.info(
      { method, id, canvasId: this.canvasId },
      '[acp] incoming agent request',
    );
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
        this.handleSessionRequestPermission(id, params);
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

  /**
   * Auto-allow handler for `session/request_permission`.
   *
   * Why auto-allow (not a UI prompt)?
   *   - Sediment’s ACP runtime is **local-agent only**: the agent runs
   *     on the same machine as the server, launched by the user via
   *     `agentlet`. The OS file-permission boundary is the real gate;
   *     the wire-level permission gate is a soft contract.
   *   - Per-tool-call UI confirmations would be unusable in practice
   *     (Copilot can invoke Read 10+ times per turn).
   *   - When we add remote / sandboxed deployments, this method is the
   *     single insertion point for a stricter policy (kind-based
   *     prompt-on-write/execute, allow-list per session, etc.).
   *
   * Option-selection rule (see {@link pickPermissionOption}):
   *   1. Prefer `allow_always` (sticks across the session).
   *   2. Else `allow_once`.
   *   3. Else first option that is not `reject_*`.
   *   4. Else fall back to whatever is offered (caller likely already
   *      decided this is rejected).
   *
   * Each decision is logged at info-level with `{ canvasId, toolCall,
   * optionId, kind }` so dev operators can see what the agent has been
   * doing under the implicit allow.
   *
   * TODO(B): when we add UI gating, branch here on `toolCall.kind`:
   * keep auto-allow for `'read'` / `'search'` / `'fetch'`; surface
   * `'edit'` / `'execute'` to the UI via SSE and await user choice.
   */
  private handleSessionRequestPermission(
    id: string | number,
    params: unknown,
  ): void {
    if (!params || typeof params !== 'object') {
      this.logger.warn(
        { id, canvasId: this.canvasId },
        'session/request_permission: missing params',
      );
      this.sendErrorReply(
        id,
        JSON_RPC_INVALID_PARAMS,
        'session/request_permission requires an object with `options[]`',
      );
      return;
    }
    const p = params as {
      toolCall?: { toolCallId?: unknown; title?: unknown; kind?: unknown };
      options?: unknown;
    };
    const options = Array.isArray(p.options)
      ? (p.options as PermissionOption[])
      : [];
    if (options.length === 0) {
      this.logger.warn(
        { id, canvasId: this.canvasId },
        'session/request_permission: empty options[]',
      );
      this.sendErrorReply(
        id,
        JSON_RPC_INVALID_PARAMS,
        'session/request_permission: `options[]` must be non-empty',
      );
      return;
    }

    const choice = pickPermissionOption(options);
    const toolCall = p.toolCall ?? {};
    this.logger.info(
      {
        id,
        canvasId: this.canvasId,
        toolCallId: (toolCall as { toolCallId?: unknown }).toolCallId,
        toolTitle: (toolCall as { title?: unknown }).title,
        toolKind: (toolCall as { kind?: unknown }).kind,
        choice: { optionId: choice.optionId, kind: choice.kind },
      },
      '[acp] session/request_permission auto-decided',
    );
    this.connection.send({
      jsonrpc: '2.0',
      id,
      result: {
        outcome: { outcome: 'selected', optionId: choice.optionId },
      },
    });
  }
}
