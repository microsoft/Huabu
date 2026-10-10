import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadService } from '../src/service-sdk/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.HUABU_RFS_URL
  delete process.env.AGENTLET_TOKEN
})

describe('Service SDK', () => {
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

    const service = await loadService('example')

    expect(service.client).toEqual({ configured: true })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://huabu.example/api/rfs/canvas-1/services/example/lease',
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

    await expect(loadService('example')).rejects.toThrow(
      'Service request failed (409)',
    )
  })
})
