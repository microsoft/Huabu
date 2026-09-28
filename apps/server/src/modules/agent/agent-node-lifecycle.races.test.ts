// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The window `start` opened when its transition became asynchronous.
 *
 * Seeding a first prompt is decided from three facts — no invocation token,
 * empty content, no prior submission — and the third one is now read across an
 * await from inside the patch the transition returns. Two questions follow:
 * whether the decision still holds when that read is genuinely slow, and
 * whether the Canvas mutex the transition takes actually spans the await. The
 * second half answers the latter against real storage rather than a stub,
 * because the mutex is the thing under test and a fake one proves nothing.
 */

import { describe, expect, it, vi } from 'vitest';

import { createId } from '@huabu/shared';

import { agenetes } from './agenetes/drivers.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import { agentNodeBinding } from './agent-node-binding.js';
import {
  AgentNodeLifecycle,
  agentNodeLifecycle,
} from './agent-node-lifecycle.js';
import { createSpace, space, withCanvasMutex } from '../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type {
  AgentNodeProjection,
  AgentNodeTransition,
} from './agent-node-lifecycle.js';
import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { CanvasNodeId } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const TARGET: AgentNodeTarget = {
  canvasId: 'canvas-a',
  nodeId: 'node-agent' as CanvasNodeId,
  threadId: 'thread-a',
};

/** Let every queued microtask and macrotask run before asserting a negative. */
const settleQueues = () => new Promise((resolve) => setImmediate(resolve));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A transition that serializes its callbacks the way the real one does, so a
 * case can hold one invocation open and watch what the next one sees.
 */
function harness(initial: AgentNodeProjection = {}) {
  let current: AgentNodeProjection = { content: '', ...initial };
  let queue: Promise<unknown> = Promise.resolve();
  const transition = vi.fn(
    (_target: AgentNodeTarget, update: AgentNodeTransition) => {
      const run = queue.then(async () => {
        const patch = await update({ ...current });
        if (patch) current = { ...current, ...patch };
      });
      queue = run.catch(() => undefined);
      return run;
    },
  );
  const submissions = deferred<boolean>();
  const hasSubmission = vi.fn(() => submissions.promise);
  const lifecycle = new AgentNodeLifecycle({ transition, hasSubmission });
  return {
    lifecycle,
    transition,
    hasSubmission,
    answerSubmissions: submissions.resolve,
    current: () => current,
  };
}

describe('AgentNodeLifecycle.start across its awaited submission read', () => {
  it('still seeds an empty Agent Node when the submission read is slow', async () => {
    const h = harness();
    const pending = h.lifecycle.start(TARGET, 'First prompt', 'attempt-1');
    await settleQueues();
    expect(h.current().content).toBe('');

    h.answerSubmissions(false);
    await pending;

    expect(h.current()).toMatchObject({
      content: 'First prompt',
      status: 'running',
      invocationToken: 'attempt-1',
    });
  });

  it('suppresses seeding when a submission lands while the read is in flight', async () => {
    const h = harness();
    const pending = h.lifecycle.start(TARGET, 'First prompt', 'attempt-1');
    await settleQueues();
    // The turn this node is being started for was already durably submitted.
    h.answerSubmissions(true);
    await pending;

    expect(h.current().content).toBe('');
    expect(h.current()).toMatchObject({
      status: 'running',
      invocationToken: 'attempt-1',
    });
  });

  it.each([
    ['authored content', { content: 'User authored' }],
    ['a prior invocation', { invocationToken: 'previous', content: '' }],
  ])(
    'never reads submissions for a node that already carries %s',
    async (_label, initial) => {
      const h = harness(initial);

      await h.lifecycle.start(TARGET, 'Follow-up', 'attempt-2');

      expect(h.hasSubmission).not.toHaveBeenCalled();
      expect(h.current().content).toBe(initial.content);
      expect(h.current().invocationToken).toBe('attempt-2');
    },
  );

  it('serializes racing invocations so only the first one seeds', async () => {
    const h = harness();
    const first = h.lifecycle.start(TARGET, 'First prompt', 'attempt-1');
    const second = h.lifecycle.start(TARGET, 'Second prompt', 'attempt-2');
    await settleQueues();
    // The second transition has not read the node yet: the first still owns it.
    expect(h.transition).toHaveBeenCalledTimes(2);
    expect(h.hasSubmission).toHaveBeenCalledOnce();

    h.answerSubmissions(false);
    await Promise.all([first, second]);

    expect(h.current().content).toBe('First prompt');
    expect(h.current().invocationToken).toBe('attempt-2');
    // The second invocation saw the seeded token and asked for nothing more.
    expect(h.hasSubmission).toHaveBeenCalledOnce();
  });
});

describe('AgentNodeLifecycle.start under the real Canvas mutex', () => {
  let mounted: MountedTestStorage;
  let target: AgentNodeTarget;

  async function open() {
    // The Canvas mutex is in-process, so one profile answers the question; the
    // backend only supplies a real Space to write through.
    mounted = await mountTestWorkspace(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      'agent-node-lifecycle-races-',
    );
    const canvasId = createId('canvas');
    const created = await createSpace(canvasId, 'Lifecycle races');
    if (!created.ok) throw new Error('Space creation failed');
    target = {
      canvasId,
      nodeId: createId('node'),
      threadId: createId('thread'),
      agentBinding: { kind: 'internal' },
      bindingState: 'editing',
    };
    const node: CanvasNode = {
      id: target.nodeId,
      type: 'question',
      position: { x: 0, y: 0 },
      data: {
        threadId: target.threadId,
        agentBinding: target.agentBinding,
        bindingState: 'editing',
      },
    };
    await space(canvasId).write({
      expectedVersion: 0,
      nextRecord: {
        ...created.record,
        version: 1,
        state: { nodes: [node], edges: [] },
      },
      nodeMutations: [
        {
          kind: 'put',
          nodeId: target.nodeId,
          record: {
            nodeId: target.nodeId,
            type: 'question',
            label: 'Agent',
            content: '',
          },
          authoritativeInsert: true,
        },
      ],
    });
    await agenetes.create(
      buildHuabuPiWorkloadSpec({
        kind: 'internal',
        workloadType: 'Deployment',
        threadId: target.threadId,
        namespace: canvasAcpNamespace(target.canvasId),
        canvasId: target.canvasId,
        systemPrompt: 'Test',
        toolNames: [],
        initialMessages: [],
        maxIterations: 1,
        toolExecution: 'sequential',
      }),
    );
    await agentNodeBinding.confirm(target, { required: true });
  }

  async function close() {
    vi.restoreAllMocks();
    if (target) await agenetes.close(target.threadId);
    await mounted?.close();
  }

  async function currentNode(): Promise<CanvasNode> {
    const canvas = await space(target.canvasId).read();
    if (!canvas) throw new Error('Space disappeared');
    return canvas.state.nodes[0] as CanvasNode;
  }

  async function currentContent(): Promise<string | undefined> {
    return (await space(target.canvasId).nodes.read(target.nodeId))?.record
      .content;
  }

  it('holds the Space against every other writer while the submission read is pending', async () => {
    await open();
    try {
      const released = deferred<void>();
      let reading = false;
      vi.spyOn(agenetes, 'history').mockImplementation(async () => {
        reading = true;
        await released.promise;
        return { turns: [], truncated: false } as never;
      });

      const start = agentNodeLifecycle.start(
        target,
        'First prompt',
        'attempt-1',
      );
      while (!reading) await settleQueues();

      let unrelatedWriteRan = false;
      const unrelated = withCanvasMutex(target.canvasId, async () => {
        unrelatedWriteRan = true;
      });
      await settleQueues();
      // The mutex spans the awaited read: no other writer touches this Space
      // until the agent's durable history has answered.
      expect(unrelatedWriteRan).toBe(false);

      released.resolve();
      await start;
      await unrelated;
      expect(unrelatedWriteRan).toBe(true);
      expect(await currentContent()).toBe('First prompt');
    } finally {
      await close();
    }
  });

  it('gives two racing invocations one seeded prompt and the later token', async () => {
    await open();
    try {
      const first = agentNodeLifecycle.start(
        target,
        'First prompt',
        'attempt-1',
      );
      const second = agentNodeLifecycle.start(
        target,
        'Second prompt',
        'attempt-2',
      );
      await Promise.all([first, second]);

      expect(await currentContent()).toBe('First prompt');
      expect((await currentNode()).data).toMatchObject({
        invocationToken: 'attempt-2',
        status: 'running',
      });
    } finally {
      await close();
    }
  });

  it('does not reseed a node whose thread already holds a submission', async () => {
    await open();
    try {
      vi.spyOn(agenetes, 'history').mockResolvedValue({
        turns: [{ seq: 1 }],
        truncated: false,
      } as never);

      await agentNodeLifecycle.start(target, 'Recovered prompt', 'attempt-1');

      expect(await currentContent()).toBe('');
      expect((await currentNode()).data).toMatchObject({
        invocationToken: 'attempt-1',
        status: 'running',
      });
    } finally {
      await close();
    }
  });
});
