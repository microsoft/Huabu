import { describe, expect, it } from 'vitest'

import { resolveAgentletId } from '../src/agentlet.js'
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
