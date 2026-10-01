// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import conversationAgentRoutes from './conversation-agent.route.js';

import type { ConversationAgentPreference } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  preference: { profileId: null } as ConversationAgentPreference,
  set: vi.fn(),
  profiles: new Map([
    ['first', { id: 'first', agentletId: 'machine-a' }],
    ['second', { id: 'second', agentletId: 'machine-b' }],
  ]),
}));

vi.mock('./conversation-agent.js', () => ({
  getConversationAgentPreference: () => mocks.preference,
  getEffectiveConversationAgentProfileId: () =>
    mocks.preference.profileId ?? 'first',
  setConversationAgentPreference: mocks.set.mockImplementation(
    (preference: ConversationAgentPreference) => {
      mocks.preference = preference;
      return preference;
    },
  ),
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({
    getProfile: (profileId: string) => mocks.profiles.get(profileId),
    listSelectableProfileIds: () => [...mocks.profiles.keys()],
  }),
  getAgentletGateway: () => ({
    getAgentlet: () => ({ status: 'connected' }),
  }),
}));

let app: FastifyInstance;
const url = '/api/agent/conversation-profile';

beforeEach(async () => {
  mocks.preference = { profileId: null };
  mocks.set.mockClear();
  app = Fastify({ logger: false });
  await app.register(conversationAgentRoutes, { prefix: url });
});

afterEach(async () => {
  await app.close();
});

describe('conversation Agent preference route', () => {
  it('projects the first selectable Profile without persisting a fallback', async () => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      preference: { profileId: null },
      effectiveProfileId: 'first',
      selectionState: 'available',
    });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('validates and persists an explicit conversational choice', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: { profileId: 'second' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith({ profileId: 'second' });
    expect(response.json()).toMatchObject({
      effectiveProfileId: 'second',
      selectionState: 'available',
    });
  });

  it('rejects an unknown Profile without changing the preference', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: { profileId: 'missing' },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
