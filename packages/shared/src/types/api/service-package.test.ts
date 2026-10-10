// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  serviceConfigUpdateSchema,
  serviceManifestSchema,
} from './service-package.js';

const manifest = {
  schema: 'huabu-service/v1',
  id: 'example',
  version: '1.0.0',
  name: 'Example',
  description: 'Example Service',
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

describe('Service Package contract', () => {
  it('accepts a Server-consumed package without Agent files', () => {
    expect(serviceManifestSchema.parse(manifest)).toMatchObject({
      id: 'example',
    });
  });

  it('requires a Skill whenever the package declares Agent behavior', () => {
    const result = serviceManifestSchema.safeParse({
      ...manifest,
      agent: { client: 'client.mjs' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate field ids and empty updates', () => {
    expect(
      serviceManifestSchema.safeParse({
        ...manifest,
        configuration: [
          ...manifest.configuration,
          { ...manifest.configuration[0] },
        ],
      }).success,
    ).toBe(false);
    expect(serviceConfigUpdateSchema.safeParse({ values: {} }).success).toBe(
      false,
    );
  });
});
