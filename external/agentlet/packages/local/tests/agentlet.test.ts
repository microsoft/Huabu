import { describe, expect, it } from 'vitest'

import {
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
