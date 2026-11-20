import { DAEMON_ENV_KEYS } from '@agentlet/protocol';

type Environment = Readonly<Record<string, string | undefined>>;

function canonicalKey(key: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? key.toUpperCase() : key;
}

function validateEntry(key: string, value: unknown): asserts value is string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('Invalid environment key');
  }
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`Invalid environment value for ${key}`);
  }
}

export function createBootstrapEnv(
  entries: Iterable<readonly [string, string]> = [],
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const keys = new Set<string>();
  for (const [key, value] of entries) {
    validateEntry(key, value);
    const canonical = canonicalKey(key, platform);
    if (
      DAEMON_ENV_KEYS.some((key) => canonical === canonicalKey(key, platform))
    ) {
      throw new Error(`Reserved environment key: ${key}`);
    }
    if (keys.has(canonical))
      throw new Error(`Duplicate bootstrap environment key: ${key}`);
    keys.add(canonical);
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return Object.freeze(result);
}

export function parseBootstrapEnv(
  declarations: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  return createBootstrapEnv(
    declarations.map((declaration) => {
      const separator = declaration.indexOf('=');
      if (separator < 0)
        throw new Error('Environment injection requires KEY=VALUE');
      return [
        declaration.slice(0, separator),
        declaration.slice(separator + 1),
      ] as const;
    }),
    platform,
  );
}

export function mergeAgentEnvironment(
  inherited: Environment,
  session: Environment,
  bootstrap: Readonly<Record<string, string>>,
  authoritative: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('Invalid session environment');
  }
  const protectedKeys = new Set(
    [...Object.keys(bootstrap), ...DAEMON_ENV_KEYS].map((key) =>
      canonicalKey(key, platform),
    ),
  );
  for (const [key, value] of Object.entries(session)) {
    validateEntry(key, value);
    if (protectedKeys.has(canonicalKey(key, platform))) {
      throw new Error(
        `Session cannot override protected environment key: ${key}`,
      );
    }
  }
  const result: NodeJS.ProcessEnv = {};
  for (const environment of [inherited, session, authoritative, bootstrap]) {
    for (const [key, value] of Object.entries(environment)) {
      if (platform === 'win32') {
        for (const existing of Object.keys(result)) {
          if (canonicalKey(existing, platform) === canonicalKey(key, platform))
            delete result[existing];
        }
      }
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}

export function interpolateBootstrapDestination(
  destination: string,
  bootstrap: Readonly<Record<string, string>>,
): string {
  return destination.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    if (!Object.hasOwn(bootstrap, key))
      throw new Error(`Unknown bootstrap environment key: ${key}`);
    return bootstrap[key]!;
  });
}
