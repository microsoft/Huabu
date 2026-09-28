// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Realization while the durable record read is in flight.
 *
 * The read used to be synchronous, so nothing could arrive between it and the
 * admission lease, and the in-flight map only had to survive the awaits that
 * followed. Now the read is the first await, which is where a second caller
 * lands. Every step below is held open by a deferred released by hand rather
 * than by a tick count, so the window stays open for as long as the case needs
 * and the result never depends on how many microtasks the implementation
 * happens to spend before it.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => ({
    name: canvasId,
    storage: { root: `/spaces/${canvasId}/.history` },
  }),
}));

import { ExternalAgentRealizationService } from './external-agent-realization.js';
import { AgentNodeBindingError } from '../agent-node-binding.js';

import type { AcpHandle, AcpWorkloadSpec } from '../agenetes/drivers.js';
import type {
  AgentNodeTarget,
  FixedAgentNodeTarget,
} from '../agent-thread-resolver.js';
import type { ThreadRecord } from '@agenetes/agenetes';
import type { CanvasNodeId } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;

const BINDING = {
  kind: 'external' as const,
  alias: 'Fixed Agent',
  profileId: 'profile-fixed',
};

const FIXED_TARGET: FixedAgentNodeTarget = {
  canvasId: 'canvas-1',
  nodeId: 'node-1' as CanvasNodeId,
  threadId: 'thread-1',
  agentBinding: BINDING,
  status: 'idle',
  content: '',
};

const SELECTABLE_TARGET: AgentNodeTarget = {
  canvasId: FIXED_TARGET.canvasId,
  nodeId: 'node-selectable' as CanvasNodeId,
  threadId: FIXED_TARGET.threadId,
};

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const DIAGNOSTICS = {
  includedFrameIds: [],
  includedNodeIds: [],
  omittedUnsupportedIds: [],
  omittedEmptyTextIds: [],
  omittedMissingIds: [],
  omittedBudgetNodeIds: [],
  truncatedNoteIds: [],
  truncated: false,
};

interface HarnessOptions {
  /** A record the thread already owns before the first realization. */
  record?: ThreadRecord;
  /** Held until released, standing in for a slow structured backend. */
  holdRecordRead?: Promise<unknown>;
  holdCollection?: Promise<unknown>;
  holdHandleCreation?: Promise<unknown>;
  /** Fails the flight after admission has already been granted. */
  collectionError?: Error;
  /** Answers `acquireAgentTurn`; the default always admits. */
  admit?: () => boolean;
}

function createHarness(options: HarnessOptions = {}) {
  let durableRecord = options.record;
  const enteredRecordRead = deferred();
  const enteredCollection = deferred();
  const enteredHandleCreation = deferred();
  const leases: Array<ReturnType<typeof vi.fn>> = [];

  const handle = {
    control: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as AcpHandle;

  const readRecord = vi.fn(async () => {
    enteredRecordRead.resolve();
    await options.holdRecordRead;
    return durableRecord;
  });
  const collectSpacePrompt = vi.fn(async () => {
    enteredCollection.resolve();
    await options.holdCollection;
    if (options.collectionError) throw options.collectionError;
    return {
      markdown: '<space_prompt>Space rules</space_prompt>',
      diagnostics: DIAGNOSTICS,
    };
  });
  const createHandle = vi.fn(async (spec: AcpWorkloadSpec) => {
    enteredHandleCreation.resolve();
    await options.holdHandleCreation;
    // Creation is what makes the thread durable, exactly as `agenetes.create`
    // does: every later read of this thread finds a record.
    durableRecord ??= {
      spec,
      driverSchemaVersion: 1,
      state: { driverState: {} },
    };
    return handle;
  });
  const acquireTurn = vi.fn((): (() => void) | null => {
    if (options.admit && !options.admit()) return null;
    const release = vi.fn();
    leases.push(release);
    return release;
  });
  const buildSpec = vi.fn(
    ({
      binding,
      threadId,
      canvasId,
      spacePrompt,
    }: {
      binding: { alias: string; profileId: string };
      threadId: string;
      canvasId?: string;
      spacePrompt?: string;
    }): AcpWorkloadSpec =>
      ({
        threadId,
        namespace: {
          name: canvasId ?? '',
          storage: { root: `/spaces/${canvasId ?? ''}/.history` },
        },
        kind: 'external',
        workloadType: 'Deployment',
        spec: {
          binding,
          agentletId: 'agentlet-1',
          recipe: null,
          initialPreamble: [
            'Huabu bootstrap',
            ...(spacePrompt ? [spacePrompt] : []),
          ],
        },
      }) as unknown as AcpWorkloadSpec,
  );

  const service = new ExternalAgentRealizationService({
    resolveAgentNode: vi.fn().mockResolvedValue(SELECTABLE_TARGET),
    resolveFixedAgentNode: vi.fn().mockResolvedValue(FIXED_TARGET),
    collectSpacePrompt: collectSpacePrompt as never,
    readRecord,
    createHandle,
    buildSpec: buildSpec as never,
    subscribeProfileCache: vi.fn(),
    subscribeTitles: vi.fn(),
    ensureSession: vi.fn(),
    acquireTurn,
  });

  return {
    service,
    readRecord,
    collectSpacePrompt,
    createHandle,
    buildSpec,
    acquireTurn,
    leases,
    enteredRecordRead: enteredRecordRead.promise,
    enteredCollection: enteredCollection.promise,
    enteredHandleCreation: enteredHandleCreation.promise,
    record: () => durableRecord,
  };
}

function realizeOptions(overrides: Record<string, unknown> = {}) {
  return {
    threadId: FIXED_TARGET.threadId,
    canvasId: FIXED_TARGET.canvasId,
    requestedBinding: BINDING,
    fixedTarget: FIXED_TARGET,
    logger,
    ...overrides,
  };
}

/** Let every queued microtask and macrotask run before asserting a negative. */
const settleQueues = () => new Promise((resolve) => setImmediate(resolve));

describe('ExternalAgentRealizationService concurrency', () => {
  it('collects once and creates one handle while two callers wait on the same record read', async () => {
    const read = deferred();
    const h = createHarness({ holdRecordRead: read.promise });

    const first = h.service.realize(realizeOptions());
    const second = h.service.realize(realizeOptions());
    await h.enteredRecordRead;
    await settleQueues();
    // The flight is still parked on the read; nothing downstream may have run.
    expect(h.readRecord).toHaveBeenCalledOnce();
    expect(h.collectSpacePrompt).not.toHaveBeenCalled();

    read.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(b).toBe(a);
    expect(h.collectSpacePrompt).toHaveBeenCalledOnce();
    expect(h.buildSpec).toHaveBeenCalledOnce();
    expect(h.createHandle).toHaveBeenCalledOnce();
  });

  it('single-flights an arbitrary crowd of first interactions', async () => {
    const read = deferred();
    const collection = deferred();
    const h = createHarness({
      holdRecordRead: read.promise,
      holdCollection: collection.promise,
    });

    const callers = Array.from({ length: 5 }, () =>
      h.service.realize(realizeOptions()),
    );
    await h.enteredRecordRead;
    read.resolve();
    await h.enteredCollection;
    await settleQueues();
    collection.resolve();
    const realized = await Promise.all(callers);

    expect(new Set(realized).size).toBe(1);
    expect(h.readRecord).toHaveBeenCalledOnce();
    expect(h.collectSpacePrompt).toHaveBeenCalledOnce();
    expect(h.createHandle).toHaveBeenCalledOnce();
    expect(h.acquireTurn).toHaveBeenCalledOnce();
  });

  it('joins a flight that is already inside handle creation', async () => {
    const creation = deferred();
    const h = createHarness({ holdHandleCreation: creation.promise });

    const first = h.service.realize(realizeOptions());
    await h.enteredHandleCreation;
    // The Space Prompt is already collected and the spec already built; a
    // caller arriving here must inherit them rather than start its own.
    const late = h.service.realize(realizeOptions());
    await settleQueues();
    creation.resolve();
    const [a, b] = await Promise.all([first, late]);

    expect(b).toBe(a);
    expect(h.collectSpacePrompt).toHaveBeenCalledOnce();
    expect(h.createHandle).toHaveBeenCalledOnce();
    expect(h.readRecord).toHaveBeenCalledOnce();
  });

  it('recovers a thread realized moments earlier without collecting again', async () => {
    const h = createHarness();
    const first = await h.service.realize(realizeOptions());

    const second = await h.service.realize(realizeOptions());

    expect(second.spec).toEqual(first.spec);
    expect(h.readRecord).toHaveBeenCalledTimes(2);
    expect(h.collectSpacePrompt).toHaveBeenCalledOnce();
    expect(h.buildSpec).toHaveBeenCalledOnce();
  });
});

describe('ExternalAgentRealizationService admission', () => {
  it('takes one lease for a crowd of first callers and releases it once', async () => {
    const read = deferred();
    const h = createHarness({ holdRecordRead: read.promise });

    const callers = Array.from({ length: 3 }, () =>
      h.service.realize(realizeOptions()),
    );
    await h.enteredRecordRead;
    expect(h.acquireTurn).not.toHaveBeenCalled();
    read.resolve();
    await Promise.all(callers);

    expect(h.acquireTurn).toHaveBeenCalledOnce();
    expect(h.leases).toHaveLength(1);
    expect(h.leases[0]).toHaveBeenCalledOnce();
  });

  it('releases admission when realization fails after the lease is taken', async () => {
    const h = createHarness({
      collectionError: new Error('Space Prompt collection failed'),
    });

    await expect(h.service.realize(realizeOptions())).rejects.toThrow(
      'Space Prompt collection failed',
    );

    expect(h.acquireTurn).toHaveBeenCalledOnce();
    expect(h.leases[0]).toHaveBeenCalledOnce();
    // A failed flight leaves nothing behind: the next caller is admitted.
    await expect(h.service.realize(realizeOptions())).rejects.toThrow(
      'Space Prompt collection failed',
    );
    expect(h.acquireTurn).toHaveBeenCalledTimes(2);
    expect(h.leases[1]).toHaveBeenCalledOnce();
  });

  it('takes no second lease once the record read answers with a realized thread', async () => {
    const h = createHarness();
    await h.service.realize(realizeOptions());
    expect(h.acquireTurn).toHaveBeenCalledOnce();

    await h.service.realize(realizeOptions());

    expect(h.acquireTurn).toHaveBeenCalledOnce();
    expect(h.leases).toHaveLength(1);
  });

  it('never acquires admission the prompt coordinator is already holding', async () => {
    const h = createHarness();

    await h.service.realize(realizeOptions({ turnLeaseHeld: true }));

    expect(h.acquireTurn).not.toHaveBeenCalled();
    expect(h.createHandle).toHaveBeenCalledOnce();
  });

  // Fails today. The in-flight map is keyed by thread alone, so a caller that
  // already owns admission joins a flight that is about to lose it and
  // inherits its 409. Harmless while the record read was synchronous — that
  // flight barely existed — and reachable now that the read is awaited.
  // See SCRATCH/findings/D-realization-inflight-inherits-admission-failure.md.
  it('admits a caller that already holds the lease while another flight fails admission', async () => {
    const read = deferred();
    const h = createHarness({
      holdRecordRead: read.promise,
      admit: () => false,
    });

    // A control request with no lease: the thread is busy, so it must 409.
    const control = h.service.realize(realizeOptions());
    await h.enteredRecordRead;
    // The prompt coordinator, which is the busy turn, asks for the same thread.
    const prompt = h.service.realize(realizeOptions({ turnLeaseHeld: true }));
    read.resolve();

    await expect(control).rejects.toMatchObject({ code: 'agent_draft_busy' });
    await expect(prompt).resolves.toMatchObject({ binding: BINDING });
  });

  it('reports a busy thread when admission is lost while the record read is in flight', async () => {
    const read = deferred();
    let admitted = true;
    const h = createHarness({
      holdRecordRead: read.promise,
      admit: () => admitted,
    });

    const pending = h.service.realize(realizeOptions());
    await h.enteredRecordRead;
    // The window the awaited read opened: another turn wins admission between
    // the read being issued and the answer arriving.
    admitted = false;
    read.resolve();

    await expect(pending).rejects.toBeInstanceOf(AgentNodeBindingError);
    await expect(pending).rejects.toMatchObject({ code: 'agent_draft_busy' });
    expect(h.collectSpacePrompt).not.toHaveBeenCalled();
    expect(h.createHandle).not.toHaveBeenCalled();
  });
});
