// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { registerOpCounterHook } from './op-counter-hook.js';

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  bump: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../agent-defaults.js', () => ({ getAgentDefaults: mocks.defaults }));
vi.mock('./index.js', () => ({
  bumpOpCounter: mocks.bump,
  enqueue: mocks.enqueue,
}));

const app = Fastify();
registerOpCounterHook(app);
app.post('/api/canvas/:id/events', async () => ({ ok: true }));
app.post('/api/agent', async () => ({ ok: true }));
afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  mocks.defaults.mockReturnValue({ profileId: 'huabu', functionalModel: '' });
  mocks.bump.mockResolvedValue(true);
});

describe('legacy curator eligibility', () => {
  it.each([null, 'external'])(
    'does not accumulate new operations for default %s',
    async (profileId) => {
      mocks.defaults.mockReturnValue({ profileId, functionalModel: '' });
      await app.inject({
        method: 'POST',
        url: '/api/canvas/space-a/events',
        payload: { events: [{}, {}] },
      });
      await app.inject({
        method: 'POST',
        url: '/api/agent',
        payload: { canvasId: 'space-a' },
      });
      expect(mocks.bump).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it('retains weighted events and chat triggers for a Built-In default', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/canvas/space-a/events',
      payload: { events: [{}, {}] },
    });
    await app.inject({
      method: 'POST',
      url: '/api/agent',
      payload: { canvasId: 'space-a' },
    });
    expect(mocks.bump.mock.calls).toEqual([
      ['space-a', 2],
      ['space-a', 1],
    ]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it('does not break requests or start Pi when defaults cannot be read', async () => {
    mocks.defaults.mockImplementation(() => {
      throw new Error('corrupt defaults');
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent',
          payload: { canvasId: 'space-a' },
        })
      ).statusCode,
    ).toBe(200);
    expect(mocks.bump).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
