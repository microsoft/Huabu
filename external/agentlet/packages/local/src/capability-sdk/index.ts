export interface CapabilityLease {
  id: string
  version: string
  config: Record<string, string | boolean | null>
  client?: string
}

export interface CapabilityContext {
  config: CapabilityLease['config']
  client: Record<string, unknown> | null
  lease: CapabilityLease
}

type CapabilityClientModule = {
  createClient?: (context: {
    config: CapabilityLease['config']
  }) => Record<string, unknown>
}

function requiredEnvironment(name: 'HUABU_RFS_URL' | 'AGENTLET_TOKEN'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Capability SDK requires ${name}`)
  return value
}

async function capabilityFetch(path: string, init?: RequestInit): Promise<Response> {
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
    throw new Error(`Capability request failed (${response.status})`)
  }
  return response
}

async function loadClient(
  capabilityId: string,
  lease: CapabilityLease,
): Promise<Record<string, unknown> | null> {
  if (!lease.client) return null
  const response = await capabilityFetch(
    `/capability-packages/${encodeURIComponent(capabilityId)}/client`,
  )
  const source = await response.text()
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
  const module = (await import(moduleUrl)) as CapabilityClientModule
  if (typeof module.createClient !== 'function') {
    throw new Error('Capability client must export createClient()')
  }
  return module.createClient({ config: lease.config })
}

export async function loadCapability(
  capabilityId: string,
): Promise<CapabilityContext> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(capabilityId)) {
    throw new Error('Invalid Capability id')
  }
  const response = await capabilityFetch(
    `/capability-packages/${encodeURIComponent(capabilityId)}/lease`,
    { method: 'POST' },
  )
  const lease = (await response.json()) as CapabilityLease
  if (lease.id !== capabilityId || typeof lease.version !== 'string') {
    throw new Error('Invalid Capability lease')
  }
  return {
    lease,
    config: lease.config,
    client: await loadClient(capabilityId, lease),
  }
}

export async function withCapability<T>(
  capabilityId: string,
  run: (context: CapabilityContext) => Promise<T> | T,
): Promise<T> {
  return run(await loadCapability(capabilityId))
}
