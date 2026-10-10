export interface ServiceLease {
  id: string
  version: string
  config: Record<string, string | boolean | null>
  client?: string
}

export interface ServiceContext {
  config: ServiceLease['config']
  client: Record<string, unknown> | null
  lease: ServiceLease
}

type ServiceClientModule = {
  createClient?: (context: {
    config: ServiceLease['config']
  }) => Record<string, unknown>
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

async function loadClient(
  serviceId: string,
  lease: ServiceLease,
): Promise<Record<string, unknown> | null> {
  if (!lease.client) return null
  const response = await serviceFetch(
    `/services/${encodeURIComponent(serviceId)}/client`,
  )
  const source = await response.text()
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
  const module = (await import(moduleUrl)) as ServiceClientModule
  if (typeof module.createClient !== 'function') {
    throw new Error('Service client must export createClient()')
  }
  return module.createClient({ config: lease.config })
}

export async function loadService(
  serviceId: string,
): Promise<ServiceContext> {
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
  return {
    lease,
    config: lease.config,
    client: await loadClient(serviceId, lease),
  }
}

export async function withService<T>(
  serviceId: string,
  run: (context: ServiceContext) => Promise<T> | T,
): Promise<T> {
  return run(await loadService(serviceId))
}
