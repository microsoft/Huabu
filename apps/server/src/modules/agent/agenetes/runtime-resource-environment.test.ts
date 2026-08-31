import { beforeEach, describe, expect, it } from 'vitest';

import { RESOURCE_GRANT_ENV } from '@huabu/shared';

import { resolveResourceGrantEnvironment } from './runtime-resource-environment.js';
import {
  authorizeResourceGrant,
  resetResourceGrantsForTests,
} from '../hosted-capabilities/resource-grant.js';

import type { AcpSpec } from '@agenetes/acp-driver';

describe('resolveResourceGrantEnvironment', () => {
  beforeEach(() => {
    resetResourceGrantsForTests();
  });

  it('mints a runtime-only grant bound to the durable workload scope', () => {
    const environment = resolveResourceGrantEnvironment({
      binding: { alias: 'Researcher', profileId: 'profile-a' },
      agentletId: 'machine-a',
      resourceIds: ['huabu-access', 'web-search'],
      resourceScope: { canvasId: 'canvas-a', threadId: 'thread-a' },
    } satisfies AcpSpec);

    const token = environment?.[RESOURCE_GRANT_ENV];
    expect(token).toBeTypeOf('string');
    expect(
      authorizeResourceGrant(token, 'canvas-a', 'web-search'),
    ).toMatchObject({
      agentletId: 'machine-a',
      profileId: 'profile-a',
      canvasId: 'canvas-a',
      threadId: 'thread-a',
    });
  });

  it('does not mint a grant for a legacy workload without trusted scope', () => {
    expect(
      resolveResourceGrantEnvironment({
        binding: { alias: 'Legacy', profileId: 'profile-a' },
        agentletId: 'machine-a',
      }),
    ).toBeUndefined();
  });
});
