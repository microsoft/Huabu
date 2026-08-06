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
 * Bound to one opaque namespace scope (`opts.scopeName`, the L2
 * `namespace.name`); rebinding to another scope requires rebuilding the
 * client (enforced by session-registry).
 * The SDK owns request id correlation, schema validation, and handler
 * dispatch; we add a thin layer for long-lived per-session listeners
 * and orphan-update replay (see {@link AcpAgentClient.orphanUpdates}).
 */

import { randomUUID } from 'node:crypto';

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
  type ContentBlock as AcpContentBlock,
} from '@agentclientprotocol/sdk';

import type { AgentConnection, AcpMessage } from '@agenetes/agentlet-host';
import type {
  SessionUpdate as AcpSessionUpdate,
  PermissionOption as AcpPermissionOption,
  ToolCallContent as AcpToolCallContent,
  ToolCallLocation as AcpToolCallLocation,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';

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

/**
 * True when the agent's initialize response advertises support for
 * `session/load`. Permissive: any truthy value at `agentCapabilities.loadSession`
 * counts (spec defines it as a plain boolean, but some agents echo it
 * back inside a nested capability object).
 */
export function agentSupportsLoadSession(
  init: AcpInitializeResult | null | undefined,
): boolean {
  if (!init) return false;
  const caps = init.agentCapabilities;
  if (!caps || typeof caps !== 'object') return false;
  return Boolean((caps as Record<string, unknown>).loadSession);
}

/** Subset of the ACP session/new response we care about. */
export interface AcpNewSessionResult {
  sessionId: string;
  /**
   * Mode catalogue + current mode id, as published by the agent.
   * Shape: `{ availableModes: SessionMode[]; currentModeId: SessionModeId }`.
   * Optional because not every agent emits a mode list.
   */
  modes?: unknown;
  /**
   * Model catalogue + current model id (experimental ACP capability).
   * Shape: `{ availableModels: ModelInfo[]; currentModelId: ModelId }`.
   * Optional because the capability is unstable and many agents omit it.
   */
  models?: unknown;
  /** Free-form config knobs (Copilot publishes 4: model/mode/thought/auto). */
  configOptions?: unknown;
}

/**
 * Subset of the ACP `session/load` response. Shape mirrors
 * {@link AcpNewSessionResult} sans `sessionId` (the load caller already
 * knows it). All fields optional because some agents return an empty
 * object on successful resume.
 */
export interface AcpLoadSessionResult {
  modes?: unknown;
  models?: unknown;
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
   * The opaque namespace scope this client is bound to (the L2
   * `namespace.name`); scopes fs sandbox + permission checks. Optional
   * because the workload's namespace name may be empty ("no canvas") — the
   * fs sandbox rejects all fs/* calls when this is empty.
   */
  scopeName?: string;
  /** Optional logger; defaults to a no-op. */
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /**
   * Optional host port servicing an agent's `fs/read_text_file` request,
   * scoped to `scopeName`. This is a canvas-storage-coupled (L1) concern,
   * so the driver never implements it — the host injects it. When absent
   * the client rejects fs/read (method-not-found), which is the current
   * behaviour: the real host does NOT wire this today (external agents use
   * their own local read tools), so leaving it unset is an accepted known
   * issue tracked for a later milestone. A thrown error carrying a numeric
   * `code` is surfaced verbatim as the JSON-RPC error code.
   */
  fsReadTextFile?: (
    scopeName: string,
    params: ReadTextFileRequest,
  ) => ReadTextFileResponse;
}

/** No-op logger used when the host injects none. */
const noopClientLogger: NonNullable<AcpAgentClientOptions['logger']> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type SessionUpdateHandler = (update: AcpSessionUpdate) => void;

/**
 * Per-turn callback the caller installs (via {@link AcpAgentClient.prompt})
 * to surface an agent `session/request_permission` to the user. The
 * client suspends the agent's request until {@link AcpAgentClient.resolvePermission}
 * is called with the matching `requestId`. When NO notifier is installed
 * (e.g. session warm-up, or an out-of-turn request) the client falls
 * back to the auto-allow strategy ({@link pickPermissionOption}).
 */
export type PermissionNotifier = (req: {
  requestId: string;
  toolCall: {
    toolCallId?: string;
    title?: string;
    kind?: AcpToolKind;
    rawInput?: unknown;
    content?: AcpToolCallContent[];
    locations?: AcpToolCallLocation[];
  };
  options: AcpPermissionOption[];
}) => void;

/** User/timeout decision passed back to {@link AcpAgentClient.resolvePermission}. */
export type PermissionDecision =
  | { optionId: string; cancelled?: false }
  | { cancelled: true };

/** How long a suspended permission request waits before auto-cancelling. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Optional interceptor for raw `session/update` notifications. When
 * supplied to {@link streamFromAgentConnection} the adapter calls this
 * *instead of* forwarding the notification to the SDK's read pump,
 * effectively bypassing the SDK's strict `zSessionNotification` zod
 * parse for these messages.
 *
 * Why this exists:
 *   The SDK validates every `session/update` against the full union of
 *   spec'd variants and per-item shapes (e.g. `AvailableCommand` requires
 *   a non-null `description: string`). Real-world agents occasionally
 *   emit fields that fail strict validation — Claude Code / Gemini CLI
 *   may push slash commands with a missing or `null` description, or
 *   `sessionUpdate` discriminators that haven't been published in the
 *   spec yet. When the SDK's `parse()` throws, the WHOLE notification
 *   is silently dropped (only a `console.error` in the SDK), which
 *   manifested as a regression where the slash-command typeahead
 *   listed far fewer commands than before the SDK integration.
 *
 *   Intercepting here lets us route the raw update straight to our own
 *   permissive dispatcher (which already tolerates missing/empty
 *   description fields and unknown variants) while still letting the
 *   SDK own request/response correlation for everything else.
 *
 * Returns `true` when the interceptor consumed the message and the
 * adapter should NOT forward it to the SDK; `false` to fall through.
 */
type SessionUpdateInterceptor = (msg: AcpMessage) => boolean;

/**
 * Adapt an agentlet `AgentConnection` (`send` + `onMessage`) to the SDK
 * `Stream` shape. `close()` closes the readable, which makes the SDK
 * abort its connection and reject pending outgoing requests. Does NOT
 * call `conn.disconnect()` — connection lifecycle is owned by
 * the `@agenetes/agentlet-host` transport host.
 *
 * `interceptSessionUpdate` is invoked on every inbound message *before*
 * it reaches the SDK; returning `true` swallows the message (see
 * {@link SessionUpdateInterceptor}).
 */
function streamFromAgentConnection(
  conn: AgentConnection,
  interceptSessionUpdate?: SessionUpdateInterceptor,
): {
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
        if (interceptSessionUpdate && interceptSessionUpdate(msg)) {
          // Interceptor consumed the message — do not forward to SDK.
          return;
        }
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
   * Per-turn permission notifiers, keyed by sessionId. Installed by
   * {@link prompt} when the caller wants to gate permission via UI;
   * removed in the `prompt` `finally`. Absence ⇒ auto-allow.
   */
  private readonly permissionNotifiers = new Map<string, PermissionNotifier>();
  /**
   * Suspended `session/request_permission` calls awaiting a user (or
   * timeout) decision, keyed by the server-generated `requestId`.
   * Resolved via {@link resolvePermission}; cleared on shutdown / abort.
   */
  private readonly pendingPermissions = new Map<
    string,
    {
      sessionId: string;
      resolve: (decision: PermissionDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
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
  /** Namespace scope for sandbox + permission checks (= `namespace.name`). See AcpAgentClientOptions.scopeName. Empty string = "no scope" (fs/* will be rejected). */
  readonly scopeName: string;
  /** Injected host port for `fs/read_text_file`; see {@link AcpAgentClientOptions.fsReadTextFile}. */
  private readonly fsReadTextFile?: AcpAgentClientOptions['fsReadTextFile'];
  /**
   * Cached `initialize()` response. Populated by the first successful
   * {@link AcpAgentClient.initialize} call. Exposed via
   * {@link AcpAgentClient.initializeResult} so callers (notably
   * `service.ensureAcpSession`) can inspect `agentCapabilities` —
   * specifically `loadSession` — without re-issuing `initialize`.
   */
  private _initializeResult: AcpInitializeResult | null = null;

  constructor(connection: AgentConnection, opts: AcpAgentClientOptions) {
    this.scopeName = opts.scopeName ?? '';
    this.fsReadTextFile = opts.fsReadTextFile;
    // The ACP SDK's logger contract `(obj, msg) => void` aligns exactly
    // with pino's child logger surface, so callers can hand it a tagged
    // child logger directly — no shim layer needed. Defaults to no-op.
    this.logger = opts.logger ?? noopClientLogger;

    const { stream, close } = streamFromAgentConnection(connection, (msg) =>
      this.tryInterceptSessionUpdate(msg),
    );
    this.closeStream = close;
    this.sdk = new ClientSideConnection(
      (_agent: SdkAgent) => this.createClientHandler(),
      stream,
    );
    connection.onLifecycle((event) => {
      if (
        event.type === 'agent/suspended' ||
        event.type === 'agent/exited' ||
        event.type === 'agent/goodbye' ||
        event.type === 'agent/disconnected'
      ) {
        this.shutdown(event.type);
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Inject a cached `initializeResult` without calling `initialize()` over
   * the wire. Use when the agentlet daemon has already bootstrapped the
   * session — the result comes from the DataStore's `SessionRecord`.
   */
  seedFromRecord(initializeResult: AcpInitializeResult): void {
    this._initializeResult = initializeResult;
  }

  /** @deprecated Use {@link seedFromRecord} — the daemon already bootstraps. */
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
    this._initializeResult = result as AcpInitializeResult;
    return this._initializeResult;
  }

  /**
   * Cached initialize result. Available after `initialize()` resolves;
   * `null` before. Returned object is the same instance each call —
   * do not mutate.
   */
  get initializeResult(): AcpInitializeResult | null {
    return this._initializeResult;
  }

  /** @deprecated Use {@link seedFromRecord} — the daemon already bootstraps. */
  async newSession(opts: { cwd: string }): Promise<AcpNewSessionResult> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    const result = await this.sdk.newSession({
      cwd: opts.cwd,
      mcpServers: [],
    });
    return result as AcpNewSessionResult;
  }

  /**
   * @deprecated Use {@link seedFromRecord} — the daemon already bootstraps.
   *
   * Resume a previously-opened ACP session via `session/load`. Requires
   * the agent to advertise `agentCapabilities.loadSession: true` — call
   * {@link agentSupportsLoadSession} on {@link initializeResult} before
   * dispatching, since SDK rejects unsupported calls with a
   * method-not-found error.
   *
   * The agent typically REPLAYS the session's history as a stream of
   * `session/update` notifications before this promise resolves. The
   * stream-adapter routes those through {@link dispatchSessionUpdate}
   * exactly like real-time updates; with no listener yet installed they
   * land in {@link orphanUpdates} and a subsequent
   * {@link registerSessionListener} call drains them.
   *
   * Rejects when the agent does not recognise `sessionId` (e.g. agent
   * was itself restarted and lost session state). Callers should treat
   * rejection as "session is gone" and fall back to {@link newSession}.
   *
   * Returns the SDK's load response so callers can seed mode/model/
   * config catalogues — the spec mirrors `session/new` (modes / models /
   * configOptions all optional).
   */
  async loadSession(opts: {
    sessionId: string;
    cwd: string;
  }): Promise<AcpLoadSessionResult> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    const result = await this.sdk.loadSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: [],
    });
    return (result ?? {}) as AcpLoadSessionResult;
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
   *
   * `blocks` is the driver-native per-turn content: ACP content blocks
   * (text + image + …) passed straight to `session/prompt`. The host's
   * render closure is responsible for mapping its own content-part shapes
   * onto these ACP blocks, so the driver never sees host types.
   */
  async prompt(
    sessionId: string,
    blocks: AcpContentBlock[],
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
        // Blocks are already ACP content blocks (the host render closure
        // mapped them). Pass straight through.
        prompt: blocks,
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

  // ── Session-meta setters ──────────────────────────────────────────
  //
  // Thin wrappers around the SDK's `setSessionMode` / `setSessionModel`
  // / `setSessionConfigOption` JSON-RPC methods. The SDK validates the
  // request/response shapes against the generated zod schemas; we just
  // surface the calls so service.ts can wire them into REST endpoints.
  //
  // None of these methods mutate local `AcpSessionEntry` state — that's
  // the caller's job. A successful response from the agent should be
  // followed by a corresponding `session/update` notification (which
  // updates the entry through the normal dispatch path); the response
  // itself is only the agent's "I accepted the request" ack.

  /**
   * Send `session/set_mode` to switch the currently-active mode.
   * Resolves on the agent's ack; rejects if the agent rejects the
   * `modeId` (unknown id) or doesn't support modes at all.
   */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    await this.sdk.setSessionMode({ sessionId, modeId });
  }

  /**
   * Send `session/set_model` to switch the currently-active model
   * (experimental ACP capability — SDK exposes it as
   * `unstable_setSessionModel`). Rejects with method-not-found when
   * the agent does not support model switching.
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    await this.sdk.unstable_setSessionModel({ sessionId, modelId });
  }

  /**
   * Send `session/set_config_option` to change a single config knob.
   * `value` is `boolean` for boolean options and `string` (the value
   * id) for select options — the SDK enforces the shape based on the
   * option's type at parse time.
   */
  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    if (this._closed) throw new Error('AcpAgentClient is closed');
    if (typeof value === 'boolean') {
      await this.sdk.setSessionConfigOption({
        sessionId,
        configId,
        type: 'boolean',
        value,
      });
    } else {
      await this.sdk.setSessionConfigOption({
        sessionId,
        configId,
        value,
      });
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
      // `session/update` is intercepted in the stream adapter BEFORE
      // it reaches the SDK (see {@link tryInterceptSessionUpdate}), so
      // this handler is a defensive fallback that should never fire in
      // practice. We still route through `dispatchSessionUpdate` so
      // that if anyone ever wires the SDK to call us directly (e.g.
      // during tests, or if the interceptor is disabled), the message
      // still lands in the same dispatch path.
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.logger.debug(
          { sessionId: params.sessionId },
          'sessionUpdate handler hit via SDK path (interceptor missed?)',
        );
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
          { scopeName: this.scopeName },
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

  /**
   * Stream-adapter hook (see {@link streamFromAgentConnection}).
   *
   * Detects raw `session/update` notifications coming from the agent
   * and routes them directly to {@link dispatchSessionUpdate}, bypassing
   * the SDK's strict `zSessionNotification.parse` (which would silently
   * drop the entire notification on any per-item shape mismatch, e.g.
   * an `AvailableCommand` with a missing/`null` `description`).
   *
   * Permissive checks here are intentionally minimal: the only things
   * we need from the wire shape are `sessionId: string` and an `update`
   * object carrying a `sessionUpdate` discriminator. Per-variant shape
   * validation is the downstream consumer's job — `service.ts`
   * (`handleSessionMetaUpdate`) and `translator.ts`
   * (`acpUpdateToStreamEvent`) both already `safeParse` and tolerate
   * missing optional fields.
   *
   * Returns `true` when the message is a `session/update` (and was
   * therefore consumed), `false` for every other message kind so the
   * SDK keeps owning request/response correlation.
   */
  private tryInterceptSessionUpdate(msg: AcpMessage): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as unknown as Record<string, unknown>;
    // Must be a notification (has `method`, no `id`).
    if (m.method !== 'session/update') return false;
    if ('id' in m) return false;
    const params = m.params;
    if (!params || typeof params !== 'object') {
      this.logger.warn(
        { params },
        'session/update notification has no params — dropping',
      );
      return true;
    }
    const p = params as Record<string, unknown>;
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
    const update = p.update;
    if (!sessionId) {
      this.logger.warn(
        { params: p },
        'session/update notification missing sessionId — dropping',
      );
      return true;
    }
    if (!update || typeof update !== 'object') {
      this.logger.warn(
        { sessionId, update },
        'session/update notification missing `update` body — dropping',
      );
      return true;
    }
    this.dispatchSessionUpdate(sessionId, update as AcpSessionUpdate);
    return true;
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
      { method: 'fs/read_text_file', scopeName: this.scopeName },
      '[acp] incoming agent request',
    );
    // The fs sandbox is a canvas-storage (L1) concern injected by the
    // host. When unwired (the current default — see
    // AcpAgentClientOptions.fsReadTextFile) reject with method-not-found,
    // exactly as an agent hitting fs/read with no canvas scope would see.
    if (!this.fsReadTextFile) {
      this.logger.warn(
        { scopeName: this.scopeName },
        'fs/read_text_file requested but no host fs port is wired — rejecting',
      );
      throw new RequestError(
        JSON_RPC_METHOD_NOT_FOUND,
        'fs/read_text_file is not available',
      );
    }
    try {
      return this.fsReadTextFile(this.scopeName, params);
    } catch (e) {
      // A port may throw an error carrying a numeric JSON-RPC `code`
      // (e.g. the host's FsCapabilityError) — surface it verbatim.
      const code = (e as { code?: unknown }).code;
      const message = e instanceof Error ? e.message : String(e);
      if (typeof code === 'number') {
        this.logger.warn(
          { scopeName: this.scopeName, code, message },
          'fs/read_text_file refused',
        );
        throw new RequestError(code, message);
      }
      this.logger.error(
        { scopeName: this.scopeName, err: message },
        'fs/read_text_file failed with unexpected error',
      );
      throw new RequestError(
        JSON_RPC_INTERNAL_ERROR,
        'fs/read_text_file: internal error',
      );
    }
  }

  /**
   * Permission handler.
   *
   * Two paths:
   *  1. A per-turn notifier is installed for this session ⇒ surface the
   *     request to the user (via the notifier), suspend until
   *     {@link resolvePermission} answers, a {@link PERMISSION_TIMEOUT_MS}
   *     timeout fires, or the turn aborts. The user's choice (or a
   *     cancel) is returned to the agent.
   *  2. No notifier (session warm-up, out-of-turn request) ⇒ fall back to
   *     auto-allow via {@link pickPermissionOption}. Sediment's ACP runtime
   *     is local-agent only; OS file permissions are the real boundary.
   */
  private async handleRequestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.logger.info(
      { method: 'session/request_permission', scopeName: this.scopeName },
      '[acp] incoming agent request',
    );
    const options = (params.options ?? []) as PermissionOption[];
    if (options.length === 0) {
      this.logger.warn(
        { scopeName: this.scopeName },
        'session/request_permission: empty options[]',
      );
      throw new RequestError(
        JSON_RPC_INVALID_PARAMS,
        'session/request_permission: `options[]` must be non-empty',
      );
    }
    const toolCall = params.toolCall ?? {};
    const notifier = this.permissionNotifiers.get(params.sessionId);

    // No UI gate for this turn — preserve auto-allow behaviour.
    if (!notifier) {
      const choice = pickPermissionOption(options);
      this.logger.info(
        {
          scopeName: this.scopeName,
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

    // UI gate: suspend until the user (or a timeout/abort) decides.
    const requestId = randomUUID();
    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingPermissions.delete(requestId)) {
          this.logger.warn(
            { requestId, scopeName: this.scopeName },
            'session/request_permission timed out — cancelling',
          );
          resolve({ cancelled: true });
        }
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, {
        sessionId: params.sessionId,
        resolve,
        timer,
      });
      try {
        const tc = toolCall as {
          toolCallId?: string;
          title?: string;
          kind?: AcpToolKind;
          rawInput?: unknown;
          content?: AcpToolCallContent[] | null;
          locations?: AcpToolCallLocation[] | null;
        };
        notifier({
          requestId,
          toolCall: {
            toolCallId: tc.toolCallId,
            title: tc.title,
            kind: tc.kind,
            rawInput: tc.rawInput,
            content: tc.content ?? undefined,
            locations: tc.locations ?? undefined,
          },
          options: options as unknown as AcpPermissionOption[],
        });
      } catch (e) {
        // Notifier throwing must not leak a dangling pending entry.
        if (this.pendingPermissions.delete(requestId)) {
          clearTimeout(timer);
        }
        this.logger.warn(
          { requestId, err: String(e) },
          'permission notifier threw — cancelling',
        );
        resolve({ cancelled: true });
      }
    });

    if (decision.cancelled) {
      this.logger.info(
        { requestId, scopeName: this.scopeName },
        '[acp] session/request_permission cancelled',
      );
      return { outcome: { outcome: 'cancelled' } };
    }
    this.logger.info(
      {
        requestId,
        scopeName: this.scopeName,
        optionId: decision.optionId,
      },
      '[acp] session/request_permission resolved by user',
    );
    return {
      outcome: { outcome: 'selected', optionId: decision.optionId },
    };
  }

  /** Helper: log + throw method_not_found for an unsupported terminal/* call. */
  private rejectTerminal(method: string): never {
    this.logger.warn(
      { method, scopeName: this.scopeName },
      'agent called unsupported terminal/* method',
    );
    throw new RequestError(
      JSON_RPC_METHOD_NOT_FOUND,
      `Method not implemented: ${method}`,
    );
  }
}
