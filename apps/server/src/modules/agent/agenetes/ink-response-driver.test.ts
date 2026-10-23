// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  InMemoryEventLogStore,
  InMemoryThreadStore,
  InMemoryTurnStore,
  mountAgenetes,
} from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createChatSubmission } from './handle.js';
import { withInkResponse } from './ink-response-driver.js';
import { publishCanvasUpdate } from '../../canvas/canvas-sync.js';

import type { ChatEnvelope } from '../conversation/envelope.js';
import type { Agenetes } from '@agenetes/agenetes';
import type { AgentStreamEvent } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

const namespace = { name: 'ink-driver-canvas' };
const threadId = 'ink-driver-thread';
const envelope: ChatEnvelope = {
  user: { text: '', attachments: [], inputKind: 'ink-intent' },
  skills: { invokedIds: [], resolved: [] },
  focus: {
    selection: {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    },
  },
};
const submission = createChatSubmission(envelope);
const text: AgentStreamEvent = {
  type: 'text_delta',
  data: { content: 'Answer in Chat' },
};
const done: AgentStreamEvent = { type: 'done', data: { message: 'Done' } };
const failure: AgentStreamEvent = {
  type: 'error',
  data: { error: 'Write permission denied' },
};
const instances: Agenetes[] = [];

afterEach(async () => {
  await Promise.all(
    instances.splice(0).map((instance) => instance.close(threadId)),
  );
});

async function* script(
  events: AgentStreamEvent[] = [text, done],
): ReturnType<AgentHandle['run']> {
  yield* events;
  return 'driver-result';
}

async function mount(
  kind = 'internal',
  run: AgentHandle['run'] = () => script(),
) {
  const raw: AgentHandle = {
    capabilities: { supportedControlMessages: [], turnInput: 'blocking' },
    run: vi.fn(run),
    control: vi.fn(async () => ({
      ok: false as const,
      code: 'unsupported',
      error: 'Unsupported control message',
    })),
    close: vi.fn(),
  };
  const driver = withInkResponse(
    defineDriver({
      schemaVersion: 1,
      workloadTypes: ['Deployment'],
      specSchema: z.object({}),
      stateSchema: z.object({}),
      initialState: () => ({}),
      create: () => raw,
    }),
  );
  const stores = {
    eventLogStore: new InMemoryEventLogStore(),
    threadStore: new InMemoryThreadStore(),
    turnStore: new InMemoryTurnStore(),
  };
  const options = { drivers: { [kind]: driver }, ...stores };
  const instance = mountAgenetes(options);
  instances.push(instance);
  const handle = await instance.create({
    namespace,
    threadId,
    kind,
    workloadType: 'Deployment',
    spec: {},
  });
  return { instance, handle, raw, options, ...stores };
}

async function collect(events: AsyncIterable<AgentStreamEvent>) {
  const result: AgentStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function publishResult(attributedThreadId = threadId) {
  publishCanvasUpdate(namespace.name, {
    type: 'update',
    data: {
      threadId: attributedThreadId,
      fromVersion: 1,
      toVersion: 2,
      deltas: [
        {
          type: 'INSERT_NODE',
          node: {
            id: 'ink-result',
            type: 'note',
            position: { x: 200, y: 100 },
            data: { content: 'Answer on Canvas' },
          },
        },
      ],
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    },
  });
}

describe('Ink verification before Agenetes persistence', () => {
  it.each(['internal', 'external'])(
    'gives the %s initial stream, reconnect, and history the same delivery failure',
    async (kind) => {
      const h = await mount(kind);
      const reconnect = collect(h.instance.tail(namespace, threadId));
      const initial = await collect(h.handle.run(submission, {}));
      expect(initial).toEqual([
        text,
        {
          type: 'error',
          data: {
            error: expect.stringContaining('without a visible Canvas result'),
          },
        },
      ]);
      expect(await reconnect).toEqual(initial);
      expect(
        h.eventLogStore.read(namespace, threadId).map((entry) => entry.event),
      ).toEqual(initial);
      const history = await h.instance.history(namespace, threadId);
      expect(history.turns).toHaveLength(1);
      expect(history.turns[0]?.transcript.at(-1)).toEqual(initial.at(-1));

      await h.instance.close(threadId);
      const recovered = mountAgenetes(h.options);
      instances.push(recovered);
      expect(await recovered.history(namespace, threadId)).toEqual(history);
    },
  );

  it.each(['internal', 'external'])(
    'requires a fresh, matching-thread Canvas result for every %s Ink turn',
    async (kind) => {
      let turn = 0;
      const h = await mount(kind, async function* () {
        publishResult(turn++ === 0 ? threadId : 'another-thread');
        return yield* script();
      });
      expect(await collect(h.handle.run(submission, {}))).toEqual([text, done]);
      const next = await collect(h.handle.run(submission, {}));
      expect(next.at(-1)?.type).toBe('error');
      expect(next).not.toContainEqual(done);
      expect(h.instance.get(threadId)).toBe(h.handle);
    },
  );

  it('does not persist premature done while the driver is still settling', async () => {
    let settle!: () => void;
    let markParked!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const parked = new Promise<void>((resolve) => {
      markParked = resolve;
    });
    const h = await mount('external', async function* () {
      yield text;
      yield done;
      markParked();
      await gate;
      publishResult();
      return 'driver-result';
    });
    const initial = h.handle.run(submission, {});
    expect((await initial.next()).value).toEqual(text);
    const terminal = initial.next();
    await parked;
    const reconnect = h.instance
      .tail(namespace, threadId)
      [Symbol.asyncIterator]();
    try {
      expect(
        h.eventLogStore.read(namespace, threadId).map((entry) => entry.event),
      ).toEqual([text]);
      expect((await reconnect.next()).value).toEqual(text);
      settle();
      expect((await terminal).value).toEqual(done);
      expect(await initial.next()).toEqual({
        done: true,
        value: 'driver-result',
      });
      expect((await reconnect.next()).value).toEqual(done);
    } finally {
      settle();
      await initial.return(undefined);
      await reconnect.return?.();
    }
  });

  it.each([
    [failure, done],
    [done, failure],
    [done, failure, { type: 'end', data: {} }],
  ] satisfies AgentStreamEvent[][])(
    'persists driver errors without a misleading successful terminal: %j',
    async (...events) => {
      const h = await mount('external', () => script(events));
      expect(await collect(h.handle.run(submission, {}))).toEqual([failure]);
      expect(
        (await h.instance.history(namespace, threadId)).turns[0]?.transcript,
      ).toEqual([failure]);
    },
  );

  it('persists a thrown failure after done instead of recording success', async () => {
    const h = await mount('internal', async function* () {
      yield done;
      throw new Error('Driver cleanup failed');
    });
    const initial = await collect(h.handle.run(submission, {}));
    expect(initial).toEqual([
      { type: 'error', data: { error: 'Driver cleanup failed' } },
    ]);
    expect(
      (await h.instance.history(namespace, threadId)).turns[0]?.transcript,
    ).toEqual(initial);
  });

  it('rejects a silently exhausted Ink turn', async () => {
    const h = await mount('internal', () => script([]));
    expect((await collect(h.handle.run(submission, {}))).at(-1)?.type).toBe(
      'error',
    );
  });

  it('preserves cancellation without replacing it with a delivery failure', async () => {
    const controller = new AbortController();
    const h = await mount('external', async function* () {
      controller.abort();
      yield done;
    });
    expect(
      await collect(h.handle.run(submission, { signal: controller.signal })),
    ).toEqual([done]);
  });

  it('preserves ordinary Chat and resume events and raw return values', async () => {
    const h = await mount();
    const chat = createChatSubmission({
      ...envelope,
      user: { ...envelope.user, inputKind: undefined },
    });
    for (const input of [chat, null]) {
      const source = h.handle.run(input, {});
      expect((await source.next()).value).toEqual(text);
      expect((await source.next()).value).toEqual(done);
      expect(await source.next()).toEqual({
        done: true,
        value: 'driver-result',
      });
    }
    expect(await h.handle.control({ type: 'cancel', data: {} })).toEqual({
      ok: false,
      code: 'unsupported',
      error: 'Unsupported control message',
    });
    expect(h.raw.control).toHaveBeenCalledOnce();
  });

  it('closes the source on early return without inventing a terminal event', async () => {
    const closed = vi.fn();
    const h = await mount('internal', async function* () {
      try {
        yield text;
        yield done;
      } finally {
        closed();
      }
    });
    const source = h.handle.run(submission, {});
    await source.next();
    await source.return(undefined);
    expect(closed).toHaveBeenCalledOnce();
    expect(
      h.eventLogStore.read(namespace, threadId).map((entry) => entry.event),
    ).toEqual([text]);
  });
});
