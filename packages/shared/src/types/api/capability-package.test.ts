// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  capabilityConfigUpdateSchema,
  capabilityManifestSchema,
} from './capability-package.js';

const manifest = {
  schema: 'huabu-capability/v1',
  id: 'example',
  version: '1.0.0',
  name: 'Example',
  description: 'Example Capability',
  storage: { namespace: 'integration.example' },
  configuration: [
    {
      id: 'apiKey',
      label: 'API key',
      type: 'secret',
      required: true,
    },
  ],
};

describe('Capability Package contract', () => {
  it('accepts a Server-consumed package without Agent files', () => {
    expect(capabilityManifestSchema.parse(manifest)).toMatchObject({
      id: 'example',
    });
  });

  it('requires a Skill whenever the package declares Agent behavior', () => {
    const result = capabilityManifestSchema.safeParse({
      ...manifest,
      agent: { client: 'client.mjs' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate field ids and empty updates', () => {
    expect(
      capabilityManifestSchema.safeParse({
        ...manifest,
        configuration: [
          ...manifest.configuration,
          { ...manifest.configuration[0] },
        ],
      }).success,
    ).toBe(false);
    expect(capabilityConfigUpdateSchema.safeParse({ values: {} }).success).toBe(
      false,
    );
  });
});
