// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { supportsFsProtocol } from '@agentlet/protocol'
import { expect, it } from 'vitest'
import { AgentProcess } from '../src/agent-process.js'
import { proxyHarness } from '../src/harnesses/proxy.js'
import { Logger } from '../src/logger.js'
import { bootstrapSession } from '../src/session-bootstrap.js'

const proxyEntry = process.env.AGENTLET_FS_PROXY_TEST_ENTRY ?? fileURLToPath(new URL('../dist/fs-proxy.js', import.meta.url))

it('speaks ACP over stdio with discoverable deterministic filesystem commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-acp-'))
  const child = spawn(process.execPath, [proxyEntry], { stdio: 'pipe' })
  const lines = createInterface({ input: child.stdout })
  const notifications: Array<Record<string, unknown>> = []
  const pending = new Map<number, (packet: Record<string, unknown>) => void>()
  let sequence = 0
  lines.on('line', (line) => {
    const packet: Record<string, unknown> = JSON.parse(line)
    if (typeof packet.id === 'number') pending.get(packet.id)?.(packet)
    else notifications.push(packet)
  })
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ACP timeout: ${method}`)) }, 5000)
    pending.set(id, (packet) => {
      clearTimeout(timer)
      pending.delete(id)
      if (packet.error) reject(new Error(JSON.stringify(packet.error)))
      else resolve(packet.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await writeFile(join(directory, 'source.tex'), '\\documentclass{article}')
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(initialized).toMatchObject({
      protocolVersion: 1, agentInfo: { name: 'proxy' },
      agentCapabilities: { loadSession: false,
        _meta: { 'com.microsoft.agentlet/filesystem': { version: 1 } } },
    })
    if (!initialized || typeof initialized !== 'object' || !('agentCapabilities' in initialized)) throw new Error('Missing ACP capabilities')
    expect(supportsFsProtocol(initialized.agentCapabilities)).toBe(true)
    expect(notifications).toEqual([])
    const session = await request('session/new', { cwd: directory, mcpServers: [] })
    if (!session || typeof session !== 'object' || !('sessionId' in session)) throw new Error('Missing ACP session')
    expect(JSON.stringify(notifications)).toContain('available_commands_update')
    expect(JSON.stringify(notifications)).toContain('fs-list')
    expect(JSON.stringify(notifications)).toContain('fs-read')
    expect(await request('session/prompt', { sessionId: session.sessionId, prompt: [
      { type: 'text', text: `/fs-list ${JSON.stringify({ path: directory })}` },
    ] })).toEqual({ stopReason: 'end_turn' })
    expect(JSON.stringify(notifications)).toContain('source.tex')
    expect(await request('session/prompt', { sessionId: session.sessionId, prompt: [
      { type: 'text', text: `/fs-read ${JSON.stringify({ path: join(directory, 'source.tex') })}` },
    ] })).toEqual({ stopReason: 'end_turn' })
    expect(JSON.stringify(notifications)).toContain('documentclass')
    await expect(request('session/prompt', { sessionId: session.sessionId, prompt: [
      { type: 'text', text: '/shell touch forbidden' },
    ] })).rejects.toThrow('Unknown filesystem command')
  } finally {
    const closed = once(child, 'close')
    child.kill()
    await closed
    lines.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves filesystem capability through harness launch and daemon bootstrap', async () => {
  const argv = process.argv
  let command: string
  try {
    process.argv = [process.execPath, join(dirname(proxyEntry), 'index.js')]
    command = proxyHarness.compile().command
  } finally { process.argv = argv }
  const directory = await mkdtemp(join(tmpdir(), 'proxy-bootstrap-'))
  const agent = new AgentProcess({ command, cwd: directory })
  const errors: Error[] = []
  agent.on('error', (error) => errors.push(error))
  try {
    agent.start()
    const profile = await bootstrapSession(agent, {
      cwd: directory, timeout: 5000,
    }, new Logger('error'))
    expect(profile.initializeResult).toMatchObject({
      protocolVersion: 1, agentInfo: { name: 'proxy' },
      agentCapabilities: { _meta: { 'com.microsoft.agentlet/filesystem': { version: 1 } } },
    })
    expect(profile.bootstrapNotifications).toContainEqual({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: profile.sessionId, update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          expect.objectContaining({ name: 'fs-list' }),
          expect.objectContaining({ name: 'fs-read' }),
        ],
      } },
    })
    expect(errors).toEqual([])
  } finally {
    const exited = agent.running ? once(agent, 'exit', { signal: AbortSignal.timeout(5000) }) : undefined
    await agent.kill()
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
