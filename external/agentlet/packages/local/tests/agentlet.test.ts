import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildAgentProcessEnv,
  resolveAgentletId,
} from '../src/agentlet.js'
import { parseCli } from '../src/cli.js'

describe('agentlet daemon identity', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function identityPath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'agentlet-device-'))
    directories.push(directory)
    return join(directory, 'device.json')
  }

  it('creates and reuses one persisted UUID by default', () => {
    const path = identityPath()
    const first = resolveAgentletId(undefined, path)
    const second = resolveAgentletId(undefined, path)

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(second).toBe(first)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      deviceId: first,
    })
  })

  it('accepts an explicit identity from the supervising host', () => {
    const result = parseCli([
      'node',
      'agentlet',
      'daemon',
      '--server',
      'wss://example.test/api/bridge',
      '--token',
      'test-token',
      '--agentlet-id',
      ' machine-a ',
    ])

    expect(result).toMatchObject({
      mode: 'daemon',
      options: { agentletId: 'machine-a' },
    })
  })

  it('does not read or rewrite the persisted default for an explicit override', () => {
    const path = identityPath()
    expect(resolveAgentletId('custom-id', path)).toBe('custom-id')
    expect(() => readFileSync(path)).toThrow()
  })

  it('fails instead of rotating a damaged persisted identity', () => {
    const path = identityPath()
    writeFileSync(path, '{"version":1,"deviceId":"broken"}')

    expect(() => resolveAgentletId(undefined, path)).toThrow(
      'Agentlet device identity is invalid',
    )
  })

  it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992', '10agents'])(
    'rejects invalid max-agents value %s',
    (maxAgents) => {
      expect(() =>
        parseCli([
          'node',
          'agentlet',
          'daemon',
          '--server',
          'wss://example.test/api/bridge',
          '--token',
          'test-token',
          '--max-agents',
          maxAgents,
        ]),
      ).toThrow('--max-agents must be a positive safe integer')
    },
  )
})

describe('spawned agent environment', () => {
  it('injects the daemon token even when it was provided only through CLI options', () => {
    expect(
      buildAgentProcessEnv(
        'ws://127.0.0.1:3001/api/acp/agent',
        'cli-token',
        { AGENTLET_REACHBACK_DIR: '/tmp/reachback' },
        { HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/canvas-1' },
      ),
    ).toEqual({
      AGENTLET_SERVER: 'ws://127.0.0.1:3001/api/acp/agent',
      AGENTLET_TOKEN: 'cli-token',
      AGENTLET_SERVICE_SDK_URL: expect.stringMatching(
        /\/service-sdk\/index\.js$/,
      ),
      AGENTLET_REACHBACK_DIR: '/tmp/reachback',
      HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/canvas-1',
    })
  })

  it('keeps the daemon token authoritative over host environment overrides', () => {
    expect(
      buildAgentProcessEnv('ws://daemon.test', 'daemon-token', {}, {
        AGENTLET_SERVER: 'ws://host.test',
        AGENTLET_TOKEN: 'host-token',
        AGENTLET_SERVICE_SDK_URL: 'file:///tmp/untrusted.js',
      }),
    ).toMatchObject({
      AGENTLET_SERVER: 'ws://host.test',
      AGENTLET_TOKEN: 'daemon-token',
      AGENTLET_SERVICE_SDK_URL: expect.not.stringContaining('untrusted'),
    })
  })
})
