// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const FS_PROTOCOL_VERSION = 1
export const FS_MAX_TEXT_BYTES = 65_536
export const FS_MAX_RESPONSE_BYTES = 524_288
export const FS_MAX_ENTRIES = 100

export type FsOperation = 'fs-list' | 'fs-read'
export interface FsRequest {
  path: string
  cursor?: string
  limit?: number
  limitBytes?: number
  showHidden?: boolean
}
export interface FsEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
}
export interface FsListResult {
  path: string
  parentPath: string
  entries: FsEntry[]
  nextCursor?: string
}
export interface FsReadResult {
  path: string
  encoding: 'utf-8'
  text: string
  byteLength: number
  size: number
  contentVersion: string
  nextCursor?: string
}
export type FsResult = FsListResult | FsReadResult
export const FS_ERROR_CODES = [
  'invalid_request', 'permission_denied', 'not_found', 'not_directory',
  'unsupported_file', 'unsupported_encoding', 'directory_too_large',
  'stale_cursor', 'cancelled', 'busy', 'io_error',
] as const
export type FsErrorCode = typeof FS_ERROR_CODES[number]
export type FsResponse =
  | { version: 1; operation: FsOperation; ok: true; result: FsResult }
  | { version: 1; operation: FsOperation; ok: false; error: { code: FsErrorCode; message: string } }

export function parseFsRequest(operation: FsOperation, value: unknown): FsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object')
  }
  const record = value as Record<string, unknown>
  const keys = operation === 'fs-list'
    ? ['path', 'cursor', 'limit', 'showHidden']
    : ['path', 'cursor', 'limitBytes']
  if (Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.path !== 'string' || record.path.length === 0 ||
    record.path.length > 4096 || /[\u0000-\u001f]/.test(record.path) ||
    (record.cursor !== undefined && (typeof record.cursor !== 'string' || record.cursor.length > 16_384)) ||
    (record.showHidden !== undefined && typeof record.showHidden !== 'boolean')) {
    throw new Error('Invalid filesystem request')
  }
  const limitKey = operation === 'fs-list' ? 'limit' : 'limitBytes'
  const maximum = operation === 'fs-list' ? FS_MAX_ENTRIES : FS_MAX_TEXT_BYTES
  const limit = record[limitKey]
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < (operation === 'fs-list' ? 1 : 4) || limit > maximum)) {
    throw new Error('Invalid filesystem request limit')
  }
  return {
    path: record.path,
    ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}),
    ...(typeof record.showHidden === 'boolean' ? { showHidden: record.showHidden } : {}),
    ...(typeof limit === 'number' ? operation === 'fs-list' ? { limit } : { limitBytes: limit } : {}),
  }
}
