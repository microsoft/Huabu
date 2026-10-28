// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeFsCommand } from '../src/filesystem.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'agentlet-files-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('stateless filesystem commands', () => {
  it('lists bounded pages with hidden-file filtering and absolute navigation paths', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', '.hidden']) await writeFile(join(directory, name), '')
    const first = await executeFsCommand('fs-list', { path: directory, limit: 4 })
    expect(first.ok).toBe(true)
    if (!first.ok || !('entries' in first.result)) throw new Error('Expected directory')
    expect(first.result.entries.map((entry) => entry.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(first.result.entries[0]?.path).toBe(join(directory, 'a'))
    const next = await executeFsCommand('fs-list', { path: directory, cursor: first.result.nextCursor })
    expect(next).toMatchObject({ ok: true, result: { entries: [{ name: 'e' }] } })
    expect(await executeFsCommand('fs-list', { path: directory, showHidden: true })).toMatchObject({
      ok: true, result: { entries: expect.arrayContaining([expect.objectContaining({ name: '.hidden' })]) },
    })
  })

  it('continues UTF-8 at byte boundaries and detects replacement between chunks', async () => {
    const path = join(directory, 'text')
    const text = 'abc你好🙂end'
    await writeFile(path, text)
    let cursor: string | undefined
    let actual = ''
    do {
      const response = await executeFsCommand('fs-read', { path, limitBytes: 4, ...(cursor ? { cursor } : {}) })
      if (!response.ok || !('text' in response.result)) throw new Error(JSON.stringify(response))
      actual += response.result.text
      cursor = response.result.nextCursor
    } while (cursor)
    expect(actual).toBe(text)
    const first = await executeFsCommand('fs-read', { path, limitBytes: 4 })
    if (!first.ok || !('text' in first.result)) throw new Error('Expected text')
    await writeFile(path, 'different text')
    expect(await executeFsCommand('fs-read', { path, cursor: first.result.nextCursor })).toMatchObject({
      ok: false, error: { code: 'stale_cursor' },
    })
  })

  it('rejects invalid requests, binary text, malformed UTF-8 and directories without leaking OS errors', async () => {
    expect(await executeFsCommand('fs-list', { path: '.', extra: true })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(await executeFsCommand('fs-read', { path: directory })).toMatchObject({ ok: false, error: { code: 'unsupported_file' } })
    const path = join(directory, 'bytes')
    await writeFile(path, Buffer.from([0xff]))
    expect(await executeFsCommand('fs-read', { path })).toMatchObject({ ok: false, error: { code: 'unsupported_encoding' } })
    await writeFile(path, Buffer.from([0]))
    expect(await executeFsCommand('fs-read', { path })).toMatchObject({ ok: false, error: { code: 'unsupported_encoding' } })
    expect(await executeFsCommand('fs-read', { path: join(directory, 'missing') })).toEqual({
      version: 1, operation: 'fs-read', ok: false, error: { code: 'not_found', message: 'Path not found' },
    })
  })

  it('follows normal symlinks and has no project-root confinement', async () => {
    await mkdir(join(directory, 'root'))
    await writeFile(join(directory, 'outside.txt'), 'outside')
    if (process.platform !== 'win32') {
      await symlink('../outside.txt', join(directory, 'root', 'link'))
      expect(await executeFsCommand('fs-read', { path: join(directory, 'root', 'link') })).toMatchObject({ ok: true, result: { text: 'outside' } })
      await symlink('root', join(directory, 'directory-link'))
      expect(await executeFsCommand('fs-list', { path: directory })).toMatchObject({ ok: true, result: {
        entries: expect.arrayContaining([expect.objectContaining({ name: 'directory-link', kind: 'directory' })]),
      } })
    }
    expect(await executeFsCommand('fs-read', { path: join(directory, 'outside.txt') })).toMatchObject({ ok: true, result: { text: 'outside' } })
  })

  it('accepts single-entry pages, binds list cursors to options, and returns empty files', async () => {
    await writeFile(join(directory, 'a'), '')
    await writeFile(join(directory, 'b'), '')
    const first = await executeFsCommand('fs-list', { path: directory, limit: 1 })
    if (!first.ok || !('entries' in first.result)) throw new Error('Expected list')
    expect(first.result.entries).toHaveLength(1)
    expect(await executeFsCommand('fs-list', { path: directory, showHidden: true, cursor: first.result.nextCursor })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(await executeFsCommand('fs-read', { path: join(directory, 'a') })).toMatchObject({ ok: true, result: { text: '', byteLength: 0, size: 0 } })
  })

  it('bounds large text chunks and rejects continuation after atomic-save replacement', async () => {
    const path = join(directory, 'large.tex')
    await writeFile(path, '🙂'.repeat(30_000))
    const first = await executeFsCommand('fs-read', { path })
    if (!first.ok || !('text' in first.result)) throw new Error('Expected text')
    expect(first.result.byteLength).toBe(65_536)
    expect(Buffer.byteLength(first.result.text)).toBe(first.result.byteLength)
    await writeFile(join(directory, 'replacement'), '\\documentclass{article}')
    await rename(join(directory, 'replacement'), path)
    expect(await executeFsCommand('fs-read', { path, cursor: first.result.nextCursor })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
    expect(await executeFsCommand('fs-read', { path })).toMatchObject({ ok: true, result: { text: '\\documentclass{article}' } })
  })

  it('validates command-specific limits and cursors', async () => {
    for (const args of [{ limit: 101 }, { limit: 0 }, { limitBytes: 4 }, { cursor: 'not-json' }]) {
      expect(await executeFsCommand('fs-list', { path: directory, ...args })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
    await writeFile(join(directory, 'text'), 'hello')
    for (const args of [{ limitBytes: 65_537 }, { limitBytes: 1 }, { showHidden: true }, { cursor: 'not-json' }]) {
      expect(await executeFsCommand('fs-read', { path: join(directory, 'text'), ...args })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
  })

  it('caps directory output at 100 entries without omitting the continuation', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, index) => writeFile(join(directory, `entry-${index.toString().padStart(3, '0')}`), '')))
    const first = await executeFsCommand('fs-list', { path: directory })
    if (!first.ok || !('entries' in first.result)) throw new Error('Expected list')
    expect(first.result.entries).toHaveLength(100)
    const next = await executeFsCommand('fs-list', { path: directory, cursor: first.result.nextCursor })
    if (!next.ok || !('entries' in next.result)) throw new Error('Expected continuation')
    expect(next.result.entries).toHaveLength(5)
    expect(next.result.nextCursor).toBeUndefined()
  })

  it('returns cancellation explicitly', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await executeFsCommand('fs-list', { path: directory }, controller.signal)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
