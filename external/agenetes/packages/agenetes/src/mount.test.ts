import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './mount.js';

const emptySchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as Record<string, never> }
      : { success: false as const, error: new Error('expected object') };
  },
};

const driver = defineDriver({
  schemaVersion: 1,
  workloadTypes: ['Deployment'],
  specSchema: emptySchema,
  stateSchema: emptySchema,
  initialState: () => ({}),
  create: () =>
    ({
      capabilities: {},
      async run() {
        return undefined;
      },
      async control() {
        return { ok: false as const, code: 'unsupported' as const };
      },
      close() {},
    }) as never,
});

describe('mountAgenetes static driver map', () => {
  it('mounts a complete host-constructed driver map', () => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    expect(() =>
      instance.create({
        kind: 'external',
        workloadType: 'Deployment',
        namespace: { name: 'canvas-1' },
        threadId: 'thread-1',
        spec: {},
      }),
    ).not.toThrow();
  });

  it('does not provide mutable post-mount registration', () => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    expect(instance).not.toHaveProperty('addFactory');
    expect(instance).not.toHaveProperty('register');
    expect(instance).not.toHaveProperty('build');
  });
});
