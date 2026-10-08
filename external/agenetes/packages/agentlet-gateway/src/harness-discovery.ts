import type {
  HarnessDiscoveryEntry,
  HarnessDiscoveryResult,
} from '@agentlet/protocol';

export class AgentletGatewayError extends Error {
  constructor(
    readonly code:
      | 'agentlet_disconnected'
      | 'harness_discovery_unsupported'
      | 'harness_launch_unsupported'
      | 'invalid_harness_discovery_response',
    message: string,
  ) {
    super(message);
    this.name = 'AgentletGatewayError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new AgentletGatewayError(
    'invalid_harness_discovery_response',
    'Agentlet returned malformed harness discovery data',
  );
}

/** Validate daemon-controlled launch data before it can become a durable Profile. */
export function parseHarnessDiscoveryResult(
  value: unknown,
): HarnessDiscoveryResult {
  if (!object(value) || !Array.isArray(value.harnesses)) return invalid();
  const ids = new Set<string>();
  const harnesses = value.harnesses.map(
    (entry: unknown): HarnessDiscoveryEntry => {
      if (
        !object(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id.trim() ||
        typeof entry.displayName !== 'string' ||
        typeof entry.installHint !== 'string' ||
        !object(entry.capabilities) ||
        typeof entry.capabilities.autoApprove !== 'boolean' ||
        typeof entry.capabilities.customLaunchCommand !== 'boolean' ||
        !['ready', 'adapter-missing', 'not-found'].includes(
          String(entry.status),
        )
      )
        return invalid();
      if (ids.has(entry.id)) return invalid();
      ids.add(entry.id);
      const result: HarnessDiscoveryEntry = {
        id: entry.id,
        displayName: entry.displayName,
        installHint: entry.installHint,
        capabilities: {
          autoApprove: entry.capabilities.autoApprove,
          customLaunchCommand: entry.capabilities.customLaunchCommand,
        },
        status: entry.status as HarnessDiscoveryEntry['status'],
      };
      for (const key of ['version', 'workingDirPath'] as const) {
        if (entry[key] !== undefined) {
          if (typeof entry[key] !== 'string') return invalid();
          result[key] = entry[key];
        }
      }
      if (entry.diagnostics !== undefined) {
        if (!Array.isArray(entry.diagnostics)) return invalid();
        result.diagnostics = entry.diagnostics.map((diagnostic: unknown) => {
          if (
            !object(diagnostic) ||
            typeof diagnostic.code !== 'string' ||
            typeof diagnostic.message !== 'string'
          )
            return invalid();
          return { code: diagnostic.code, message: diagnostic.message };
        });
      }
      return result;
    },
  );
  return { harnesses };
}
