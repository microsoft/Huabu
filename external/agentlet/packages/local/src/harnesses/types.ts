import type {
  HarnessCapabilities,
  HarnessDiscoveryEntry,
  HarnessLaunchOptions,
} from '@agentlet/protocol'

export interface HarnessDiagnostic {
  code: string
  message: string
}

export type HarnessDiscovery = Pick<
  HarnessDiscoveryEntry,
  'status' | 'version' | 'diagnostics'
>

export interface CompiledHarnessLaunch {
  kind: 'shell'
  command: string
}

export interface HarnessDefinition {
  id: string
  displayName: string
  installHint: string
  capabilities: HarnessCapabilities
  discover(): Promise<HarnessDiscovery>
  compile(options?: HarnessLaunchOptions): CompiledHarnessLaunch
}
