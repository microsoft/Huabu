// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  encodeTurnCursor,
  MalformedTurnCursorError,
  StaleTurnCursorError,
} from '@agenetes/agenetes';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  historyPage: vi.fn(),
  historyTurn: vi.fn(),
  record: vi.fn(() => undefined),
  isActive: vi.fn(() => false),
  waitForTurnStart: vi.fn(),
}));

vi.mock('../agent/agenetes/drivers.js', () => ({
  INTERNAL_DRIVER_KIND: 'internal',
  agenetes: {
    history: mocks.history,
    historyPage: mocks.historyPage,
    historyTurn: mocks.historyTurn,
    record: mocks.record,
  },
}));

vi.mock('../agent/agent-thread.service.js', () => ({
  AgentThreadBusyError: class extends Error {},
  agentThreadService: {
    isActive: mocks.isActive,
    waitForTurnStart: mocks.waitForTurnStart,
  },
}));

vi.mock('../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId }),
}));
vi.mock('../workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceModule>()),
  acquireWorkspaceOperationLease: () => ({ release: vi.fn() }),
}));

import { createChatSubmission } from './agenetes/handle.js';
import agentRoutes from './agent.route.js';

import type * as WorkspaceModule from '../workspace.js';

async function request(url: string) {
  const app = Fastify();
  await app.register(agentRoutes, { prefix: '/agent' });
  const response = await app.inject({ method: 'GET', url });
  await app.close();
  return response;
}

describe('GET /agent/history/:threadId/page', () => {
  beforeEach(() => {
    mocks.history.mockReset();
    mocks.historyPage.mockReset();
    mocks.historyTurn.mockReset();
    mocks.record.mockReset();
    mocks.record.mockReturnValue(undefined);
    mocks.isActive.mockReturnValue(false);
  });

  it.each([true, false])(
    'projects pending only for a currently running incomplete Ink turn (running=%s)',
    async (running) => {
      const turn = {
        request: createChatSubmission({
          user: { text: '', inputKind: 'ink-intent', attachments: [] },
          skills: { invokedIds: [], resolved: [] },
          focus: {
            selection: {
              refs: [],
              selectedIds: [],
              imageAttachments: [],
              snapshotAttachments: [],
            },
          },
        }),
        transcript: [],
        isIncomplete: true,
      };
      mocks.isActive.mockReturnValue(running);
      mocks.history.mockResolvedValue({ turns: [turn] });
      mocks.historyPage.mockResolvedValue({
        groups: [
          { id: 'turn-1', turns: [turn], isActive: true, activeTurnIndex: 0 },
        ],
        hasMore: false,
      });
      const full = await request('/agent/history/thread-1?canvasId=canvas-1');
      const paged = await request(
        '/agent/history/thread-1/page?canvasId=canvas-1&limit=3',
      );
      expect(full.statusCode).toBe(200);
      expect(paged.statusCode).toBe(200);
      expect(full.json().messages[0].inkInterpretation).toEqual({
        state: running ? 'pending' : 'missing',
      });
      expect(paged.json().turns[0].messages).toEqual(full.json().messages);
    },
  );

  it.each([
    '/agent/history/thread-1/page?limit=3',
    '/agent/history/thread-1/page?canvasId=canvas-1&limit=0',
    '/agent/history/thread-1/page?canvasId=canvas-1&limit=21',
  ])('rejects malformed page input: %s', async (url) => {
    const response = await request(url);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'malformed_history_request',
    });
    expect(mocks.historyPage).not.toHaveBeenCalled();
  });

  it('returns stable display-turn metadata and chronological messages', async () => {
    mocks.historyPage.mockReturnValue({
      groups: [
        {
          id: 'opaque-turn-id',
          turns: [
            {
              request: null,
              transcript: [{ type: 'text', data: { content: 'orphan' } }],
              isIncomplete: true,
            },
          ],
          isActive: true,
          activeTurnIndex: 0,
        },
      ],
      before: 'opaque-before',
      hasMore: true,
    });
    const response = await request(
      '/agent/history/thread-1/page?canvasId=canvas-1&limit=3',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      threadId: 'thread-1',
      turns: [
        {
          id: 'opaque-turn-id',
          messages: [
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'orphan' }],
            },
          ],
          active: true,
          activeMessageStart: 0,
        },
      ],
      before: 'opaque-before',
      hasMore: true,
    });
  });

  it.each([
    {
      error: new MalformedTurnCursorError('Malformed history cursor'),
      status: 400,
      code: 'malformed_history_cursor',
    },
    {
      error: new StaleTurnCursorError('History cursor is stale'),
      status: 409,
      code: 'stale_history_cursor',
    },
  ])('maps cursor errors to $status/$code', async ({ error, status, code }) => {
    mocks.historyPage.mockImplementation(() => {
      throw error;
    });
    const response = await request(
      '/agent/history/thread-1/page?canvasId=canvas-1&limit=3&before=cursor',
    );
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });

  it('uses summaries only for persisted turns and loads one complete projected turn on demand', async () => {
    const turn = {
      request: null,
      transcript: [
        {
          type: 'tool_call',
          data: {
            toolCallId: 'tool',
            title: 'Read file',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'body-only-on-demand' },
              },
            ],
          },
        },
      ],
    };
    mocks.historyPage.mockResolvedValue({
      groups: [
        {
          id: 'group',
          turns: [turn, { ...turn, isIncomplete: true }],
          turnRefs: ['ref'],
          isActive: true,
          activeTurnIndex: 1,
        },
      ],
      hasMore: false,
    });
    const page = await request(
      '/agent/history/thread-1/page?canvasId=canvas-1&limit=3&detailLevel=summary',
    );
    expect(page.statusCode).toBe(200);
    const messages = page.json().turns[0].messages;
    expect(messages[0].parts[0]).toMatchObject({
      detail: { state: 'deferred', turnRef: 'ref' },
    });
    expect(messages[0].parts[0].content).toBeUndefined();
    expect(messages[1].parts[0].content[0].content.text).toBe(
      'body-only-on-demand',
    );
    mocks.historyTurn.mockResolvedValue(turn);
    const detail = await request(
      '/agent/history/thread-1/turn?canvasId=canvas-1&turnRef=ref',
    );
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().messages[0].parts[0]).toMatchObject({
      content: [{ content: { text: 'body-only-on-demand' } }],
      detail: { state: 'inline', turnRef: 'ref' },
    });
    expect(mocks.historyTurn).toHaveBeenCalledWith(
      { name: 'canvas-1' },
      'thread-1',
      'ref',
    );
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('rejects invalid detail requests and distinguishes missing and stale turns', async () => {
    expect(
      (await request('/agent/history/thread-1/turn?turnRef=ref')).statusCode,
    ).toBe(400);
    expect(
      (await request('/agent/history/thread-1/turn?canvasId=canvas-1'))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await request(
          `/agent/history/thread-1/turn?canvasId=canvas-1&turnRef=${'a'.repeat(4097)}`,
        )
      ).statusCode,
    ).toBe(400);
    expect(mocks.historyTurn).not.toHaveBeenCalled();
    mocks.historyTurn.mockResolvedValue(undefined);
    expect(
      (
        await request(
          '/agent/history/thread-1/turn?canvasId=canvas-1&turnRef=ref',
        )
      ).statusCode,
    ).toBe(404);
    mocks.historyTurn.mockRejectedValue(
      new StaleTurnCursorError('History cursor is stale'),
    );
    expect(
      (
        await request(
          '/agent/history/thread-1/turn?canvasId=canvas-1&turnRef=ref',
        )
      ).statusCode,
    ).toBe(409);
    mocks.historyTurn.mockRejectedValue(
      new MalformedTurnCursorError('Malformed history cursor'),
    );
    expect(
      (
        await request(
          '/agent/history/thread-1/turn?canvasId=canvas-1&turnRef=x',
        )
      ).statusCode,
    ).toBe(400);
  });

  it('reaches the handler with a production-length cursor', async () => {
    // A real reference names a UUID thread, so it is longer than Fastify's
    // default 100-character path-parameter limit.
    const threadId = randomUUID();
    const turnRef = encodeTurnCursor({
      version: 1,
      threadId,
      generation: 1,
      ordinal: 12,
    });
    expect(turnRef.length).toBeGreaterThan(100);
    mocks.historyTurn.mockResolvedValue(undefined);
    const response = await request(
      `/agent/history/${threadId}/turn?canvasId=canvas-1&turnRef=${turnRef}`,
    );
    expect(response.json()).toMatchObject({ code: 'history_turn_not_found' });
    expect(mocks.historyTurn).toHaveBeenCalledWith(
      { name: 'canvas-1' },
      threadId,
      turnRef,
    );
  });
});
