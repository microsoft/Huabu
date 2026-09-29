export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AgentProfile {
  id: string;
  alias: string;
  agentletId: string;
  workingDirPath: string;
  launch: AgentProfileLaunch;
  revision?: number;
  executionRevision?: number;
  metadata?: { cliId?: string };
  /** Opaque host-owned JSON, persisted without interpretation. */
  customData?: Record<string, JsonValue>;
}

export type AcpCommandProfile = AgentProfile & {
  launch: Extract<AgentProfileLaunch, { kind: 'acp-command' }>;
};
export type AgentProfileBase = Omit<AgentProfile, 'launch' | 'metadata'>;

export interface AgentProfileSnapshot {
  profileId: string;
  agentletId: string;
  workingDirPath: string;
  launch: AgentProfile['launch'];
  executionRevision?: number;
}

export interface CreateAcpCommandProfileInput {
  id?: string;
  alias: string;
  agentletId: string;
  command: string;
  workingDirPath: string;
  metadata?: { cliId?: string };
  customData?: Record<string, JsonValue>;
}

export interface CreateAcpHarnessProfileInput extends Omit<
  CreateAcpCommandProfileInput,
  'command'
> {
  harnessId: string;
  options?: HarnessLaunchOptions;
}

export type CreateAgentProfileInput =
  | (CreateAcpCommandProfileInput & { launchKind: 'acp-command' })
  | (CreateAcpHarnessProfileInput & { launchKind: 'acp-harness' });

export interface PatchAgentProfileInput {
  expectedRevision?: number;
  workingDirPath?: string;
  launch?: AgentProfileLaunch;
  alias?: string;
  metadata?: { cliId?: string } | null;
  /** Undefined preserves, null clears, and an object replaces the entire bag. */
  customData?: Record<string, JsonValue> | null;
}

export interface AgentProfileRegistryState {
  profiles: AgentProfile[];
}

export interface AgentProfileRegistryStore {
  load(): AgentProfileRegistryState;
  save(state: AgentProfileRegistryState): void;
}

export type AgentProfileRegistryChangeHandler = () => void;
export type AgentProfileRegistryChangeErrorHandler = (error: unknown) => void;
import type {
  AgentProfileLaunch,
  HarnessLaunchOptions,
} from '@agenetes/protocol';
