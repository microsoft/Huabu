// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { summarizeSpaceAgents } from './space-card.route.js';

const node = (threadId: string, status?: string, viewed = false) => ({
  id: `node-${threadId}`,
  type: 'question',
  data: { threadId, status, viewed },
});

describe('Space card activity', () => {
  it('lists each represented conversation once, with approvals overriding running', () => {
    expect(
      summarizeSpaceAgents(
        [
          node('working', 'running'),
          node('working', 'running'),
          node('approval', 'running'),
          node('error', 'error'),
          node('unread', 'done'),
          node('viewed', 'done', true),
          node('viewed-error', 'error', true),
          node('idle'),
          { type: 'spacePreview', data: { targetCanvasId: 'child' } },
          {
            type: 'note',
            data: { threadId: 'not-an-agent', status: 'running' },
          },
        ],
        (id) => ['working', 'approval'].includes(id),
        (id) => id === 'approval',
      ).map(({ threadId, status }) => ({ threadId, status })),
    ).toEqual([
      { threadId: 'working', status: 'running' },
      { threadId: 'approval', status: 'approval' },
      { threadId: 'error', status: 'error' },
      { threadId: 'unread', status: 'unread' },
      { threadId: 'viewed', status: 'idle' },
      { threadId: 'viewed-error', status: 'idle' },
      { threadId: 'idle', status: 'idle' },
    ]);
  });

  it('does not present stale persisted running state as a live invocation', () => {
    expect(
      summarizeSpaceAgents(
        [node('stale', 'running')],
        () => false,
        () => true,
      ),
    ).toEqual([
      {
        nodeId: 'node-stale',
        threadId: 'stale',
        title: null,
        status: 'unknown',
      },
    ]);
  });

  it('preserves separate sessions using the same Agent and exposes only presentation fields', () => {
    const agentBinding = {
      kind: 'external',
      profileId: 'reviewer',
      alias: 'Reviewer',
    };
    const agentIcon = { shape: 'flower', color: 'green' };
    const agents = summarizeSpaceAgents(
      ['one', 'two'].map((id) => ({
        ...node(id),
        parentId: 'frame',
        data: {
          ...node(id).data,
          agentBinding,
          agentIcon,
          agentMode: 'ask',
          agentLaunchOverrides: { cwd: '/private/path' },
          content: 'Private prompt',
        },
      })),
      () => false,
      () => false,
    );
    expect(agents).toEqual(
      ['one', 'two'].map((id) => ({
        nodeId: `node-${id}`,
        threadId: id,
        title: null,
        status: 'idle',
        agentBinding,
        agentIcon,
        agentMode: 'ask',
      })),
    );
  });
});
