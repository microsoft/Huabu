import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentProcess } from '../src/agent-process.js'
import { Logger } from '../src/logger.js'
import { Relay } from '../src/relay.js'
import { WsClient } from '../src/ws-client.js'

import type { JsonRpcMessage } from '@agentlet/protocol'

function createRelay(idleTimeoutSecs = 1): {
  relay: Relay
  agent: EventEmitter
  ws: EventEmitter
} {
  const agent = Object.assign(new EventEmitter(), { write: vi.fn(() => true) })
  const ws = Object.assign(new EventEmitter(), { send: vi.fn(() => true) })
  const relay = new Relay(
    agent as AgentProcess,
    ws as WsClient,
    new Logger('error'),
    { idleTimeoutSecs },
  )
  return { relay, agent, ws }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Relay idle suspension', () => {
  it('waits for an in-flight host request to settle before starting the idle countdown', () => {
    vi.useFakeTimers()
    const { relay, agent, ws } = createRelay()
    const onIdle = vi.fn()
    relay.on('idle', onIdle)
    relay.start()

    ws.emit('message', {
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 7,
      params: { sessionId: 'session-1' },
    } satisfies JsonRpcMessage)

    vi.advanceTimersByTime(10_000)
    expect(onIdle).not.toHaveBeenCalled()

    agent.emit('message', {
      jsonrpc: '2.0',
      id: 7,
      result: { stopReason: 'end_turn' },
    } satisfies JsonRpcMessage)

    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()
  })
})
