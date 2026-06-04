import type { JsonRpcMessage } from '@agentlet/protocol'
import type { AgentProcess } from './agent-process.js'
import type { Logger } from './logger.js'

/**
 * Result of a successful ACP session bootstrap (initialize + session/new).
 * Stored as the "agent session profile" and reported to the server.
 */
export interface SessionProfile {
  /** The active ACP sessionId */
  sessionId: string
  /** Whether the agent supports session/load */
  supportsLoad: boolean
  /** The full ACP initialize response */
  initializeResult: unknown
}

export interface BootstrapOptions {
  /** Working directory to pass to session/new */
  cwd: string
  /** Timeout for each request in ms */
  timeout?: number
}

/**
 * Perform ACP session bootstrap on a spawned agent process.
 * Sends `initialize` then `session/new` over stdin/stdout.
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
    clientCapabilities: {
      // Declare no special client capabilities for now
    },
    clientInfo: { name: 'agentlet', version: '1.0.0' },
  }, timeout)

  if (!initResponse.result) {
    throw new Error(`initialize failed: ${JSON.stringify(initResponse.error ?? 'no result')}`)
  }

  const initResult = initResponse.result as Record<string, unknown>
  const agentCapabilities = initResult.agentCapabilities as Record<string, unknown> | undefined
  const supportsLoad = agentCapabilities?.loadSession === true

  logger.info('session_bootstrap_initialized', {
    supportsLoad,
    agentInfo: initResult.agentInfo,
    protocolVersion: initResult.protocolVersion,
  })

  // 2. Send session/new
  logger.info('session_bootstrap_session_new', { cwd: options.cwd })
  const sessionResponse = await sendRequest(agent, 2, 'session/new', {
    cwd: options.cwd,
    mcpServers: [],
  }, timeout)

  if (!sessionResponse.result) {
    throw new Error(`session/new failed: ${JSON.stringify(sessionResponse.error ?? 'no result')}`)
  }

  const sessionResult = sessionResponse.result as Record<string, unknown>
  const sessionId = sessionResult.sessionId as string
  if (!sessionId) {
    throw new Error('session/new response missing sessionId')
  }

  logger.info('session_bootstrap_complete', { sessionId, supportsLoad })

  return {
    sessionId,
    supportsLoad,
    initializeResult: initResult,
  }
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
