import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  leaseService,
  withServiceContext,
} from '../src/service-sdk/index.js'

const manifest = {
  schema: 'huabu-service/v1',
  id: 'example',
  version: '1.0.0',
  name: 'Example',
  description: 'Example Service',
  storage: { namespace: 'integration.example' },
  package: { files: ['SKILL.md', 'entry.mjs'] },
  configuration: [
    {
      id: 'quality',
      label: 'Quality',
      type: 'enum',
      required: true,
      options: [{ value: 'high', label: 'high' }],
    },
    {
      id: 'apiKey',
      label: 'API key',
      type: 'secret',
      required: true,
    },
  ],
} as const

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
            manifest,
            config: { apiKey: 'provider-secret' },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const lease = await leaseService('example')

    expect(lease.config).toEqual({ apiKey: 'provider-secret' })
    expect(lease.manifest.configuration[0]?.id).toBe('quality')
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
            manifest,
            config: { apiKey: 'provider-secret' },
          }),
        ),
      ),
    )

    await expect(
      withServiceContext('example', ({ config, manifest: serviceManifest }) => ({
        configured: Boolean(config.apiKey),
        name: serviceManifest.name,
      })),
    ).resolves.toEqual({ configured: true, name: 'Example' })
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
