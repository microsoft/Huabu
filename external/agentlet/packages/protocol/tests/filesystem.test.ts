// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest'
import { FS_PROXY_CAPABILITY, FS_PROXY_CAPABILITY_KEY, supportsFsProtocol } from '../src/filesystem.js'

describe('filesystem initialization capability', () => {
  it('declares the fixed v1 read-only filesystem contract', () => {
    expect(FS_PROXY_CAPABILITY_KEY).toBe('com.microsoft.agentlet/filesystem')
    expect(FS_PROXY_CAPABILITY).toEqual({ version: 1 })
    expect(Object.isFrozen(FS_PROXY_CAPABILITY)).toBe(true)
    expect(supportsFsProtocol({
      loadSession: false,
      _meta: { unrelated: true, [FS_PROXY_CAPABILITY_KEY]: FS_PROXY_CAPABILITY },
    })).toBe(true)
  })

  it.each([
    undefined, null, false, 1, 'filesystem', [],
    {}, { _meta: null }, { _meta: false }, { _meta: 'v1' }, { _meta: [] },
    { [FS_PROXY_CAPABILITY_KEY]: { version: 1 } },
    { fs: { readTextFile: true } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: null } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: true } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: '1' } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: [] } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: {} } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: '1' } } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 0 } } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 2 } } },
  ])('rejects missing, malformed or unsupported capability %j', (value) => {
    expect(supportsFsProtocol(value)).toBe(false)
  })
})
