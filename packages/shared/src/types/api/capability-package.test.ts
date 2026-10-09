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
  consumers: { internal: false, pipeline: true, external: false },
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
  it('accepts a pipeline-only package without Agent files', () => {
    expect(capabilityManifestSchema.parse(manifest)).toMatchObject({
      id: 'example',
      consumers: { external: false },
    });
  });

  it('requires a Skill for an External Agent package', () => {
    const result = capabilityManifestSchema.safeParse({
      ...manifest,
      consumers: { internal: false, pipeline: false, external: true },
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
