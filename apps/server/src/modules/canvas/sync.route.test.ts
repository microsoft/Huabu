// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '/workspace-a' }));

vi.mock('../storage/index.js', () => ({
  getCanvasStore: vi.fn(),
}));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { publishCanvasUpdate } from './canvas-sync.js';
import syncRoutes from './sync.route.js';
import { getCanvasStore } from '../storage/index.js';

import type { CanvasSyncEvent } from '@huabu/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type SyncRequest = FastifyRequest<{ Params: { canvasId: string } }>;
type SyncHandler = (request: SyncRequest, reply: FastifyReply) => Promise<void>;

class CapturingResponse extends Writable {
  readonly chunks: string[] = [];
  readonly writeHead = vi.fn();
  readonly flushHeaders = vi.fn();

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

function update(toVersion: number): CanvasSyncEvent {
  return {
    type: 'update',
    data: {
      fromVersion: toVersion - 1,
      toVersion,
      deltas: [],
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    },
  };
}

async function captureHandler(): Promise<SyncHandler> {
  let handler: SyncHandler | undefined;
  const fastify = {
    get: (_path: string, next: SyncHandler): void => {
      handler = next;
    },
  };
  await syncRoutes(fastify as unknown as FastifyInstance, {});
  if (!handler) throw new Error('sync route was not registered');
  return handler;
}

function requestAndReply(canvasId: string): {
  request: SyncRequest;
  requestRaw: EventEmitter;
  reply: FastifyReply;
  responseRaw: CapturingResponse;
} {
  const requestRaw = new EventEmitter();
  const responseRaw = new CapturingResponse();
  return {
    request: { params: { canvasId }, raw: requestRaw } as SyncRequest,
    requestRaw,
    reply: {
      hijack: vi.fn(),
      raw: responseRaw,
    } as unknown as FastifyReply,
    responseRaw,
  };
}

describe('canvas sync SSE route', () => {
  beforeEach(() => {
    workspaceState.path = '/workspace-a';
    vi.mocked(getCanvasStore).mockReset();
  });

  it('buffers a commit published during the snapshot read until after the snapshot', async () => {
    const canvasId = 'handshake-race';
    const commit = update(2);
    vi.mocked(getCanvasStore).mockReturnValue({
      read: () => {
        const snapshot = { version: 1 };
        publishCanvasUpdate(canvasId, commit);
        return snapshot;
      },
    } as unknown as ReturnType<typeof getCanvasStore>);

    const handler = await captureHandler();
    const { request, requestRaw, reply, responseRaw } =
      requestAndReply(canvasId);

    await handler(request, reply);

    const output = responseRaw.chunks.join('');
    const snapshotAt = output.indexOf(
      'event: snapshot\ndata: {"version":1}\n\n',
    );
    const updateAt = output.indexOf(
      `event: update\ndata: ${JSON.stringify(commit.data)}\n\n`,
    );
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(snapshotAt);

    requestRaw.emit('close');
    const afterClose = responseRaw.chunks.join('');
    publishCanvasUpdate(canvasId, update(3));
    expect(responseRaw.chunks.join('')).toBe(afterClose);
    expect(responseRaw.writableEnded).toBe(true);
    expect(requestRaw.listenerCount('close')).toBe(0);
  });

  it('unsubscribes and closes the response when the snapshot read fails', async () => {
    const canvasId = 'failed-handshake';
    vi.mocked(getCanvasStore).mockReturnValue({
      read: () => {
        throw new Error('snapshot failed');
      },
    } as unknown as ReturnType<typeof getCanvasStore>);

    const handler = await captureHandler();
    const { request, requestRaw, reply, responseRaw } =
      requestAndReply(canvasId);

    await expect(handler(request, reply)).rejects.toThrow('snapshot failed');
    const afterFailure = responseRaw.chunks.join('');
    publishCanvasUpdate(canvasId, update(1));
    expect(responseRaw.chunks.join('')).toBe(afterFailure);
    expect(responseRaw.writableEnded).toBe(true);
    expect(requestRaw.listenerCount('close')).toBe(0);
  });

  it('pins an open stream to the Workspace captured at subscription time', async () => {
    const canvasId = 'workspace-qualified';
    vi.mocked(getCanvasStore).mockReturnValue({
      read: () => ({ version: 1 }),
    } as unknown as ReturnType<typeof getCanvasStore>);

    const handler = await captureHandler();
    const { request, requestRaw, reply, responseRaw } =
      requestAndReply(canvasId);
    await handler(request, reply);
    const afterHandshake = responseRaw.chunks.join('');

    workspaceState.path = '/workspace-b';
    publishCanvasUpdate(canvasId, update(2));
    expect(responseRaw.chunks.join('')).toBe(afterHandshake);

    workspaceState.path = '/workspace-a';
    const commit = update(3);
    publishCanvasUpdate(canvasId, commit);
    expect(responseRaw.chunks.join('')).toContain(
      `event: update\ndata: ${JSON.stringify(commit.data)}\n\n`,
    );

    requestRaw.emit('close');
  });
});
