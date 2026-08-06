import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { agentTeamMemberKey, agentTeamRootKey } from './identity.js';

/**
 * Backoff schedule (ms) for a rename whose target is momentarily locked.
 * Bounded at ~310ms: long enough to outlast a virus scan or a cloud-sync
 * client's read, short enough that a genuinely broken write still fails fast.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

/**
 * Windows fails a rename whose destination is open in another handle. Unlike a
 * POSIX `rename(2)`, which replaces the target atomically and cannot fail this
 * way, `MoveFileEx` reports `EPERM` (or `EACCES` / `EBUSY`) whenever a virus
 * scanner, a cloud-sync client, an editor, or a file watcher holds the file
 * open — none of which require a second writer.
 */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/** Blocks the thread; only ever between rename attempts. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** {@link renameSync} that rides out a transiently locked destination. */
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

import type {
  AcpCommandProfile,
  AgentProfile,
  AgentTeamManifestProfile,
  AgentTeamPreparation,
  AgentTeamSetupLogEntry,
  AgentTeamMemberConfig,
  AgentTeamMember,
  AgentTeamRegistryState,
  AgentTeamRegistryStore,
  AgentTeamRoot,
  AgentTeamRootRef,
  AgentTeamRootScan,
  JsonValue,
} from './types.js';
import type { AgentTeamScanDiagnostic } from '@agentlet/protocol';

const SCHEMA_VERSION = 3;
const PROFILE_SCHEMA_VERSION = 2;
const DISCOVERY_SCHEMA_VERSION = 1;
const REGISTRY_FILENAME = 'registry.json';
const SETUP_LOG_LIMIT = 200;

interface RegistryFile {
  schemaVersion: typeof SCHEMA_VERSION;
  state: AgentTeamRegistryState;
}

function emptyState(): AgentTeamRegistryState {
  return { roots: [], members: [], profiles: [], configs: [] };
}

function cloneState(state: AgentTeamRegistryState): AgentTeamRegistryState {
  return structuredClone(state);
}

function setRecordValue(
  record: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Invalid Agent Team registry: ${label} must be a non-empty string`,
    );
  }
}

/**
 * Round-trip the opaque {@link AgentProfileBase.customData} bag. agenetes never
 * interprets its contents, so we only require it to be a JSON object; a
 * JSON round-trip strips anything non-serializable (functions, `undefined`).
 */
function parseCustomData(
  value: unknown,
  label: string,
): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  } catch {
    throw new Error(
      `Invalid Agent Team registry: ${label} must be JSON-serializable`,
    );
  }
}

function parseRootRef(value: unknown, label: string): AgentTeamRootRef {
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  assertString(value.machine, `${label}.machine`);
  assertString(value.path, `${label}.path`);
  return { machine: value.machine, path: value.path };
}

function parseRootScan(value: unknown, label: string): AgentTeamRootScan {
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  if (value.status === 'never_scanned') return { status: 'never_scanned' };
  if (value.status === 'error') {
    if (
      typeof value.attemptedAt !== 'number' ||
      !Number.isFinite(value.attemptedAt)
    ) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.attemptedAt must be a number`,
      );
    }
    assertString(value.message, `${label}.message`);
    return {
      status: 'error',
      attemptedAt: value.attemptedAt,
      message: value.message,
    };
  }
  if (value.status === 'success') {
    if (
      typeof value.scannedAt !== 'number' ||
      !Number.isFinite(value.scannedAt)
    ) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.scannedAt must be a number`,
      );
    }
    if (!Array.isArray(value.diagnostics)) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.diagnostics must be an array`,
      );
    }
    const diagnostics = value.diagnostics.map<AgentTeamScanDiagnostic>(
      (diagnostic, index) => {
        if (!isObject(diagnostic)) {
          throw new Error(
            `Invalid Agent Team registry: ${label}.diagnostics[${index}] must be an object`,
          );
        }
        assertString(
          diagnostic.manifestPath,
          `${label}.diagnostics[${index}].manifestPath`,
        );
        assertString(
          diagnostic.message,
          `${label}.diagnostics[${index}].message`,
        );
        const code = diagnostic.code;
        if (code !== 'invalid_manifest' && code !== 'manifest_unreadable') {
          throw new Error(
            `Invalid Agent Team registry: ${label}.diagnostics[${index}].code`,
          );
        }
        return {
          manifestPath: diagnostic.manifestPath,
          code,
          message: diagnostic.message,
        };
      },
    );
    return { status: 'success', scannedAt: value.scannedAt, diagnostics };
  }
  throw new Error(`Invalid Agent Team registry: ${label}.status`);
}

function parseRoot(value: unknown, index: number): AgentTeamRoot {
  if (!isObject(value)) {
    throw new Error(
      `Invalid Agent Team registry: roots[${index}] must be an object`,
    );
  }
  const ref = parseRootRef(value, `roots[${index}]`);
  return {
    ...ref,
    scan: parseRootScan(value.scan, `roots[${index}].scan`),
  };
}

function parseMember(value: unknown, index: number): AgentTeamMember {
  const label = `members[${index}]`;
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  assertString(value.machine, `${label}.machine`);
  assertString(value.manifestPath, `${label}.manifestPath`);
  assertString(value.name, `${label}.name`);
  assertString(value.description, `${label}.description`);
  if (
    !Array.isArray(value.harnesses) ||
    !value.harnesses.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.harnesses must be an array of strings`,
    );
  }
  if (!Array.isArray(value.env)) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.env must be an array`,
    );
  }
  const env = value.env.map((field, fieldIndex) => {
    if (!isObject(field)) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.env[${fieldIndex}] must be an object`,
      );
    }
    assertString(field.name, `${label}.env[${fieldIndex}].name`);
    assertString(field.description, `${label}.env[${fieldIndex}].description`);
    if (
      typeof field.required !== 'boolean' ||
      typeof field.secret !== 'boolean'
    ) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.env[${fieldIndex}] flags must be booleans`,
      );
    }
    if (field.default !== undefined && typeof field.default !== 'string') {
      throw new Error(
        `Invalid Agent Team registry: ${label}.env[${fieldIndex}].default`,
      );
    }
    if (field.secret === true && field.default !== undefined) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.env[${fieldIndex}] secret default`,
      );
    }
    return {
      name: field.name,
      description: field.description,
      required: field.required,
      secret: field.secret,
      ...(field.default === undefined ? {} : { default: field.default }),
    };
  });
  if (!Array.isArray(value.discoveredBy)) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.discoveredBy must be an array`,
    );
  }
  if (value.status !== 'active' && value.status !== 'member_missing') {
    throw new Error(`Invalid Agent Team registry: ${label}.status`);
  }
  return {
    machine: value.machine,
    manifestPath: value.manifestPath,
    name: value.name,
    description: value.description,
    harnesses: [...value.harnesses],
    env,
    discoveredBy: value.discoveredBy.map((root, rootIndex) =>
      parseRootRef(root, `${label}.discoveredBy[${rootIndex}]`),
    ),
    status: value.status,
  };
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be a number`);
  }
  return value;
}

function parsePreparation(value: unknown, label: string): AgentTeamPreparation {
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  if (value.status === 'not_prepared' || value.status === 'disabled') {
    return { status: 'not_prepared' };
  }
  if (value.status === 'setting_up') {
    assertString(value.operationId, `${label}.operationId`);
    return {
      status: 'setting_up',
      operationId: value.operationId,
      startedAt: parseTimestamp(value.startedAt, `${label}.startedAt`),
    };
  }
  if (value.status === 'ready') {
    return {
      status: 'ready',
      completedAt: parseTimestamp(value.completedAt, `${label}.completedAt`),
    };
  }
  if (value.status === 'error') {
    if (!isObject(value.error)) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.error must be an object`,
      );
    }
    assertString(value.error.code, `${label}.error.code`);
    assertString(value.error.message, `${label}.error.message`);
    return {
      status: 'error',
      failedAt: parseTimestamp(value.failedAt, `${label}.failedAt`),
      error: {
        code: value.error.code,
        message: value.error.message,
      },
    };
  }
  throw new Error(`Invalid Agent Team registry: ${label}.status`);
}

const SETUP_PHASES: ReadonlySet<string> = new Set([
  'validating_manifest',
  'preparing_workspace',
  'installing_tools',
  'installing_skills',
  'placing_prompt',
  'copying_files',
  'running_custom_setup',
]);

function isSetupPhase(
  value: unknown,
): value is AgentTeamSetupLogEntry['phase'] {
  return typeof value === 'string' && SETUP_PHASES.has(value);
}

function parseSetupLog(
  value: unknown,
  label: string,
): AgentTeamSetupLogEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an array`);
  }
  return value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isObject(entry)) {
      throw new Error(
        `Invalid Agent Team registry: ${entryLabel} must be an object`,
      );
    }
    const receivedAt = parseTimestamp(
      entry.receivedAt,
      `${entryLabel}.receivedAt`,
    );
    if (!isSetupPhase(entry.phase)) {
      throw new Error(`Invalid Agent Team registry: ${entryLabel}.phase`);
    }
    if (entry.status !== 'started' && entry.status !== 'completed') {
      throw new Error(`Invalid Agent Team registry: ${entryLabel}.status`);
    }
    assertString(entry.message, `${entryLabel}.message`);
    return {
      receivedAt,
      phase: entry.phase,
      status: entry.status,
      message: entry.message,
    };
  });
}

function parseProfile(value: unknown, index: number): AgentProfile {
  const label = `profiles[${index}]`;
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  assertString(value.id, `${label}.id`);
  assertString(value.alias, `${label}.alias`);
  if (value.alias.trim() !== value.alias) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.alias cannot have surrounding whitespace`,
    );
  }
  assertString(value.agentletId, `${label}.agentletId`);
  assertString(value.workingDirPath, `${label}.workingDirPath`);
  if (!isObject(value.launch)) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.launch must be an object`,
    );
  }
  const customData = parseCustomData(value.customData, `${label}.customData`);
  const base = {
    id: value.id,
    alias: value.alias,
    agentletId: value.agentletId,
    workingDirPath: value.workingDirPath,
    ...(customData === undefined ? {} : { customData }),
  };
  if (value.launch.kind === 'agent-team-manifest') {
    assertString(value.launch.manifestPath, `${label}.launch.manifestPath`);
    assertString(value.launch.harness, `${label}.launch.harness`);
    return {
      ...base,
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: value.launch.manifestPath,
        harness: value.launch.harness,
      },
      preparation: parsePreparation(value.preparation, `${label}.preparation`),
    } satisfies AgentTeamManifestProfile;
  }
  if (value.launch.kind !== 'acp-command') {
    throw new Error(`Invalid Agent Team registry: ${label}.launch.kind`);
  }
  assertString(value.launch.command, `${label}.launch.command`);
  let metadata: AcpCommandProfile['metadata'];
  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) {
      throw new Error(
        `Invalid Agent Team registry: ${label}.metadata must be an object`,
      );
    }
    if (
      value.metadata.cliId !== undefined &&
      typeof value.metadata.cliId !== 'string'
    ) {
      throw new Error(`Invalid Agent Team registry: ${label}.metadata.cliId`);
    }
    metadata =
      value.metadata.cliId === undefined ? {} : { cliId: value.metadata.cliId };
  }
  return {
    ...base,
    launch: { kind: 'acp-command', command: value.launch.command },
    ...(metadata === undefined ? {} : { metadata }),
  } satisfies AcpCommandProfile;
}

function migrateDeployment(
  value: unknown,
  index: number,
): AgentTeamManifestProfile {
  const label = `deployments[${index}]`;
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  assertString(value.id, `${label}.id`);
  assertString(value.alias, `${label}.alias`);
  assertString(value.machine, `${label}.machine`);
  assertString(value.manifestPath, `${label}.manifestPath`);
  assertString(value.harness, `${label}.harness`);
  assertString(value.workingDirPath, `${label}.workingDirPath`);
  return {
    id: value.id,
    alias: value.alias,
    agentletId: value.machine,
    workingDirPath: value.workingDirPath,
    launch: {
      kind: 'agent-team-manifest',
      manifestPath: value.manifestPath,
      harness: value.harness,
    },
    preparation: parsePreparation(value.setup, `${label}.setup`),
  };
}

function parseMemberConfig(
  value: unknown,
  index: number,
): AgentTeamMemberConfig {
  const label = `configs[${index}]`;
  if (!isObject(value)) {
    throw new Error(`Invalid Agent Team registry: ${label} must be an object`);
  }
  assertString(value.machine, `${label}.machine`);
  assertString(value.manifestPath, `${label}.manifestPath`);
  if (!isObject(value.values)) {
    throw new Error(
      `Invalid Agent Team registry: ${label}.values must be an object`,
    );
  }
  const values: Record<string, string> = {};
  for (const [name, fieldValue] of Object.entries(value.values)) {
    assertString(name, `${label}.values key`);
    if (typeof fieldValue !== 'string') {
      throw new Error(
        `Invalid Agent Team registry: ${label}.values.${name} must be a string`,
      );
    }
    setRecordValue(values, name, fieldValue);
  }
  return {
    machine: value.machine,
    manifestPath: value.manifestPath,
    values,
  };
}

function parseRegistryFile(value: unknown): AgentTeamRegistryState {
  if (!isObject(value) || !isObject(value.state)) {
    throw new Error(`Unsupported or invalid Agent Team registry schema`);
  }
  const isDiscoverySchema = value.schemaVersion === DISCOVERY_SCHEMA_VERSION;
  if (
    !isDiscoverySchema &&
    value.schemaVersion !== PROFILE_SCHEMA_VERSION &&
    value.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported or invalid Agent Team registry schema`);
  }
  if (
    !Array.isArray(value.state.roots) ||
    !Array.isArray(value.state.members) ||
    (isDiscoverySchema
      ? value.state.deployments !== undefined &&
        !Array.isArray(value.state.deployments)
      : value.state.profiles !== undefined &&
        !Array.isArray(value.state.profiles)) ||
    (value.state.configs !== undefined && !Array.isArray(value.state.configs))
  ) {
    throw new Error('Invalid Agent Team registry state');
  }
  const roots = value.state.roots as unknown[];
  const members = value.state.members as unknown[];
  const configs = (value.state.configs ?? []) as unknown[];
  const profileValues = isDiscoverySchema
    ? ((value.state.deployments ?? []) as unknown[])
    : ((value.state.profiles ?? []) as unknown[]);
  const state: AgentTeamRegistryState = {
    roots: roots.map(parseRoot),
    members: members.map(parseMember),
    profiles: isDiscoverySchema
      ? profileValues.map(migrateDeployment)
      : profileValues.map(parseProfile),
    configs: configs.map(parseMemberConfig),
  };
  const rootKeys = new Set(state.roots.map(agentTeamRootKey));
  if (rootKeys.size !== state.roots.length) {
    throw new Error('Invalid Agent Team registry: duplicate root identity');
  }
  const memberKeys = new Set(state.members.map(agentTeamMemberKey));
  if (memberKeys.size !== state.members.length) {
    throw new Error('Invalid Agent Team registry: duplicate member identity');
  }
  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  if (profileIds.size !== state.profiles.length) {
    throw new Error('Invalid Agent Team registry: duplicate profile id');
  }
  for (const profile of state.profiles) {
    if (profile.launch.kind !== 'agent-team-manifest') continue;
    if (
      !memberKeys.has(
        agentTeamMemberKey({
          machine: profile.agentletId,
          manifestPath: profile.launch.manifestPath,
        }),
      )
    ) {
      throw new Error(
        'Invalid Agent Team registry: profile references an unknown member',
      );
    }
  }
  const configKeys = new Set(
    state.configs.map((config) => agentTeamMemberKey(config)),
  );
  if (configKeys.size !== state.configs.length) {
    throw new Error(
      'Invalid Agent Team registry: duplicate member config identity',
    );
  }
  for (const config of state.configs) {
    if (!memberKeys.has(agentTeamMemberKey(config))) {
      throw new Error(
        'Invalid Agent Team registry: config references an unknown member',
      );
    }
  }
  for (const member of state.members) {
    const discoveryKeys = new Set(member.discoveredBy.map(agentTeamRootKey));
    if (discoveryKeys.size !== member.discoveredBy.length) {
      throw new Error(
        'Invalid Agent Team registry: duplicate discovery provenance',
      );
    }
    if (
      member.discoveredBy.some((root) => !rootKeys.has(agentTeamRootKey(root)))
    ) {
      throw new Error(
        'Invalid Agent Team registry: member references an unknown root',
      );
    }
    if (
      (member.discoveredBy.length === 0) !==
      (member.status === 'member_missing')
    ) {
      throw new Error(
        'Invalid Agent Team registry: member status does not match discovery provenance',
      );
    }
  }
  return state;
}

function extractLegacySetupLogs(
  value: unknown,
): Map<string, AgentTeamSetupLogEntry[]> {
  const result = new Map<string, AgentTeamSetupLogEntry[]>();
  if (!isObject(value) || !isObject(value.state)) return result;
  const values =
    value.schemaVersion === DISCOVERY_SCHEMA_VERSION
      ? value.state.deployments
      : value.state.profiles;
  if (!Array.isArray(values)) return result;
  for (const [index, profile] of values.entries()) {
    if (!isObject(profile) || typeof profile.id !== 'string') continue;
    if (profile.setupLog === undefined) continue;
    result.set(
      profile.id,
      parseSetupLog(profile.setupLog, `profiles[${index}].setupLog`),
    );
  }
  return result;
}

export class InMemoryAgentTeamRegistryStore implements AgentTeamRegistryStore {
  private state: AgentTeamRegistryState;
  private readonly setupLogs = new Map<string, AgentTeamSetupLogEntry[]>();

  constructor(
    initialState: AgentTeamRegistryState = emptyState(),
    setupLogs: Record<string, AgentTeamSetupLogEntry[]> = {},
  ) {
    this.state = cloneState(initialState);
    for (const [profileId, entries] of Object.entries(setupLogs)) {
      this.setupLogs.set(
        profileId,
        structuredClone(entries).slice(-SETUP_LOG_LIMIT),
      );
    }
  }

  load(): AgentTeamRegistryState {
    return cloneState(this.state);
  }

  save(state: AgentTeamRegistryState): void {
    this.state = cloneState(state);
  }

  loadSetupLog(profileId: string): AgentTeamSetupLogEntry[] {
    return structuredClone(this.setupLogs.get(profileId) ?? []);
  }

  resetSetupLog(profileId: string): void {
    this.setupLogs.set(profileId, []);
  }

  appendSetupLog(profileId: string, entry: AgentTeamSetupLogEntry): void {
    this.setupLogs.set(
      profileId,
      [...(this.setupLogs.get(profileId) ?? []), structuredClone(entry)].slice(
        -SETUP_LOG_LIMIT,
      ),
    );
  }

  deleteSetupLog(profileId: string): void {
    this.setupLogs.delete(profileId);
  }
}

export class FileAgentTeamRegistryStore implements AgentTeamRegistryStore {
  private readonly filePath: string;
  private readonly storageDir: string;

  constructor(storageDir: string) {
    if (!isAbsolute(storageDir)) {
      throw new Error('Agent Team storage directory must be absolute');
    }
    this.storageDir = storageDir;
    this.filePath = join(storageDir, REGISTRY_FILENAME);
  }

  load(): AgentTeamRegistryState {
    if (!existsSync(this.filePath)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Failed to read Agent Team registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const state = parseRegistryFile(parsed);
    if (isObject(parsed) && parsed.schemaVersion !== SCHEMA_VERSION) {
      for (const [profileId, entries] of extractLegacySetupLogs(parsed)) {
        this.writeSetupLog(profileId, entries);
      }
      this.save(state);
    }
    return state;
  }

  save(state: AgentTeamRegistryState): void {
    const candidate: RegistryFile = {
      schemaVersion: SCHEMA_VERSION,
      state: cloneState(state),
    };
    const file: RegistryFile = {
      schemaVersion: SCHEMA_VERSION,
      state: parseRegistryFile(candidate),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameOverWithRetry(temporaryPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // POSIX permissions are best-effort on platforms that support them.
    }
  }

  loadSetupLog(profileId: string): AgentTeamSetupLogEntry[] {
    const path = this.setupLogPath(profileId);
    if (!existsSync(path)) return [];
    try {
      const lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      return parseSetupLog(
        lines.map((line) => JSON.parse(line) as unknown),
        `${profileId}.setup.jsonl`,
      ).slice(-SETUP_LOG_LIMIT);
    } catch (error) {
      throw new Error(
        `Failed to read Agent Team setup log for ${profileId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  resetSetupLog(profileId: string): void {
    this.writeSetupLog(profileId, []);
  }

  appendSetupLog(profileId: string, entry: AgentTeamSetupLogEntry): void {
    const [validated] = parseSetupLog([entry], `${profileId}.setup.jsonl`);
    if (!validated) {
      throw new Error(`Invalid Agent Team setup log entry for ${profileId}`);
    }
    const entries = this.loadSetupLog(profileId);
    if (entries.length >= SETUP_LOG_LIMIT) {
      this.writeSetupLog(
        profileId,
        [...entries, validated].slice(-SETUP_LOG_LIMIT),
      );
      return;
    }
    mkdirSync(this.storageDir, { recursive: true });
    const path = this.setupLogPath(profileId);
    appendFileSync(path, `${JSON.stringify(validated)}\n`, 'utf8');
    this.protectFile(path);
  }

  deleteSetupLog(profileId: string): void {
    const path = this.setupLogPath(profileId);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private setupLogPath(profileId: string): string {
    return join(
      this.storageDir,
      `${encodeURIComponent(profileId)}.setup.jsonl`,
    );
  }

  private writeSetupLog(
    profileId: string,
    entries: AgentTeamSetupLogEntry[],
  ): void {
    const validated = parseSetupLog(entries, `${profileId}.setup.jsonl`).slice(
      -SETUP_LOG_LIMIT,
    );
    mkdirSync(this.storageDir, { recursive: true });
    const path = this.setupLogPath(profileId);
    const temporaryPath = `${path}.tmp`;
    const content = validated.map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(temporaryPath, content ? `${content}\n` : '', 'utf8');
    renameOverWithRetry(temporaryPath, path);
    this.protectFile(path);
  }

  private protectFile(path: string): void {
    try {
      chmodSync(path, 0o600);
    } catch {
      // POSIX permissions are best-effort on platforms that support them.
    }
  }
}
