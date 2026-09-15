// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { AgentNodeLifecycle } from './agent-node-lifecycle.js';

import type {
  AgentNodeProjection,
  AgentNodeTransition,
} from './agent-node-lifecycle.js';
import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { CanvasNodeId } from '@huabu/shared';

const TARGET: AgentNodeTarget = {
  canvasId: 'canvas-a',
  nodeId: 'node-agent' as CanvasNodeId,
  threadId: 'thread-a',
};

function harness(initial: AgentNodeProjection = {}, hasHistory = false) {
  let current: AgentNodeProjection = { content: '', ...initial };
  const transition = vi.fn(
    async (_target: AgentNodeTarget, update: AgentNodeTransition) => {
      const patch = update(current);
      if (patch) current = { ...current, ...patch };
    },
  );
  const lifecycle = new AgentNodeLifecycle({
    transition,
    hasSubmission: () => hasHistory,
  });
  return { lifecycle, transition, current: () => current };
}

describe('AgentNodeLifecycle', () => {
  it('initializes fresh submitted content and projects running then unread completion', async () => {
    const h = harness();
    await h.lifecycle.start(TARGET, 'First prompt', 'attempt-1');
    expect(h.current()).toMatchObject({
      content: 'First prompt',
      status: 'running',
      invocationToken: 'attempt-1',
    });
    await h.lifecycle.done(TARGET, 'attempt-1');
    expect(h.current()).toMatchObject({
      status: 'done',
      errorMessage: '',
      viewed: false,
    });
  });

  it.each([
    [{ content: 'User authored' }, false],
    [{ invocationToken: 'previous', content: '' }, false],
    [{ content: '' }, true],
  ])(
    'preserves authored content and prior submission evidence %j',
    async (initial, history) => {
      const h = harness(initial, history);
      await h.lifecycle.start(TARGET, 'Follow-up', 'new');
      expect(h.current().content).toBe(initial.content);
    },
  );

  it('fills an empty control-only Bound node on its first prompt', async () => {
    const h = harness({ bindingState: 'bound' });
    await h.lifecycle.start(TARGET, 'First prompt', 'new');
    expect(h.current().content).toBe('First prompt');
    expect(h.current().bindingState).toBe('bound');
  });

  it('fences stale completion, failure and viewed acknowledgements', async () => {
    const h = harness();
    await h.lifecycle.start(TARGET, 'First', 'old');
    await h.lifecycle.start(TARGET, 'Second', 'current');
    await h.lifecycle.done(TARGET, 'old');
    await h.lifecycle.error(TARGET, 'Old failure', 'old');
    await h.lifecycle.acknowledge(TARGET, 'old');
    await h.lifecycle.acknowledge(TARGET, 'current');
    expect(h.current()).toMatchObject({
      status: 'running',
      invocationToken: 'current',
      errorMessage: '',
    });
    expect(h.current().viewed).toBeUndefined();
    await h.lifecycle.error(TARGET, 'Current failure', 'current');
    await h.lifecycle.acknowledge(TARGET, 'old');
    expect(h.current().viewed).toBe(false);
    await h.lifecycle.acknowledge(TARGET, 'current');
    expect(h.current().viewed).toBe(true);
  });

  it('binding does not invent a prompt or alter its previous outcome', async () => {
    const h = harness({
      status: 'error',
      invocationToken: 'previous',
      errorMessage: 'Failed',
    });
    await h.lifecycle.bind(TARGET);
    expect(h.current()).toEqual({
      content: '',
      bindingState: 'bound',
      status: 'error',
      invocationToken: 'previous',
      errorMessage: 'Failed',
    });
    await h.lifecycle.bind(TARGET, true);
    expect(h.transition).toHaveBeenLastCalledWith(
      TARGET,
      expect.any(Function),
      true,
    );
  });

  it('surfaces projection failures without claiming completion', async () => {
    const lifecycle = new AgentNodeLifecycle({
      transition: vi.fn().mockRejectedValue(new Error('Canvas write failed')),
      hasSubmission: () => false,
    });
    await expect(lifecycle.start(TARGET, 'First', 'attempt')).rejects.toThrow(
      'Canvas write failed',
    );
  });
});
