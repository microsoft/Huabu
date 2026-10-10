export interface ServiceFieldOption {
  value: string
  label: string
}

export interface ServiceConfigurationField {
  id: string
  label: string
  description?: string
  type: 'text' | 'secret' | 'url' | 'boolean' | 'enum'
  required: boolean
  options?: ServiceFieldOption[]
  placeholder?: string
}

export interface ServiceManifest {
  schema: 'huabu-service/v1'
  id: string
  version: string
  name: string
  description: string
  storage: { namespace: string }
  package: { files: string[] }
  configuration: ServiceConfigurationField[]
}

export interface ServiceLease {
  id: string
  version: string
  manifest: ServiceManifest
  config: Record<string, string | boolean | null>
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
  const declaredFields = new Set(
    lease.manifest?.configuration?.map((field) => field.id) ?? [],
  )
  if (
    lease.id !== serviceId ||
    typeof lease.version !== 'string' ||
    lease.manifest?.id !== serviceId ||
    lease.manifest.version !== lease.version ||
    !Array.isArray(lease.manifest.configuration) ||
    !lease.config ||
    typeof lease.config !== 'object' ||
    Array.isArray(lease.config) ||
    Object.keys(lease.config).some((fieldId) => !declaredFields.has(fieldId))
  ) {
    throw new Error('Invalid Service lease')
  }
  return lease
}

export async function withServiceContext<T>(
  serviceId: string,
  run: (service: ServiceLease) => Promise<T> | T,
): Promise<T> {
  return run(await leaseService(serviceId))
}
