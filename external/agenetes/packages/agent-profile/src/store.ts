import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { AgentProfileError } from './errors.js';

import type {
  AgentProfile,
  AgentProfileRegistryState,
  AgentProfileRegistryStore,
} from './types.js';

const nonempty = z.string().refine((value) => value.trim().length > 0);
const identity = nonempty.refine((value) => value === value.trim());
export const profileSchema = z
  .object({
    id: identity,
    alias: identity,
    agentletId: nonempty,
    workingDirPath: nonempty,
    launch: z
      .object({ kind: z.literal('acp-command'), command: nonempty })
      .strict(),
    metadata: z.object({ cliId: z.string().optional() }).optional(),
    customData: z.record(z.string(), z.json()).optional(),
  })
  .strict();
const stateSchema = z.object({ profiles: z.array(profileSchema) }).strict();
const fileSchema = z
  .object({ schemaVersion: z.literal(1), state: stateSchema })
  .strict();
const legacySchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  state: z.record(z.string(), z.unknown()),
});

export function parseProfile(value: unknown): AgentProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success)
    throw new AgentProfileError(
      'invalid_registry',
      `Invalid Agent Profile: ${parsed.error.message}`,
    );
  return parsed.data;
}

export function parseState(value: unknown): AgentProfileRegistryState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success)
    throw new AgentProfileError(
      'invalid_registry',
      `Invalid Agent Profile registry: ${parsed.error.message}`,
    );
  const ids = new Set<string>();
  for (const profile of parsed.data.profiles) {
    if (ids.has(profile.id))
      throw new AgentProfileError(
        'profile_conflict',
        `Duplicate Agent Profile ID: ${profile.id}`,
      );
    ids.add(profile.id);
  }
  return parsed.data;
}

export function readLegacyProfiles(storageDir: string): AgentProfile[] {
  const filePath = join(storageDir, 'registry.json');
  if (!existsSync(filePath)) return [];
  const parsed = legacySchema.safeParse(readJson(filePath));
  if (!parsed.success)
    throw new AgentProfileError(
      'invalid_registry',
      `Invalid legacy registry: ${parsed.error.message}`,
    );
  if (parsed.data.schemaVersion === 1) return [];
  const profiles = parsed.data.state.profiles;
  if (!Array.isArray(profiles))
    throw new AgentProfileError(
      'invalid_registry',
      'Legacy registry profiles must be an array',
    );
  const commandProfiles: AgentProfile[] = [];
  for (const profile of profiles) {
    const retired = z
      .object({ launch: z.object({ kind: z.literal('agent-team-manifest') }) })
      .safeParse(profile);
    if (retired.success) continue;
    commandProfiles.push(parseProfile(profile));
  }
  return parseState({ profiles: commandProfiles }).profiles;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new AgentProfileError(
      'invalid_registry',
      `Cannot read Agent Profile registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class InMemoryAgentProfileRegistryStore implements AgentProfileRegistryStore {
  private state: AgentProfileRegistryState;
  constructor(initialState: AgentProfileRegistryState = { profiles: [] }) {
    this.state = parseState(initialState);
  }
  load(): AgentProfileRegistryState {
    return structuredClone(this.state);
  }
  save(state: AgentProfileRegistryState): void {
    this.state = parseState(state);
  }
}

export class FileAgentProfileRegistryStore implements AgentProfileRegistryStore {
  private readonly filePath: string;
  constructor(private readonly storageDir: string) {
    if (!isAbsolute(storageDir))
      throw new AgentProfileError(
        'invalid_registry',
        'Agent Profile storage directory must be absolute',
      );
    this.filePath = join(storageDir, 'registry.json');
  }
  exists(): boolean {
    return existsSync(this.filePath);
  }
  load(): AgentProfileRegistryState {
    if (!this.exists()) return { profiles: [] };
    const parsed = fileSchema.safeParse(readJson(this.filePath));
    if (!parsed.success)
      throw new AgentProfileError(
        'invalid_registry',
        `Invalid Agent Profile registry: ${parsed.error.message}`,
      );
    return parseState(parsed.data.state);
  }
  save(state: AgentProfileRegistryState): void {
    const candidate = { schemaVersion: 1, state: parseState(state) };
    mkdirSync(this.storageDir, { recursive: true });
    const pendingPath = `${this.filePath}.pending`;
    try {
      writeFileSync(pendingPath, `${JSON.stringify(candidate, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      // Windows readers may briefly lock the destination; retain the existing bounded retry policy.
      const delays = [10, 20, 40, 80, 160];
      for (let attempt = 0; ; attempt += 1) {
        try {
          renameSync(pendingPath, this.filePath);
          break;
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error ? error.code : undefined;
          if (
            attempt >= delays.length ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))
          )
            throw error;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            delays[attempt],
          );
        }
      }
    } finally {
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
    }
  }
}
