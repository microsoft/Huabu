import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadCapability } from '../src/capability-sdk/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.HUABU_RFS_URL
  delete process.env.AGENTLET_TOKEN
})

describe('Capability SDK', () => {
  it('leases config and loads the trusted package client without logging secrets', async () => {
    process.env.HUABU_RFS_URL = 'https://huabu.example/api/rfs/canvas-1'
    process.env.AGENTLET_TOKEN = 'agentlet-token'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'example',
            version: '1.0.0',
            config: { apiKey: 'provider-secret' },
            client: 'client.mjs',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'export function createClient({ config }) { return { configured: Boolean(config.apiKey) }; }',
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const capability = await loadCapability('example')

    expect(capability.client).toEqual({ configured: true })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://huabu.example/api/rfs/canvas-1/capability-packages/example/lease',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer agentlet-token' },
      }),
    )
  })

  it('does not include response bodies in provider-facing errors', async () => {
    process.env.HUABU_RFS_URL = 'https://huabu.example/api/rfs/canvas-1'
    process.env.AGENTLET_TOKEN = 'agentlet-token'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('provider-secret', { status: 409 }),
      ),
    )

    await expect(loadCapability('example')).rejects.toThrow(
      'Capability request failed (409)',
    )
  })
})
