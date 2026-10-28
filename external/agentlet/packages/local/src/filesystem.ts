// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  FS_MAX_ENTRIES, FS_MAX_TEXT_BYTES, FS_PROTOCOL_VERSION, parseFsRequest,
  type FsEntry, type FsErrorCode, type FsOperation, type FsRequest, type FsResponse,
} from '@agentlet/protocol'

class FsFailure extends Error {
  constructor(readonly code: FsErrorCode, message: string) { super(message) }
}

function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    throw new FsFailure('invalid_request', 'Invalid continuation cursor')
  }
  throw new FsFailure('invalid_request', 'Invalid continuation cursor')
}

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || (process.platform === 'win32' &&
    (/^\\\\[?.]\\/.test(value) || value.slice(2).includes(':')))) {
    throw new FsFailure('invalid_request', 'Expected a normal absolute filesystem path')
  }
  return path.resolve(value)
}

async function list(request: FsRequest, signal: AbortSignal) {
  const directory = await realpath(absolutePath(request.path))
  const previous = decodeCursor(request.cursor)
  if (previous && (previous.path !== directory || previous.hidden !== !!request.showHidden ||
    typeof previous.after !== 'string')) {
    throw new FsFailure('invalid_request', 'Cursor does not match this directory request')
  }
  const entries: FsEntry[] = []
  let scanned = 0
  const handle = await opendir(directory)
  for await (const entry of handle) {
    signal.throwIfAborted()
    if (++scanned > 20_000) throw new FsFailure('directory_too_large', 'Directory exceeds the scan limit')
    if (!request.showHidden && entry.name.startsWith('.')) continue
    // Names come from the OS, but still require direct-child containment.
    const child = path.resolve(directory, entry.name)
    if (path.dirname(child) !== directory) throw new FsFailure('io_error', 'Invalid directory entry')
    entries.push({
      name: entry.name, path: child,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
    })
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const limit = request.limit ?? FS_MAX_ENTRIES
  const remaining = previous ? entries.filter((entry) => entry.name > String(previous.after)) : entries
  const page = remaining.slice(0, limit)
  for (const entry of page) {
    signal.throwIfAborted()
    if (entry.kind !== 'symlink') continue
    try {
      const target = await stat(entry.path)
      entry.kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) ||
        !['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))) throw error
      // Broken or inaccessible links remain explicit non-browsable link entries.
    }
  }
  return {
    path: directory, parentPath: path.dirname(directory), entries: page,
    ...(remaining.length > limit ? { nextCursor: cursor({
      path: directory, hidden: !!request.showHidden, after: page.at(-1)!.name,
    }) } : {}),
  }
}

async function read(request: FsRequest, signal: AbortSignal) {
  const filename = absolutePath(request.path)
  // O_NONBLOCK prevents a FIFO substituted before open from hanging the process.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new FsFailure('unsupported_file', 'Only regular text files are supported')
    if (!Number.isSafeInteger(before.size)) throw new FsFailure('unsupported_file', 'File size exceeds the supported range')
    const version = (stat: typeof before) => createHash('sha256')
      .update([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex')
    const contentVersion = version(before)
    const previous = decodeCursor(request.cursor)
    if (previous && (previous.path !== filename || previous.version !== contentVersion)) {
      throw new FsFailure('stale_cursor', 'File changed; read it again from the beginning')
    }
    const offset = previous?.offset ?? 0
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > before.size) {
      throw new FsFailure('invalid_request', 'Invalid continuation offset')
    }
    signal.throwIfAborted()
    const limit = request.limitBytes ?? FS_MAX_TEXT_BYTES
    const buffer = Buffer.alloc(limit + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      signal.throwIfAborted()
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    signal.throwIfAborted()
    if (version(await handle.stat()) !== contentVersion) throw new FsFailure('stale_cursor', 'File changed during reading')
    let length = Math.min(bytesRead, limit)
    if (bytesRead > limit) {
      while (length > 0 && (buffer[length]! & 0xc0) === 0x80) length--
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: offset !== 0 }).decode(buffer.subarray(0, length)) }
    catch { throw new FsFailure('unsupported_encoding', 'File is not valid UTF-8 text') }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) {
      throw new FsFailure('unsupported_encoding', 'File contains unsupported binary or control data')
    }
    return {
      path: filename, encoding: 'utf-8' as const, text, byteLength: length, size: before.size, contentVersion,
      ...(offset + length < before.size ? { nextCursor: cursor({
        path: filename, version: contentVersion, offset: offset + length,
      }) } : {}),
    }
  } finally { await handle.close() }
}

export async function executeFsCommand(
  operation: FsOperation, input: unknown, signal: AbortSignal = new AbortController().signal,
): Promise<FsResponse> {
  try {
    let request: FsRequest
    try { request = parseFsRequest(operation, input) }
    catch { throw new FsFailure('invalid_request', 'Invalid filesystem request') }
    const result = operation === 'fs-list' ? await list(request, signal) : await read(request, signal)
    signal.throwIfAborted()
    return { version: FS_PROTOCOL_VERSION, operation, ok: true, result }
  } catch (error) {
    let code: FsErrorCode = 'io_error'
    let message = 'Filesystem operation failed'
    if (signal.aborted) { code = 'cancelled'; message = 'Operation cancelled' }
    else if (error instanceof FsFailure) { code = error.code; message = error.message }
    else if (error instanceof Error && 'code' in error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') { code = 'permission_denied'; message = 'Permission denied' }
      if (error.code === 'ENOENT') { code = 'not_found'; message = 'Path not found' }
      if (error.code === 'ENOTDIR') { code = 'not_directory'; message = 'Path is not a directory' }
    }
    return { version: FS_PROTOCOL_VERSION, operation, ok: false, error: { code, message } }
  }
}
