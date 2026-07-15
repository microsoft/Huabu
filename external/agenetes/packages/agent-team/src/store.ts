import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { agentTeamMemberKey, agentTeamRootKey } from './identity.js';

import type { AgentTeamScanDiagnostic } from '@agentlet/protocol';
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
} from './types.js';

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const REGISTRY_FILENAME = 'registry.json';

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
  const base = {
    id: value.id,
    alias: value.alias,
    agentletId: value.agentletId,
    workingDirPath: value.workingDirPath,
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
      setupLog: parseSetupLog(value.setupLog, `${label}.setupLog`),
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
    setupLog: parseSetupLog(value.setupLog, `${label}.setupLog`),
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
  const isLegacy = value.schemaVersion === LEGACY_SCHEMA_VERSION;
  if (!isLegacy && value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported or invalid Agent Team registry schema`);
  }
  if (
    !Array.isArray(value.state.roots) ||
    !Array.isArray(value.state.members) ||
    (isLegacy
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
  const profileValues = isLegacy
    ? ((value.state.deployments ?? []) as unknown[])
    : ((value.state.profiles ?? []) as unknown[]);
  const state: AgentTeamRegistryState = {
    roots: roots.map(parseRoot),
    members: members.map(parseMember),
    profiles: isLegacy
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

export class InMemoryAgentTeamRegistryStore implements AgentTeamRegistryStore {
  private state: AgentTeamRegistryState;

  constructor(initialState: AgentTeamRegistryState = emptyState()) {
    this.state = cloneState(initialState);
  }

  load(): AgentTeamRegistryState {
    return cloneState(this.state);
  }

  save(state: AgentTeamRegistryState): void {
    this.state = cloneState(state);
  }
}

export class FileAgentTeamRegistryStore implements AgentTeamRegistryStore {
  private readonly filePath: string;

  constructor(storageDir: string) {
    if (!isAbsolute(storageDir)) {
      throw new Error('Agent Team storage directory must be absolute');
    }
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
    if (isObject(parsed) && parsed.schemaVersion === LEGACY_SCHEMA_VERSION) {
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
    renameSync(temporaryPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // POSIX permissions are best-effort on platforms that support them.
    }
  }
}
