// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What `turnStartSeq` means now that the log metadata read is awaited.
 *
 * The number is a boundary: everything at or below it belongs to earlier
 * turns, everything above it is this turn's. `run` marks the start and the
 * read that follows names the boundary — but the read is no longer
 * instantaneous, so the value is whatever the log holds when the answer comes
 * back. These cases pin the boundary for one turn, prove two threads reading
 * at once never borrow each other's, and record what the number becomes when
 * two turns on one thread overlap, which is the case admission exists to
 * prevent.
 */

import { emptyAcpOverlay } from '@agenetes/acp-driver';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logMetadata: vi.fn(),
}));

vi.mock('../agenetes/drivers.js', () => ({
  EXTERNAL_DRIVER_KIND: 'acp',
  agenetes: { logMetadata: mocks.logMetadata },
}));

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => `test/${canvasId}`,
}));

import { runAcpAgent } from './service.js';

import type { AcpHandle } from '../agenetes/drivers.js';
import type { HuabuSubmission } from '../agenetes/handle.js';
import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AgentTurnAccepted } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const ENVELOPE = {
  user: { text: 'Ask', attachments: [] },
  skills: { invokedIds: [], resolved: [] },
  focus: {
    selection: {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    },
  },
} as ChatEnvelope;

const SUBMISSION = {
  type: 'huabu.chat',
  content: {} as ChatEnvelope,
  rendered: [{ type: 'text', text: 'prepared' }],
} as HuabuSubmission;

const logger = { info: vi.fn() } as unknown as FastifyBaseLogger;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The durable event log, as far as these cases care: one counter per thread. */
const eventCounts = new Map<string, number>();
/** Held reads, so a case can decide when a boundary is answered. */
const holds = new Map<string, Promise<void>>();

/** Wait until `count` boundary reads have been issued and are parked. */
async function readsIssued(count: number): Promise<void> {
  while (mocks.logMetadata.mock.calls.length < count) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function append(threadId: string, count = 1): void {
  eventCounts.set(threadId, (eventCounts.get(threadId) ?? 0) + count);
}

/**
 * A handle whose `run` records the turn start when it is called — the ordering
 * the host relies on for the boundary to mean anything — and then emits
 * `events` further log entries as the turn streams.
 */
function handleFor(threadId: string, events = 0): AcpHandle {
  return {
    run: vi.fn(() => {
      append(threadId);
      return (async function* () {
        for (let index = 0; index < events; index += 1) {
          append(threadId);
          yield { type: 'text_delta' as const, data: { content: 'chunk' } };
        }
      })();
    }),
  } as unknown as AcpHandle;
}

function turn(
  threadId: string,
  handle: AcpHandle,
  onTurnStarted: (acceptance?: AgentTurnAccepted) => void,
) {
  return runAcpAgent({
    handle,
    binding: { profileId: 'profile-1', alias: 'External Agent' },
    threadId,
    envelope: ENVELOPE,
    submission: SUBMISSION,
    overlay: emptyAcpOverlay(),
    logger,
    onTurnStarted,
  });
}

async function drain(stream: ReturnType<typeof runAcpAgent>): Promise<void> {
  for await (const _event of stream) {
    // Let the turn finish.
  }
}

beforeEach(() => {
  eventCounts.clear();
  holds.clear();
  mocks.logMetadata
    .mockReset()
    .mockImplementation(async (_namespace: unknown, threadId: string) => {
      await holds.get(threadId);
      return { eventCount: eventCounts.get(threadId) ?? 0 };
    });
});

describe('runAcpAgent turn boundaries', () => {
  it('reports the boundary this turn opened, not the log it ends with', async () => {
    append('thread-1', 5);
    const started = vi.fn();

    await drain(turn('thread-1', handleFor('thread-1', 3), started));

    expect(started).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 6,
    });
    expect(eventCounts.get('thread-1')).toBe(9);
  });

  it("never lets two threads borrow each other's boundary when reads answer out of order", async () => {
    append('thread-1', 4);
    append('thread-2', 40);
    const first = deferred();
    const second = deferred();
    holds.set('thread-1', first.promise);
    holds.set('thread-2', second.promise);
    const startedFirst = vi.fn();
    const startedSecond = vi.fn();

    const one = drain(turn('thread-1', handleFor('thread-1'), startedFirst));
    const two = drain(turn('thread-2', handleFor('thread-2'), startedSecond));
    await readsIssued(2);
    second.resolve();
    first.resolve();
    await Promise.all([one, two]);

    expect(startedFirst).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 5,
    });
    expect(startedSecond).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-2',
      turnStartSeq: 41,
    });
  });

  it('answers with the log as it stands, so overlapping turns on one thread need admission', async () => {
    const read = deferred();
    holds.set('thread-1', read.promise);
    const startedFirst = vi.fn();
    const startedSecond = vi.fn();

    const first = drain(turn('thread-1', handleFor('thread-1'), startedFirst));
    await readsIssued(1);
    // A second turn on the same thread marks its own start while the first
    // turn is still waiting to learn where it began.
    const second = drain(
      turn('thread-1', handleFor('thread-1'), startedSecond),
    );
    await readsIssued(2);
    read.resolve();
    await Promise.all([first, second]);

    // Both turns name the same boundary: the read cannot distinguish them.
    // Only the per-thread turn lease keeps this shape out of production.
    expect(startedFirst).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 2,
    });
    expect(startedSecond).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 2,
    });
  });
});
