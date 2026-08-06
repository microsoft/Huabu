import type { JsonRpcMessage } from '@agentlet/protocol'
import type { AgentProcess } from './agent-process.js'
import type { Logger } from './logger.js'

/**
 * Grace window (ms) to keep collecting `session/update` notifications after the
 * `session/new` response arrives. Copilot pushes `available_commands_update`
 * within ~1ms of the response (occasionally just after it), so a short window
 * reliably captures it without meaningfully delaying bootstrap (the spawn
 * itself already takes seconds).
 */
const SESSION_NEW_NOTIFICATION_GRACE_MS = 300

/**
 * No grace window for `initialize`: no known agent pushes `session/update`
 * notifications during initialize (the session does not yet exist), but we
 * still route the call through the collector so any unexpected notification
 * is captured rather than silently dropped. graceMs=0 means: resolve as soon
 * as the response arrives, no extra wait.
 */
const INITIALIZE_NOTIFICATION_GRACE_MS = 0

/**
 * Default per-request timeout (ms) for bootstrap calls. Generous to tolerate
 * slow agent cold starts (e.g. Copilot taking tens of seconds to answer
 * `initialize` on first launch).
 */
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 90_000

const SESSION_RESUME_UNAVAILABLE_RPC_CODES = new Set([
  -32601, // Method not found.
  -32602, // Invalid session identifier/parameters.
  -32002, // ACP resource not found.
])

export class SessionResumeUnavailableError extends Error {
  readonly code = 'session_resume_unavailable' as const

  constructor(message: string) {
    super(message)
    this.name = 'SessionResumeUnavailableError'
  }
}

function throwResumeError(
  method: 'session/resume' | 'session/load',
  sessionId: string,
  error: { code: number; message: string },
): never {
  const message = `${method} failed for session ${sessionId}: ${JSON.stringify(error)}`
  if (SESSION_RESUME_UNAVAILABLE_RPC_CODES.has(error.code)) {
    throw new SessionResumeUnavailableError(message)
  }
  throw new Error(message)
}

/**
 * Result of a successful ACP session bootstrap (initialize + session/new or session/load/resume).
 * Stored as the "agent session profile" and reported to the server.
 */
export interface SessionProfile {
  /** The active ACP sessionId */
  sessionId: string
  /** Whether the agent supports session/load */
  supportsLoad: boolean
  /** Whether the agent supports session/resume */
  supportsResume: boolean
  /** The full ACP initialize response */
  initializeResult: unknown
  /**
   * The full ACP `session/new` response, when this profile came from a
   * freshly-created session (absent on resume/load). Stored opaquely —
   * agentlet does not interpret its contents. The ACP spec allows agents
   * (e.g. Copilot) to inline `models` / `modes` / `configOptions` here
   * instead of pushing them via later `session/update` notifications, so
   * the consumer (host) reads them from this blob to seed its UI without
   * waiting for the first prompt.
   */
  newSessionResult?: unknown
  /**
   * `session/update` notifications captured during `session/new` (and a short
   * grace window after its response). Some agents (e.g. Copilot) push
   * `available_commands_update` within a millisecond of the session/new
   * response — sometimes just before it — so it would otherwise be dropped in
   * the gap before the relay attaches its live listener. The daemon replays
   * these to the host the moment the relay connects.
   */
  bootstrapNotifications?: JsonRpcMessage[]
}

export interface BootstrapOptions {
  /** Working directory to pass to session lifecycle calls */
  cwd: string
  /** Timeout for each request in ms */
  timeout?: number
  /**
   * If provided, resume an existing session instead of creating a new one.
   * The bootstrap will use session/resume (preferred) or session/load based on agent capabilities.
   */
  sessionId?: string
}

/**
 * Perform ACP session bootstrap on a spawned agent process.
 * Sends `initialize` then one of `session/new`, `session/resume`, or `session/load`.
 * Returns the session profile needed for bridge/hello.
 */
export async function bootstrapSession(
  agent: AgentProcess,
  options: BootstrapOptions,
  logger: Logger,
): Promise<SessionProfile> {
  const timeout = options.timeout ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS

  // 1. Send initialize. Routed through the collector helper so any unexpected
  // notification that arrives during initialize is captured (and replayed by
  // the daemon) instead of being silently dropped by an id-only handler.
  logger.info('session_bootstrap_initialize', { cwd: options.cwd })
  const initResponse = await sendRequestCollectingNotifications(agent, 1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'agentlet', version: '1.0.0' },
  }, timeout, INITIALIZE_NOTIFICATION_GRACE_MS)

  if (!initResponse.result) {
    throw new Error(`initialize failed: ${JSON.stringify(initResponse.error ?? 'no result')}`)
  }

  if (initResponse.notifications.length > 0) {
    logger.info('session_bootstrap_initialize_notifications', {
      count: initResponse.notifications.length,
      methods: initResponse.notifications.map((n) => (n as { method?: string }).method),
    })
  }

  const initResult = initResponse.result as Record<string, unknown>
  const agentCapabilities = initResult.agentCapabilities as Record<string, unknown> | undefined
  const supportsLoad = agentCapabilities?.loadSession === true
  const sessionCapabilities = agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined
  const supportsResume = sessionCapabilities?.resume != null

  logger.info('session_bootstrap_initialized', {
    supportsLoad,
    supportsResume,
    agentInfo: initResult.agentInfo,
    protocolVersion: initResult.protocolVersion,
  })

  // 2. Session lifecycle: new, resume, or load
  let sessionId: string
  let newSessionResult: unknown
  // Seed with anything captured during initialize so replay order matches
  // wire arrival order (initialize-time notifications first, session/new
  // notifications second).
  let bootstrapNotifications: JsonRpcMessage[] = [...initResponse.notifications]

  if (options.sessionId) {
    // Resuming an existing session
    sessionId = await bootstrapResumeOrLoad(agent, options, { supportsLoad, supportsResume }, logger, timeout)
  } else {
    // Creating a new session
    const created = await bootstrapNew(agent, options, logger, timeout)
    sessionId = created.sessionId
    newSessionResult = created.newSessionResult
    bootstrapNotifications.push(...created.notifications)
  }

  logger.info('session_bootstrap_complete', { sessionId, supportsLoad, supportsResume })

  return {
    sessionId,
    supportsLoad,
    supportsResume,
    initializeResult: initResult,
    newSessionResult,
    bootstrapNotifications,
  }
}

/**
 * Create a new ACP session via session/new.
 *
 * Returns both the sessionId and the full opaque response so the caller
 * can forward inline `models` / `modes` / `configOptions` (if the agent
 * provides them) to the host without re-issuing session/new.
 */
async function bootstrapNew(
  agent: AgentProcess,
  options: BootstrapOptions,
  logger: Logger,
  timeout: number,
): Promise<{ sessionId: string; newSessionResult: unknown; notifications: JsonRpcMessage[] }> {
  logger.info('session_bootstrap_session_new', { cwd: options.cwd })
  const response = await sendRequestCollectingNotifications(agent, 2, 'session/new', {
    cwd: options.cwd,
    mcpServers: [],
  }, timeout, SESSION_NEW_NOTIFICATION_GRACE_MS)

  if (!response.result) {
    throw new Error(`session/new failed: ${JSON.stringify(response.error ?? 'no result')}`)
  }

  const result = response.result as Record<string, unknown>
  const sessionId = result.sessionId as string
  if (!sessionId) {
    throw new Error('session/new response missing sessionId')
  }
  if (response.notifications.length > 0) {
    logger.info('session_bootstrap_captured_notifications', {
      count: response.notifications.length,
      methods: response.notifications.map((n) => (n as { method?: string }).method),
    })
  }
  return { sessionId, newSessionResult: result, notifications: response.notifications }
}

/**
 * Resume an existing ACP session via session/resume (preferred) or session/load.
 *
 * session/resume: fast, no history replay.
 * session/load: replays conversation history via session/update notifications.
 *   These notifications arrive before the response, so we buffer and discard them
 *   during bootstrap (the server/host already has the history from its store).
 */
async function bootstrapResumeOrLoad(
  agent: AgentProcess,
  options: BootstrapOptions,
  caps: { supportsLoad: boolean; supportsResume: boolean },
  logger: Logger,
  timeout: number,
): Promise<string> {
  const sessionId = options.sessionId!
  const sessionParams = {
    sessionId,
    cwd: options.cwd,
    mcpServers: [],
  }

  if (caps.supportsResume) {
    // Prefer session/resume — no history replay needed
    logger.info('session_bootstrap_session_resume', { sessionId, cwd: options.cwd })
    const response = await sendRequest(agent, 2, 'session/resume', sessionParams, timeout)
    if (response.error) throwResumeError('session/resume', sessionId, response.error)
    if (response.result === undefined) throw new Error('session/resume returned no result')
    return sessionId
  }

  if (caps.supportsLoad) {
    // Fall back to session/load — must handle session/update notifications during load
    logger.info('session_bootstrap_session_load', { sessionId, cwd: options.cwd })
    const response = await sendRequestWithNotificationDrain(agent, 2, 'session/load', sessionParams, timeout, logger)
    if (response.error) throwResumeError('session/load', sessionId, response.error)
    if (response.result === undefined) throw new Error('session/load returned no result')
    return sessionId
  }

  throw new SessionResumeUnavailableError(
    `Cannot resume session ${sessionId}: agent supports neither session/resume nor session/load`
  )
}

/**
 * Send a JSON-RPC request to the agent process and wait for the matching response.
 */
function sendRequest(
  agent: AgentProcess,
  id: number,
  method: string,
  params: unknown,
  timeout: number,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`ACP request '${method}' timed out after ${timeout}ms`))
    }, timeout)

    const handler = (data: unknown) => {
      const msg = data as JsonRpcMessage
      if ('id' in msg && msg.id === id) {
        cleanup()
        if ('error' in msg && msg.error) {
          resolve({ error: msg.error })
        } else if ('result' in msg) {
          resolve({ result: msg.result })
        } else {
          resolve({})
        }
      }
    }

    function cleanup() {
      clearTimeout(timer)
      agent.removeListener('message', handler)
    }

    agent.on('message', handler)

    const request: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      id,
      params: params as Record<string, unknown>,
    }

    const written = agent.write(request)
    if (!written) {
      cleanup()
      reject(new Error(`Failed to write '${method}' to agent stdin`))
    }
  })
}

/**
 * Send a JSON-RPC request and collect any `session/update` notifications that
 * arrive during the call — both BEFORE the response and within a short grace
 * window AFTER it. Used for session/new: agents like Copilot push the
 * `available_commands_update` notification within a millisecond of the
 * session/new response (sometimes just before it), so a plain handler that only
 * matches the response id would drop it. Returning the collected notifications
 * lets the daemon replay them to the host the moment the relay connects,
 * instead of losing them in the bootstrap gap.
 */
function sendRequestCollectingNotifications(
  agent: AgentProcess,
  id: number,
  method: string,
  params: unknown,
  timeout: number,
  graceMs: number,
): Promise<{ result?: unknown; error?: { code: number; message: string }; notifications: JsonRpcMessage[] }> {
  return new Promise((resolve, reject) => {
    const notifications: JsonRpcMessage[] = []
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`ACP request '${method}' timed out after ${timeout}ms`))
    }, timeout)

    const finalize = (payload: { result?: unknown; error?: { code: number; message: string } }) => {
      // Snapshot before resolving so any late append (during the deferred
      // cleanup window below) does not mutate the caller's view.
      const snapshot = notifications.slice()
      resolve({ ...payload, notifications: snapshot })
      // Defer listener removal by one microtask so the awaiting caller can
      // synchronously attach its own listener before we detach — closing the
      // gap where a notification could arrive with no subscriber. Microtasks
      // drain before the event loop processes the next pipe read, so no
      // 'message' event can fire between resolve and the caller attaching.
      queueMicrotask(cleanup)
    }

    const settle = (payload: { result?: unknown; error?: { code: number; message: string } }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Error path: short-circuit. No need to wait the grace window for
      // notifications that wouldn't matter — the caller will throw.
      // Grace=0 path: caller opted out (e.g. initialize), resolve immediately.
      if (payload.error || graceMs <= 0) {
        finalize(payload)
        return
      }
      // Success path: keep collecting for a short grace window so we also
      // catch notifications emitted immediately AFTER the response.
      graceTimer = setTimeout(() => {
        graceTimer = null
        finalize(payload)
      }, graceMs)
    }

    const handler = (data: unknown) => {
      const msg = data as JsonRpcMessage
      if ('id' in msg && msg.id === id) {
        if ('error' in msg && msg.error) {
          settle({ error: msg.error })
        } else if ('result' in msg) {
          settle({ result: msg.result })
        } else {
          settle({})
        }
        return
      }
      // Otherwise it's a notification (e.g. available_commands_update) — keep it.
      if ('method' in msg && !('id' in msg)) {
        notifications.push(msg)
      }
    }

    function cleanup() {
      clearTimeout(timer)
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      agent.removeListener('message', handler)
    }

    agent.on('message', handler)

    const request: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      id,
      params: params as Record<string, unknown>,
    }

    const written = agent.write(request)
    if (!written) {
      cleanup()
      reject(new Error(`Failed to write '${method}' to agent stdin`))
    }
  })
}

/**
 * Send a JSON-RPC request and drain any notifications that arrive before the response.
 * Used for session/load which sends session/update notifications before the final response.
 * Notifications are logged but discarded (the server already has the history).
 */
function sendRequestWithNotificationDrain(
  agent: AgentProcess,
  id: number,
  method: string,
  params: unknown,
  timeout: number,
  logger: Logger,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return new Promise((resolve, reject) => {
    let notificationCount = 0

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`ACP request '${method}' timed out after ${timeout}ms (received ${notificationCount} notifications before timeout)`))
    }, timeout)

    const handler = (data: unknown) => {
      const msg = data as JsonRpcMessage
      // If it's the response to our request
      if ('id' in msg && msg.id === id) {
        cleanup()
        logger.info('session_load_drain_complete', { notificationCount })
        if ('error' in msg && msg.error) {
          resolve({ error: msg.error })
        } else if ('result' in msg) {
          resolve({ result: msg.result })
        } else {
          resolve({})
        }
        return
      }
      // Otherwise it's a notification (session/update during load) — drain it
      if ('method' in msg && !('id' in msg)) {
        notificationCount++
      }
    }

    function cleanup() {
      clearTimeout(timer)
      agent.removeListener('message', handler)
    }

    agent.on('message', handler)

    const request: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      id,
      params: params as Record<string, unknown>,
    }

    const written = agent.write(request)
    if (!written) {
      cleanup()
      reject(new Error(`Failed to write '${method}' to agent stdin`))
    }
  })
}
