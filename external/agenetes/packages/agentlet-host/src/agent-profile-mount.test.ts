import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  getAgentProfileRegistry,
  mountAgentProfileRegistry,
} from './agent-profile-mount.js';

describe('Profile mounting', () => {
  it('mounts without machine control or SecretStore and does not resurrect deleted legacy Profiles', async () => {
    const storageDir = resolve(`.mount-test-${randomUUID()}`);
    const options = {
      storageDir,
      legacyCommandProfiles: [
        {
          id: 'legacy',
          alias: 'Agent',
          agentletId: 'target',
          workingDirPath: '/work',
          command: 'agent',
        },
      ],
    };
    let app = Fastify();
    try {
      mountAgentProfileRegistry(app, options);
      await app.ready();
      expect(getAgentProfileRegistry()?.listSelectableProfileIds()).toEqual([
        'legacy',
      ]);
      getAgentProfileRegistry()?.deleteProfile('legacy');
      await app.close();
      expect(getAgentProfileRegistry()).toBeNull();
      app = Fastify();
      mountAgentProfileRegistry(app, options);
      await app.ready();
      expect(getAgentProfileRegistry()?.listProfiles()).toEqual([]);
    } finally {
      await app.close();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
