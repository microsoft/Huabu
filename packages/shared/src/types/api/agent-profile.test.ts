// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { acpAgentCliListResponseSchema, acpAgentProfileSchema } from './acp.js';
import {
  agentProfileListSchema,
  agentProfileParamsSchema,
  agentProfileSchema,
  createAcpCommandProfileBodySchema,
  createAgentProfileBodySchema,
  patchAgentProfileBodySchema,
} from './agent-profile.js';

const commandBody = {
  alias: 'Reviewer',
  workingDirPath: '/work/project',
  launch: { kind: 'acp-command', command: 'copilot --acp' },
  metadata: { cliId: 'copilot' },
  customData: { icon: { shape: 'circle', color: 'blue' }, note: 'keep' },
};

describe('ordinary command Profile contracts', () => {
  it('preserves the command create body without an agentlet id or directory wrapper', () => {
    expect(createAcpCommandProfileBodySchema.parse(commandBody)).toEqual(
      commandBody,
    );
    expect(
      createAgentProfileBodySchema.parse({
        ...commandBody,
        agentletId: 'local',
      }),
    ).toEqual({ ...commandBody, agentletId: 'local' });
    expect(
      createAcpCommandProfileBodySchema.safeParse({
        ...commandBody,
        workingDirectory: { kind: 'default' },
      }).success,
    ).toBe(false);
  });

  it.each(['/work/project', 'C:\\work\\project', '\\\\host\\share'])(
    'accepts an absolute working directory: %s',
    (workingDirPath) => {
      expect(
        createAcpCommandProfileBodySchema.safeParse({
          ...commandBody,
          workingDirPath,
        }).success,
      ).toBe(true);
    },
  );

  it.each([undefined, '', 'relative/project', ' /work/project'])(
    'rejects a missing or invalid working directory: %s',
    (workingDirPath) => {
      expect(
        createAcpCommandProfileBodySchema.safeParse({
          ...commandBody,
          workingDirPath,
        }).success,
      ).toBe(false);
    },
  );

  it('allows Profiles to share an agentlet and CLI', () => {
    const profiles = ['one', 'two'].map((id) => ({
      ...commandBody,
      id,
      agentletId: 'local',
    }));
    expect(agentProfileListSchema.parse({ profiles })).toEqual({ profiles });
  });

  it('rejects unsupported launch kinds', () => {
    expect(
      agentProfileSchema.safeParse({
        ...commandBody,
        id: 'one',
        agentletId: 'local',
        launch: { kind: 'unsupported' },
      }).success,
    ).toBe(false);
  });

  it('patches only mutable display/metadata fields', () => {
    const patch = { alias: 'New name', customData: commandBody.customData };
    expect(patchAgentProfileBodySchema.parse(patch)).toEqual(patch);
    expect(patchAgentProfileBodySchema.safeParse({}).success).toBe(false);
    expect(
      patchAgentProfileBodySchema.safeParse({ workingDirPath: '/new/path' })
        .success,
    ).toBe(false);
    expect(
      patchAgentProfileBodySchema.safeParse({ launch: commandBody.launch })
        .success,
    ).toBe(false);
  });

  it('accepts optional command fields only in the read-only legacy migration shape', () => {
    const legacy = {
      id: 'old',
      displayName: 'Old command',
      cliId: 'custom',
      autoRestart: false,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(acpAgentProfileSchema.safeParse(legacy).success).toBe(true);
    expect(
      acpAgentProfileSchema.safeParse({
        ...legacy,
        command: 'agent --acp',
        cwd: '/work',
      }).success,
    ).toBe(true);
  });

  it('validates nonempty route Profile ids', () => {
    expect(agentProfileParamsSchema.parse({ id: 'profile-1' })).toEqual({
      id: 'profile-1',
    });
    expect(agentProfileParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(agentProfileParamsSchema.safeParse({}).success).toBe(false);
  });

  it('preserves daemon catalogue diagnostics without maintaining a host catalogue', () => {
    const response = {
      agents: [
        {
          id: 'future-cli',
          displayName: 'Future CLI',
          binary: 'future-cli',
          acpArgs: ['acp'],
          autoApprove: null,
          installed: false,
          installHint: 'Install the CLI',
          diagnostics: [{ code: 'missing', message: 'Not on PATH' }],
        },
      ],
    };
    expect(acpAgentCliListResponseSchema.parse(response)).toEqual(response);
  });
});
