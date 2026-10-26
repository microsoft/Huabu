// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  acpAgentletDiscoveryBodySchema,
  acpAgentletDiscoveryParamsSchema,
  acpAgentletDiscoveryResponseSchema,
} from './acp.js';

describe('explicit device discovery contracts', () => {
  it('requires an exact nonempty identity and strict empty body', () => {
    expect(
      acpAgentletDiscoveryParamsSchema.parse({ agentletId: ' device ' }),
    ).toEqual({ agentletId: ' device ' });
    expect(
      acpAgentletDiscoveryParamsSchema.safeParse({ agentletId: ' ' }).success,
    ).toBe(false);
    expect(acpAgentletDiscoveryParamsSchema.safeParse({}).success).toBe(false);
    expect(acpAgentletDiscoveryBodySchema.parse({})).toEqual({});
    expect(
      acpAgentletDiscoveryBodySchema.safeParse({ prepareWorkspaces: false })
        .success,
    ).toBe(false);
  });

  it.each(['ready', 'adapter-missing', 'not-found'] as const)(
    'preserves readiness, diagnostics and reconciliation for %s',
    (status) => {
      const response = {
        agentletId: 'device',
        harnesses: [
          {
            id: 'claude',
            displayName: 'Claude',
            status,
            profileStatus: 'skipped',
            capabilities: { autoApprove: false, customLaunchCommand: false },
            installHint: 'Install the ACP adapter',
            diagnostics: [
              { code: 'workspace_failed', message: 'Permission denied' },
            ],
          },
        ],
      };
      expect(acpAgentletDiscoveryResponseSchema.parse(response)).toEqual(
        response,
      );
      expect(
        acpAgentletDiscoveryResponseSchema.safeParse({
          ...response,
          harnesses: [{ ...response.harnesses[0], profileStatus: 'unknown' }],
        }).success,
      ).toBe(false);
    },
  );
});
