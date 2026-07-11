import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './builder.js';

import type { PiDriverPorts } from '@agenetes/pi-driver';

const piPorts: PiDriverPorts = {
  async resolveModel() {
    throw new Error('not used while mounting');
  },
  async getApiKey() {
    throw new Error('not used while mounting');
  },
  async resolveTools() {
    return [];
  },
};

describe('mountAgenetes standard factories', () => {
  it('registers the preinstalled ACP and pi factories without addFactory', () => {
    expect(() =>
      mountAgenetes()
        .register('external', 'acp')
        .register('internal', 'pi', { ports: piPorts })
        .build(),
    ).not.toThrow();
  });
});
