#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError,
  type Agent, type InitializeResponse, type NewSessionResponse, type PromptRequest, type PromptResponse,
} from '@agentclientprotocol/sdk'
import { FS_MAX_RESPONSE_BYTES } from '@agentlet/protocol'
import { executeFsCommand } from './filesystem.js'

class FilesystemProxy implements Agent {
  private sessionId: string | undefined
  private active: AbortController | undefined
  constructor(private readonly connection: AgentSideConnection) {}
  async initialize(): Promise<InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'proxy', version: '1' },
      agentCapabilities: { loadSession: false } }
  }
  async authenticate() { return {} }
  async newSession(): Promise<NewSessionResponse> {
    if (this.sessionId) throw RequestError.invalidParams('Proxy supports one private session')
    this.sessionId = randomUUID()
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [
        { name: 'fs-list', description: 'List a directory (filesystem contract v1)', input: { hint: '{"path":"/absolute/path","cursor":"optional","limit":100,"showHidden":false}' } },
        { name: 'fs-read', description: 'Read UTF-8 text (filesystem contract v1)', input: { hint: '{"path":"/absolute/path","cursor":"optional","limitBytes":65536}' } },
      ] },
    })
    return { sessionId: this.sessionId }
  }
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (params.sessionId !== this.sessionId || this.active) throw RequestError.invalidParams('Invalid or busy proxy session')
    if (params.prompt.length !== 1 || params.prompt[0]?.type !== 'text') throw RequestError.invalidParams('Expected one command text block')
    const match = /^\/(fs-list|fs-read) ([\s\S]+)$/.exec(params.prompt[0].text)
    if (!match) throw RequestError.invalidParams('Unknown filesystem command')
    let input: unknown
    try { input = JSON.parse(match[2]!) } catch { throw RequestError.invalidParams('Expected JSON command arguments') }
    const operation = match[1] === 'fs-list' ? 'fs-list' : 'fs-read'
    const controller = new AbortController()
    this.active = controller
    try {
      const result = await executeFsCommand(operation, input, controller.signal)
      const text = JSON.stringify(result)
      if (Buffer.byteLength(text) > FS_MAX_RESPONSE_BYTES) throw RequestError.internalError('Filesystem response exceeds limit')
      if (controller.signal.aborted) return { stopReason: 'cancelled' }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      })
      return { stopReason: 'end_turn' }
    } finally { this.active = undefined }
  }
  async cancel(params: { sessionId: string }) {
    if (params.sessionId === this.sessionId) this.active?.abort()
  }
}

const input = process.stdin[Symbol.asyncIterator]()
new AgentSideConnection((connection) => new FilesystemProxy(connection), ndJsonStream(
  new WritableStream<Uint8Array>({
    write(chunk) { return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => error ? reject(error) : resolve())
    }) },
  }),
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await input.next()
      if (next.done) controller.close()
      else if (Buffer.isBuffer(next.value)) controller.enqueue(next.value)
      else controller.error(new Error('Expected binary stdin'))
    },
  }),
))
