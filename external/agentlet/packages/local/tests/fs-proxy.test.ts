// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('speaks ACP over stdio with discoverable deterministic filesystem commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-acp-'))
  const child = spawn(process.execPath, [process.env.AGENTLET_FS_PROXY_TEST_ENTRY ?? fileURLToPath(new URL('../dist/fs-proxy.js', import.meta.url))], { stdio: 'pipe' })
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
    expect(await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({
      protocolVersion: 1, agentInfo: { name: 'proxy' },
    })
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
