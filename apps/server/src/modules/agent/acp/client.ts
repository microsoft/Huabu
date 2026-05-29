/**
 * AcpAgentClient — drives one ACP session over a single agentlet
 * `AgentConnection`, layered on top of `@agentclientprotocol/sdk`'s
 * `ClientSideConnection`.
 *
 * Capability handlers wired into the SDK `Client`:
 *   - `fs/read_text_file`          → capabilities/fs.ts (sandboxed)
 *   - `fs/write_text_file`         → reject -32601 (read-only)
 *   - `terminal/*`                 → reject -32601 (never implemented)
 *   - `session/request_permission` → auto-allow (local-agent threat model)
 *
 * Bound to one Sediment canvas (`opts.canvasId`); rebinding to another
 * canvas requires rebuilding the client (enforced by session-registry).
 * The SDK owns request id correlation, schema validation, and handler
 * dispatch; we add a thin layer for long-lived per-session listeners
 * and orphan-update replay (see {@link AcpAgentClient.orphanUpdates}).
 */

import {
  ClientSideConnection,
  RequestError,
  type Agent as SdkAgent,
  type Client as SdkClient,
  type AnyMessage,
  type Stream,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { FsCapabilityError, handleFsReadTextFile } from './capabilities/fs.js';

import type { AgentConnection, AcpMessage } from '@agentlet/protocol';
import type { AcpSessionUpdate } from '@sediment/shared';

const ACP_PROTOCOL_VERSION = 1;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/** ACP `PermissionOption` (subset) — `optionId` is echoed back in the response. */
interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: 'allow_always' | 'allow_once' | 'reject_once' | 'reject_always';
}

/**
 * Pick the most-permissive option: `allow_always` > `allow_once` > first
 * non-`reject_*` > first. Exported for testing.
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
   * Canvas this client is bound to; scopes fs sandbox + permission checks.
   * Optional because `agentRequestSchema.canvasId` is optional — the fs
   * sandbox rejects all fs/* calls when this is empty.
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

/**
 * Adapt an agentlet `AgentConnection` (`send` + `onMessage`) to the SDK
 * `Stream` shape. `close()` closes the readable, which makes the SDK
 * abort its connection and reject pending outgoing requests. Does NOT
 * call `conn.disconnect()` — connection lifecycle is owned by
 * `server-mount.ts`.
 */
function streamFromAgentConnection(conn: AgentConnection): {
  stream: Stream;
  close: () => void;
} {
  let readableController: ReadableStreamDefaultController<AnyMessage> | null =
    null;
  let closed = false;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;
      conn.onMessage((msg) => {
        if (closed) return;
        try {
          controller.enqueue(msg as unknown as AnyMessage);
        } catch {
          // Controller already closed — ignore.
        }
      });
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      if (closed) return;
      // agentlet's `AcpMessage` and SDK's `AnyMessage` are both
      // JSON-RPC 2.0 messages — structurally compatible.
      conn.send(msg as unknown as AcpMessage);
    },
  });

  function close() {
    if (closed) return;
    closed = true;
    try {
      readableController?.close();
    } catch {
      // Already closed — ignore.
    }
  }

  return { stream: { readable, writable }, close };
}

export class AcpAgentClient {
  private readonly sdk: ClientSideConnection;
  private readonly closeStream: () => void;
  /** Turn-scoped handlers: installed on `prompt()`, removed in `finally`. */
  private readonly updateHandlers = new Map<string, SessionUpdateHandler>();
  /**
   * Long-lived per-session listeners (via {@link registerSessionListener}).
   * Fire in addition to the turn handler — needed for out-of-turn
   * notifications like `available_commands_update`.
   */
  private readonly sessionListeners = new Map<
    string,
    Set<SessionUpdateHandler>
  >();
  /**
   * Bounded ring buffer of `session/update`s that arrived before any
   * handler/listener existed for their sessionId. Drained by the next
   * {@link registerSessionListener} call.
   *
   * Race: many agents push `available_commands_update` before their
   * `session/new` response, so callers can't install a listener in time.
   * Without buffering, the slash-command list is permanently empty.
   */
  private readonly orphanUpdates = new Map<string, AcpSessionUpdate[]>();
  private static readonly MAX_ORPHAN_UPDATES_PER_SESSION = 32;
  private _closed = false;
  private readonly logger: NonNullable<AcpAgentClientOptions['logger']>;
  /** Canvas scope for sandbox + permission checks. See AcpAgentClientOptions.canvasId. Empty string = “no canvas” (fs/* will be rejected). */
  readonly canvasId: string;

  constructor(connection: AgentConnection, opts: AcpAgentClientOptions) {
    this.canvasId = opts.canvasId ?? '';
    this.logger = opts.logger ?? {
      debug: (o, m) => console.debug('[acp-client]', m ?? '', o),
      info: (o, m) => console.info('[acp-client]', m ?? '', o),
      warn: (o, m) => console.warn('[acp-client]', m ?? '', o),
      error: (o, m) => console.error('[acp-client]', m ?? '', o),
    };

    const { stream, close } = streamFromAgentConnection(connection);
    this.closeStream = close;
    this.sdk = new ClientSideConnection(
      (_agent: SdkAgent) => this.createClientHandler(),
      stream,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async initialize(): Promise<AcpInitializeResult> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    const result = await this.sdk.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        // Write would race with live canvas UI; terminal is delegated
        // to the agent's own local Bash tool.
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'sediment',
        version: '0.1.0',
      },
    });
    return result as AcpInitializeResult;
  }

  async newSession(opts: { cwd: string }): Promise<string> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    const result = await this.sdk.newSession({
      cwd: opts.cwd,
      mcpServers: [],
    });
    return (result as AcpNewSessionResult).sessionId;
  }

  /**
   * Send a user prompt. Each `session/update` notification arriving during
   * the turn is forwarded to `onUpdate`. Promise resolves when the agent
   * returns the prompt response (i.e. turn is over). If `signal` aborts,
   * a `session/cancel` notification is sent and the promise rejects.
   *
   * When `onPermissionRequest` is supplied, agent
   * `session/request_permission` calls during this turn are surfaced to it
   * and suspended until {@link resolvePermission} answers (or a timeout /
   * abort cancels them). Without it, permission requests auto-allow.
   */
  async prompt(
    sessionId: string,
    text: string,
    onUpdate: SessionUpdateHandler,
    signal?: AbortSignal,
    onPermissionRequest?: PermissionNotifier,
  ): Promise<AcpPromptResult> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    if (this.updateHandlers.has(sessionId)) {
      throw new Error(
        `AcpAgentClient: another prompt is already in flight for session ${sessionId}`,
      );
    }
    this.updateHandlers.set(sessionId, onUpdate);
    if (onPermissionRequest) {
      this.permissionNotifiers.set(sessionId, onPermissionRequest);
    }

    const abortListener = () => {
      this.cancelPendingPermissionsForSession(sessionId, 'aborted');
      void this.cancel(sessionId).catch((e) => {
        this.logger.warn(
          { err: String(e) },
          'session/cancel after abort failed',
        );
      });
    };
    signal?.addEventListener('abort', abortListener);

    try {
      const result = await this.sdk.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      return result as AcpPromptResult;
    } finally {
      this.updateHandlers.delete(sessionId);
      this.permissionNotifiers.delete(sessionId);
      this.cancelPendingPermissionsForSession(sessionId, 'turn_ended');
      signal?.removeEventListener('abort', abortListener);
    }
  }

  /** Notify the agent to abort the current turn. Fire-and-forget. */
  async cancel(sessionId: string): Promise<void> {
    if (this._closed) return;
    try {
      await this.sdk.cancel({ sessionId });
    } catch (e) {
      // SDK rejects if the underlying stream is closed mid-flight;
      // a cancel notification is best-effort anyway.
      this.logger.debug({ err: String(e) }, 'session/cancel send failed');
    }
  }

  /**
   * Install a long-lived listener for every `session/update` on `sessionId`,
   * regardless of whether a turn is in flight. Multiple listeners supported;
   * returns a disposer. Synchronously drains and replays {@link orphanUpdates}
   * for `sessionId` to the new handler before returning.
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
    // Drain after add so a re-entrant register sees a stable state.
    // Only the just-registered handler gets replays; listeners that
    // race-registered later were attached AFTER the orphan arrived.
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

  /**
   * Resolve a suspended `session/request_permission` by `requestId`.
   * Returns `true` when a pending request matched and was settled; `false`
   * when none matched (already answered, timed out, or session ended).
   *
   * Idempotent: a second call for the same `requestId` is a no-op `false`.
   */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  /** Cancel every pending permission for one session (turn end / abort). */
  private cancelPendingPermissionsForSession(
    sessionId: string,
    reason: string,
  ): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(requestId);
      clearTimeout(pending.timer);
      this.logger.debug(
        { requestId, sessionId, reason },
        'permission request cancelled',
      );
      pending.resolve({ cancelled: true });
    }
  }

  /** Cancel ALL pending permissions (used on shutdown). */
  private cancelAllPendingPermissions(reason: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      this.logger.debug(
        { requestId, sessionId: pending.sessionId, reason },
        'permission request cancelled',
      );
      pending.resolve({ cancelled: true });
    }
    this.pendingPermissions.clear();
  }

  /**
   * Close the SDK connection (rejects pending requests via its abort
   * signal) and clear dispatch state.
   */
  shutdown(reason = 'client_shutdown'): void {
    if (this._closed) return;
    this._closed = true;
    this.logger.debug({ reason }, 'AcpAgentClient.shutdown');
    this.cancelAllPendingPermissions(reason);
    this.permissionNotifiers.clear();
    this.updateHandlers.clear();
    this.sessionListeners.clear();
    this.orphanUpdates.clear();
    this.closeStream();
  }

  /** True if this client has been closed via `shutdown()`. */
  get isClosed(): boolean {
    return this._closed;
  }

  // ── SDK Client handler ──────────────────────────────────────────────────

  /**
   * Build the {@link SdkClient} handed to `ClientSideConnection`. Thrown
   * {@link RequestError}s are converted to JSON-RPC error responses.
   */
  private createClientHandler(): SdkClient {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.dispatchSessionUpdate(
          params.sessionId,
          params.update as unknown as AcpSessionUpdate,
        );
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        return this.handleRequestPermission(params);
      },
      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        return this.handleFsRead(params);
      },
      writeTextFile: async (
        _params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        // Advertised as unsupported, but reject loudly if called anyway
        // so operators see what was attempted.
        this.logger.warn(
          { canvasId: this.canvasId },
          'agent attempted fs/write_text_file — read-only',
        );
        throw new RequestError(
          JSON_RPC_METHOD_NOT_FOUND,
          'fs/write_text_file is not implemented (read-only)',
        );
      },
      // terminal/* — advertised false; reject for diagnostic visibility.
      createTerminal: async () => {
        this.rejectTerminal('terminal/create');
      },
      terminalOutput: async () => {
        this.rejectTerminal('terminal/output');
      },
      releaseTerminal: async () => {
        this.rejectTerminal('terminal/release');
      },
      waitForTerminalExit: async () => {
        this.rejectTerminal('terminal/wait_for_exit');
      },
      killTerminal: async () => {
        this.rejectTerminal('terminal/kill');
      },
    };
  }

  /** Fan out one validated `session/update` to turn handler + listeners + orphan buffer. */
  private dispatchSessionUpdate(
    sessionId: string,
    update: AcpSessionUpdate,
  ): void {
    const turnHandler = this.updateHandlers.get(sessionId);
    const listeners = this.sessionListeners.get(sessionId);
    if (turnHandler) {
      try {
        turnHandler(update);
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
          listener(update);
        } catch (e) {
          this.logger.warn(
            { sessionId, err: String(e) },
            'session/update listener threw',
          );
        }
      }
    }
    if (!turnHandler && (!listeners || listeners.size === 0)) {
      // No handler — buffer for later replay. Ring drops oldest on overflow.
      let buf = this.orphanUpdates.get(sessionId);
      if (!buf) {
        buf = [];
        this.orphanUpdates.set(sessionId, buf);
      }
      buf.push(update);
      if (buf.length > AcpAgentClient.MAX_ORPHAN_UPDATES_PER_SESSION) {
        buf.shift();
      }
      this.logger.debug(
        {
          sessionId,
          sessionUpdate: (update as { sessionUpdate?: unknown }).sessionUpdate,
          bufferedCount: buf.length,
        },
        'session/update buffered (no handler yet)',
      );
    }
  }

  /**
   * `fs/read_text_file` dispatcher. {@link FsCapabilityError} keeps its
   * own code+message; anything else collapses to -32603.
   */
  private handleFsRead(params: ReadTextFileRequest): ReadTextFileResponse {
    // Info-level so we can see whether external agents actually exercise
    // ACP fs vs. their own native tools. Demote once integration is stable.
    this.logger.info(
      { method: 'fs/read_text_file', canvasId: this.canvasId },
      '[acp] incoming agent request',
    );
    try {
      return handleFsReadTextFile(
        this.canvasId,
        params,
      ) as ReadTextFileResponse;
    } catch (e) {
      if (e instanceof FsCapabilityError) {
        this.logger.warn(
          { canvasId: this.canvasId, code: e.code, message: e.message },
          'fs/read_text_file refused',
        );
        throw new RequestError(e.code, e.message);
      }
      this.logger.error(
        {
          canvasId: this.canvasId,
          err: e instanceof Error ? e.message : String(e),
        },
        'fs/read_text_file failed with unexpected error',
      );
      throw new RequestError(
        JSON_RPC_INTERNAL_ERROR,
        'fs/read_text_file: internal error',
      );
    }
  }

  /**
   * Auto-allow handler. Sediment's ACP runtime is local-agent only; OS
   * file permissions are the real boundary, and per-call UI prompts are
   * unusable (Copilot can call Read 10+ times per turn). Single insertion
   * point when stricter policy is needed for remote/sandboxed deploys.
   *
   * TODO(B): branch on `toolCall.kind` to gate `'edit'`/`'execute'` via UI.
   */
  private handleRequestPermission(
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    this.logger.info(
      { method: 'session/request_permission', canvasId: this.canvasId },
      '[acp] incoming agent request',
    );
    const options = (params.options ?? []) as PermissionOption[];
    if (options.length === 0) {
      this.logger.warn(
        { canvasId: this.canvasId },
        'session/request_permission: empty options[]',
      );
      throw new RequestError(
        JSON_RPC_INVALID_PARAMS,
        'session/request_permission: `options[]` must be non-empty',
      );
    }
    const choice = pickPermissionOption(options);
    const toolCall = params.toolCall ?? {};
    this.logger.info(
      {
        canvasId: this.canvasId,
        toolCallId: (toolCall as { toolCallId?: unknown }).toolCallId,
        toolTitle: (toolCall as { title?: unknown }).title,
        toolKind: (toolCall as { kind?: unknown }).kind,
        choice: { optionId: choice.optionId, kind: choice.kind },
      },
      '[acp] session/request_permission auto-decided',
    );
    return {
      outcome: { outcome: 'selected', optionId: choice.optionId },
    };
  }

  /** Helper: log + throw method_not_found for an unsupported terminal/* call. */
  private rejectTerminal(method: string): never {
    this.logger.warn(
      { method, canvasId: this.canvasId },
      'agent called unsupported terminal/* method',
    );
    throw new RequestError(
      JSON_RPC_METHOD_NOT_FOUND,
      `Method not implemented: ${method}`,
    );
  }
}
