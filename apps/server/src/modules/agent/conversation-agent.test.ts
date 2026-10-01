// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { ConversationAgentService } from './conversation-agent.js';

import type { ConversationAgentPreference } from '@huabu/shared';

function harness(
  stored: ConversationAgentPreference | undefined,
  selectable: string[] = [],
) {
  let value = stored;
  const write = vi.fn((next: ConversationAgentPreference) => {
    value = next;
  });
  const service = new ConversationAgentService(
    {
      read: () => value,
      write,
    },
    () => selectable,
  );
  return { service, write };
}

describe('ConversationAgentService', () => {
  it('falls back to the first selectable Profile without persisting it', () => {
    const { service, write } = harness(undefined, ['first', 'second']);
    expect(service.effectiveProfileId()).toBe('first');
    expect(service.getPreference()).toEqual({ profileId: null });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a remembered identity authoritative even when it is stale', () => {
    const { service } = harness({ profileId: 'missing' }, ['first']);
    expect(service.effectiveProfileId()).toBe('missing');
  });

  it('persists an explicit conversational choice independently', () => {
    const { service, write } = harness(undefined, ['first']);
    expect(service.setPreference({ profileId: 'chosen' })).toEqual({
      profileId: 'chosen',
    });
    expect(write).toHaveBeenCalledWith({ profileId: 'chosen' });
    expect(service.effectiveProfileId()).toBe('chosen');
  });
});
