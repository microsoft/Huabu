import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentTeamRegistry,
  mountAgentTeamRegistry,
} from './agent-team-mount.js';

import type { AgentTeamControlPort } from '@agenetes/agent-team';
import type { AgentTeamSetupProgressParams } from '@agentlet/protocol';
import type { FastifyInstance } from 'fastify';

class FakeControlPort implements AgentTeamControlPort {
  readonly handlers = new Set<
    (machine: string, progress: AgentTeamSetupProgressParams) => void
  >();

  listAgentTeamMachines() {
    return [{ machine: 'machine-a', hostname: 'machine-a', platform: 'linux' }];
  }

  onAgentTeamMachinesChanged(): () => void {
    return () => {};
  }

  async scanAgentTeams(_machine: string, params: { rootPath: string }) {
    return { rootPath: params.rootPath, members: [], diagnostics: [] };
  }

  async setupAgentTeam(
    _machine: string,
    params: Parameters<AgentTeamControlPort['setupAgentTeam']>[1],
  ) {
    return { operationId: params.operationId, accepted: true as const };
  }

  async cancelAgentTeamSetup(
    _machine: string,
    params: Parameters<AgentTeamControlPort['cancelAgentTeamSetup']>[1],
  ) {
    return { operationId: params.operationId, cancelled: true };
  }

  async validateAgentTeam() {
    return { valid: true, issues: [] };
  }

  onAgentTeamSetupProgress(
    handler: (machine: string, progress: AgentTeamSetupProgressParams) => void,
  ): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

let app: FastifyInstance | undefined;
let storageDir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  storageDir = undefined;
});

describe('Agent Team mount', () => {
  it('mounts one registry and disposes its Gateway subscription on close', async () => {
    app = Fastify({ logger: false });
    storageDir = mkdtempSync(join(tmpdir(), 'agenetes-agent-team-'));
    const controlPort = new FakeControlPort();
    const options = {
      storageDir,
      secretStore: {
        get: vi.fn(() => null),
        setMany: vi.fn(async () => {}),
      },
    };

    mountAgentTeamRegistry(app, options, controlPort);
    mountAgentTeamRegistry(app, options, controlPort);

    expect(getAgentTeamRegistry()).toBeNull();
    await app.ready();

    const registry = getAgentTeamRegistry();
    expect(getAgentTeamRegistry()).toBe(registry);
    expect(controlPort.handlers.size).toBe(1);

    await app.close();
    app = undefined;

    expect(getAgentTeamRegistry()).toBeNull();
    expect(controlPort.handlers.size).toBe(0);
  });
});
