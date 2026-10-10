export interface ServiceLease {
  id: string
  version: string
  config: Record<string, string | boolean | null>
}

export interface ServiceConfigContext {
  config: ServiceLease['config']
  lease: ServiceLease
}

function requiredEnvironment(name: 'HUABU_RFS_URL' | 'AGENTLET_TOKEN'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Service SDK requires ${name}`)
  return value
}

async function serviceFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = requiredEnvironment('HUABU_RFS_URL').replace(/\/+$/, '')
  const token = requiredEnvironment('AGENTLET_TOKEN')
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(`Service request failed (${response.status})`)
  }
  return response
}

export async function leaseService(serviceId: string): Promise<ServiceLease> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(serviceId)) {
    throw new Error('Invalid Service id')
  }
  const response = await serviceFetch(
    `/services/${encodeURIComponent(serviceId)}/lease`,
    { method: 'POST' },
  )
  const lease = (await response.json()) as ServiceLease
  if (lease.id !== serviceId || typeof lease.version !== 'string') {
    throw new Error('Invalid Service lease')
  }
  return lease
}

export async function withServiceConfig<T>(
  serviceId: string,
  run: (context: ServiceConfigContext) => Promise<T> | T,
): Promise<T> {
  const lease = await leaseService(serviceId)
  return run({ lease, config: lease.config })
}
