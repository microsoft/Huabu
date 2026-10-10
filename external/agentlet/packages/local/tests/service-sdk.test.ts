import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  leaseService,
  withServiceConfig,
} from '../src/service-sdk/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.HUABU_RFS_URL
  delete process.env.AGENTLET_TOKEN
})

describe('Service SDK', () => {
  it('leases config without loading package code', async () => {
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
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const lease = await leaseService('example')

    expect(lease.config).toEqual({ apiKey: 'provider-secret' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://huabu.example/api/rfs/canvas-1/services/example/lease',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer agentlet-token' },
      }),
    )
  })

  it('provides config and lease metadata to a scoped callback', async () => {
    process.env.HUABU_RFS_URL = 'https://huabu.example/api/rfs/canvas-1'
    process.env.AGENTLET_TOKEN = 'agentlet-token'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'example',
            version: '1.0.0',
            config: { apiKey: 'provider-secret' },
          }),
        ),
      ),
    )

    await expect(
      withServiceConfig('example', ({ config, lease }) => ({
        configured: Boolean(config.apiKey),
        version: lease.version,
      })),
    ).resolves.toEqual({ configured: true, version: '1.0.0' })
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

    await expect(leaseService('example')).rejects.toThrow(
      'Service request failed (409)',
    )
  })
})
