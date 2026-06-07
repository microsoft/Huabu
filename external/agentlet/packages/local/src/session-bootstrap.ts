import type { JsonRpcMessage } from '@agentlet/protocol'
import type { AgentProcess } from './agent-process.js'
import type { Logger } from './logger.js'

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
  const timeout = options.timeout ?? 30_000

  // 1. Send initialize
  logger.info('session_bootstrap_initialize', { cwd: options.cwd })
  const initResponse = await sendRequest(agent, 1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'agentlet', version: '1.0.0' },
  }, timeout)

  if (!initResponse.result) {
    throw new Error(`initialize failed: ${JSON.stringify(initResponse.error ?? 'no result')}`)
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

  if (options.sessionId) {
    // Resuming an existing session
    sessionId = await bootstrapResumeOrLoad(agent, options, { supportsLoad, supportsResume }, logger, timeout)
  } else {
    // Creating a new session
    sessionId = await bootstrapNew(agent, options, logger, timeout)
  }

  logger.info('session_bootstrap_complete', { sessionId, supportsLoad, supportsResume })

  return {
    sessionId,
    supportsLoad,
    supportsResume,
    initializeResult: initResult,
  }
}

/**
 * Create a new ACP session via session/new.
 */
async function bootstrapNew(
  agent: AgentProcess,
  options: BootstrapOptions,
  logger: Logger,
  timeout: number,
): Promise<string> {
  logger.info('session_bootstrap_session_new', { cwd: options.cwd })
  const response = await sendRequest(agent, 2, 'session/new', {
    cwd: options.cwd,
    mcpServers: [],
  }, timeout)

  if (!response.result) {
    throw new Error(`session/new failed: ${JSON.stringify(response.error ?? 'no result')}`)
  }

  const result = response.result as Record<string, unknown>
  const sessionId = result.sessionId as string
  if (!sessionId) {
    throw new Error('session/new response missing sessionId')
  }
  return sessionId
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
    if (!response.result && response.error) {
      throw new Error(`session/resume failed: ${JSON.stringify(response.error)}`)
    }
    return sessionId
  }

  if (caps.supportsLoad) {
    // Fall back to session/load — must handle session/update notifications during load
    logger.info('session_bootstrap_session_load', { sessionId, cwd: options.cwd })
    const response = await sendRequestWithNotificationDrain(agent, 2, 'session/load', sessionParams, timeout, logger)
    if (!response.result && response.error) {
      throw new Error(`session/load failed: ${JSON.stringify(response.error)}`)
    }
    return sessionId
  }

  throw new Error(
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
