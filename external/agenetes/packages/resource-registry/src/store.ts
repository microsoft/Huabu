import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { agentResourceSchema } from '@agenetes/protocol';

import type { ResourceRegistryState, ResourceRegistryStore } from './types.js';
import type { AgentResource } from '@agenetes/protocol';

/**
 * Backoff schedule (ms) for a rename whose target is momentarily locked.
 * Same rationale as the Agent Team registry store: a POSIX rename(2)
 * replaces the destination atomically and cannot fail this way, but
 * Windows's `MoveFileEx` reports `EPERM`/`EACCES`/`EBUSY` whenever a virus
 * scanner, cloud-sync client, editor, or file watcher holds the file open.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameOverWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        !isTransientRenameError(err)
      ) {
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

const RESOURCE_REGISTRY_SCHEMA_VERSION = 2;
const RESOURCE_REGISTRY_FILENAME = 'resources.json';

interface ResourceRegistryFile {
  schemaVersion: typeof RESOURCE_REGISTRY_SCHEMA_VERSION;
  state: ResourceRegistryState;
}

function emptyState(): ResourceRegistryState {
  return { resources: [] };
}

function cloneState(state: ResourceRegistryState): ResourceRegistryState {
  return structuredClone(state);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and bound-validate one persisted record through the canonical
 * `AgentResource` schema (§6, §15). An unsupported or malformed record
 * fails the whole load explicitly rather than being coerced or dropped.
 */
function parseResource(value: unknown, index: number): AgentResource {
  const parsed = agentResourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid Resource Registry: resources[${index}] is not a valid AgentResource (${parsed.error.message})`,
    );
  }
  return parsed.data;
}

function migrateLegacyResource(value: unknown, index: number): AgentResource {
  if (!isObject(value)) {
    throw new Error(
      `Invalid Resource Registry: resources[${index}] is not a valid AgentResource`,
    );
  }
  const { id, name, provider, description, instructions } = value;
  if (
    value.schemaVersion !== 1 ||
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof provider !== 'string' ||
    typeof description !== 'string' ||
    typeof instructions !== 'string'
  ) {
    throw new Error(
      `Invalid Resource Registry: resources[${index}] is not a valid AgentResource`,
    );
  }
  return parseResource(
    {
      schemaVersion: 2,
      id,
      name,
      provider,
      sourceContent: `${description.trim()}\n\n${instructions.trim()}`,
      userContent: '',
    },
    index,
  );
}

function parseRegistryFile(value: unknown): ResourceRegistryState {
  if (!isObject(value) || !isObject(value.state)) {
    throw new Error('Unsupported or invalid Resource Registry schema');
  }
  if (
    value.schemaVersion !== 1 &&
    value.schemaVersion !== RESOURCE_REGISTRY_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported or invalid Resource Registry schema');
  }
  if (!Array.isArray(value.state.resources)) {
    throw new Error(
      'Invalid Resource Registry state: resources must be an array',
    );
  }
  const resources =
    value.schemaVersion === 1
      ? value.state.resources.map(migrateLegacyResource)
      : value.state.resources.map(parseResource);
  const ids = new Set(resources.map((resource) => resource.id));
  if (ids.size !== resources.length) {
    throw new Error('Invalid Resource Registry: duplicate resource id');
  }
  return { resources };
}

/** In-memory test double; mirrors `InMemoryAgentTeamRegistryStore`. */
export class InMemoryResourceRegistryStore implements ResourceRegistryStore {
  private state: ResourceRegistryState;

  constructor(initialState: ResourceRegistryState = emptyState()) {
    this.state = cloneState(initialState);
  }

  load(): ResourceRegistryState {
    return cloneState(this.state);
  }

  save(state: ResourceRegistryState): void {
    this.state = cloneState(state);
  }
}

/**
 * The first persistent Resource Registry store (§6): its own versioned
 * `resources.json` envelope, atomic replacement, and best-effort
 * owner-only file permissions. Independent from the Agent Team
 * `registry.json` store — an unrecognized store or record schema version
 * fails explicitly instead of being coerced.
 */
export class FileResourceRegistryStore implements ResourceRegistryStore {
  private readonly filePath: string;

  constructor(storageDir: string) {
    if (!isAbsolute(storageDir)) {
      throw new Error('Resource Registry storage directory must be absolute');
    }
    this.filePath = join(storageDir, RESOURCE_REGISTRY_FILENAME);
  }

  load(): ResourceRegistryState {
    if (!existsSync(this.filePath)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Failed to read Resource Registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseRegistryFile(parsed);
  }

  save(state: ResourceRegistryState): void {
    const candidate: ResourceRegistryFile = {
      schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
      state: cloneState(state),
    };
    const file: ResourceRegistryFile = {
      schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
      state: parseRegistryFile(candidate),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameOverWithRetry(temporaryPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // POSIX permissions are best-effort on platforms that support them.
    }
  }
}
