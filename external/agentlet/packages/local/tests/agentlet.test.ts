import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildAgentProcessEnv,
  buildEnvRegistryDefaults,
  resolveAgentletId,
  resolveManagedSetupWorkerPath,
} from '../src/agentlet.js'
import { parseCli } from '../src/cli.js'

describe('agentlet daemon identity', () => {
  it('uses the current machine hostname when no identity is injected', () => {
    expect(resolveAgentletId(undefined, 'machine-a')).toBe('machine-a')
    expect(resolveAgentletId(undefined, 'machine-b')).toBe('machine-b')
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
})

describe('managed setup worker resolution', () => {
  it('uses the worker bundled beside the daemon entry', () => {
    expect(
      resolveManagedSetupWorkerPath(
        'file:///app/agentlet/index.js',
        (path) => path === '/app/agentlet/setup-worker.js',
        () => '/workspace/node_modules/@agentlet/agent-team/dist/setup/managed-setup-worker.js',
      ),
    ).toBe('/app/agentlet/setup-worker.js')
  })

  it('falls back to the package export in development', () => {
    expect(
      resolveManagedSetupWorkerPath(
        'file:///workspace/packages/local/dist/agentlet.js',
        () => false,
        () => '/workspace/packages/agent-team/dist/setup/managed-setup-worker.js',
      ),
    ).toBe('/workspace/packages/agent-team/dist/setup/managed-setup-worker.js')
  })
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
      AGENTLET_REACHBACK_DIR: '/tmp/reachback',
      HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/canvas-1',
    })
  })

  it('keeps the daemon token authoritative over host environment overrides', () => {
    expect(
      buildAgentProcessEnv('ws://daemon.test', 'daemon-token', {}, {
        AGENTLET_SERVER: 'ws://host.test',
        AGENTLET_TOKEN: 'host-token',
      }),
    ).toMatchObject({
      AGENTLET_SERVER: 'ws://host.test',
      AGENTLET_TOKEN: 'daemon-token',
    })
  })
})

describe('AGENT_RESOURCE_DIR provisioning', () => {
  it('defaults every spawned agent to an absolute ~/.agentlet/resources root', () => {
    const registry = buildEnvRegistryDefaults({})
    expect(registry.AGENT_RESOURCE_DIR.endsWith(join('.agentlet', 'resources'))).toBe(true)
    expect(registry.AGENT_RESOURCE_DIR.startsWith('/') || /^[A-Za-z]:\\/.test(registry.AGENT_RESOURCE_DIR)).toBe(true)
  })

  it('honors a host-configured explicit absolute AGENT_RESOURCE_DIR override', () => {
    const registry = buildEnvRegistryDefaults({ AGENT_RESOURCE_DIR: '/srv/agentlet/resources' })
    expect(registry.AGENT_RESOURCE_DIR).toBe('/srv/agentlet/resources')
  })

  it('keeps AGENT_RESOURCE_DIR independent from the cwd-relative reachback default', () => {
    const registry = buildEnvRegistryDefaults({})
    expect(registry.AGENTLET_REACHBACK_DIR.endsWith(join('node_modules', '.cache', 'agentlet', 'reachback'))).toBe(
      true,
    )
    expect(registry.AGENT_RESOURCE_DIR).not.toContain('node_modules')
  })
})
