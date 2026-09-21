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
      | 'harness_launch_preview_unsupported'
      | 'invalid_harness_launch_preview_response'
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
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
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
        typeof entry.binary !== 'string' ||
        !entry.binary.trim() ||
        typeof entry.installHint !== 'string' ||
        !strings(entry.acpArgs) ||
        typeof entry.installed !== 'boolean'
      )
        return invalid();
      if (ids.has(entry.id)) return invalid();
      ids.add(entry.id);
      let autoApprove: HarnessDiscoveryEntry['autoApprove'] = null;
      if (entry.autoApprove !== null) {
        if (
          !object(entry.autoApprove) ||
          !strings(entry.autoApprove.args) ||
          (entry.autoApprove.position !== 'before-acp' &&
            entry.autoApprove.position !== 'after-acp')
        )
          return invalid();
        autoApprove = {
          args: entry.autoApprove.args,
          position: entry.autoApprove.position,
        };
      }
      const result: HarnessDiscoveryEntry = {
        id: entry.id,
        displayName: entry.displayName,
        binary: entry.binary,
        acpArgs: entry.acpArgs,
        autoApprove,
        installHint: entry.installHint,
        installed: entry.installed,
      };
      if (entry.capabilities !== undefined) {
        if (!object(entry.capabilities)) return invalid();
        const capabilities = entry.capabilities;
        const statuses = ['supported', 'unsupported', 'unknown'];
        if (
          ['autoApprove', 'modelOverride', 'sessionPersistence'].some(
            (key) =>
              typeof capabilities[key] !== 'string' ||
              !statuses.includes(capabilities[key]),
          )
        )
          return invalid();
        result.capabilities = {
          autoApprove: capabilities.autoApprove as NonNullable<
            HarnessDiscoveryEntry['capabilities']
          >['autoApprove'],
          modelOverride: capabilities.modelOverride as NonNullable<
            HarnessDiscoveryEntry['capabilities']
          >['modelOverride'],
          sessionPersistence: capabilities.sessionPersistence as NonNullable<
            HarnessDiscoveryEntry['capabilities']
          >['sessionPersistence'],
        };
        if (capabilities.customLaunchCommand !== undefined) {
          if (
            typeof capabilities.customLaunchCommand !== 'string' ||
            !statuses.includes(capabilities.customLaunchCommand)
          )
            return invalid();
          result.capabilities.customLaunchCommand =
            capabilities.customLaunchCommand as NonNullable<
              HarnessDiscoveryEntry['capabilities']
            >['customLaunchCommand'];
        }
      }
      if (entry.launchVersion !== undefined) {
        if (entry.launchVersion !== 1) return invalid();
        result.launchVersion = 1;
      }
      if (entry.launchPreviewVersion !== undefined) {
        if (entry.launchPreviewVersion !== 1) return invalid();
        result.launchPreviewVersion = 1;
      }
      for (const key of [
        'executablePath',
        'version',
        'workingDirPath',
      ] as const) {
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
