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

  it('requires SKILL.md whenever the package publishes entry.mjs', () => {
    const result = serviceManifestSchema.safeParse({
      ...manifest,
      package: { files: ['entry.mjs'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects ambiguous package paths, duplicate field ids, and empty updates', () => {
    for (const file of [
      'scripts/',
      '../entry.mjs',
      'scripts\\entry.mjs',
      'C:/entry.mjs',
    ]) {
      expect(
        serviceManifestSchema.safeParse({
          ...manifest,
          package: { files: [file] },
        }).success,
      ).toBe(false);
    }
    expect(
      serviceManifestSchema.safeParse({
        ...manifest,
        package: { files: ['SKILL.md', 'SKILL.md'] },
      }).success,
    ).toBe(false);
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
