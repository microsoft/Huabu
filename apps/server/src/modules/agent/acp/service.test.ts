// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { emptyAcpOverlay } from '@agenetes/acp-driver';
import { createTranscriptFolder } from '@agenetes/agenetes';
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
import { inferredIntentFromFoldedToolCall } from '../conversation/transcript/history.js';
import {
  activeInkIntentOwnerNodeId,
  isActiveInkIntentTurn,
  isActiveExternalInkIntentTurn,
  publishExternalInkReport,
} from '../ink-intent-runtime.js';

import type { AcpHandle } from '../agenetes/drivers.js';
import type { HuabuSubmission } from '../agenetes/handle.js';
import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AcpTurnCtx } from '@agenetes/acp-driver';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('../conversation-title.service.js', () => ({
  conversationTitleService: { start: vi.fn(async () => {}) },
}));

async function* emptyEvents() {
  yield* [];
  return;
}

describe('runAcpAgent durable acceptance', () => {
  beforeEach(() => {
    mocks.logMetadata.mockReset().mockReturnValue({ eventCount: 7 });
  });

  it('reports the Tier-1 turn-start identity after invoking the handle', async () => {
    let handleInvoked = false;
    const handle = {
      run: vi.fn((submission: HuabuSubmission, ctx: AcpTurnCtx) => {
        handleInvoked = true;
        expect(submission.rendered).toEqual([
          { type: 'text', text: 'prepared' },
        ]);
        expect(ctx.drainHostEvents).toBeUndefined();
        return emptyEvents();
      }),
    } as unknown as AcpHandle;
    mocks.logMetadata.mockImplementation(() => {
      expect(handleInvoked).toBe(true);
      return { eventCount: 7 };
    });
    const onTurnStarted = vi.fn();

    for await (const _event of runAcpAgent({
      handle,
      binding: {
        profileId: 'profile-1',
        alias: 'External Agent',
      },
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      envelope: {
        user: { text: 'Normal text turn', attachments: [] },
        skills: { invokedIds: [], resolved: [] },
        focus: {
          selection: {
            refs: [],
            selectedIds: [],
            imageAttachments: [],
            snapshotAttachments: [],
          },
        },
      } as ChatEnvelope,
      submission: {
        type: 'huabu.chat',
        content: {} as ChatEnvelope,
        rendered: [{ type: 'text', text: 'prepared' }],
      } as HuabuSubmission,
      overlay: emptyAcpOverlay(),
      logger: { info: vi.fn() } as unknown as FastifyBaseLogger,
      onTurnStarted,
    })) {
      // Drain the ACP turn.
    }

    expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 7,
    });
    expect(isActiveInkIntentTurn('canvas-1', 'thread-1')).toBe(false);
  });

  it.each(['complete', 'error', 'cancel'] as const)(
    'scopes external Ink reports to this turn and invalidates on %s',
    async (outcome) => {
      const controller = new AbortController();
      let token = '';
      const envelope: ChatEnvelope = {
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
      };
      const run = vi.fn(async function* (
        submission: HuabuSubmission,
        ctx: AcpTurnCtx,
      ) {
        const endpoint = submission.rendered?.find(
          (part) =>
            part.type === 'text' && part.text.includes('<ink_report_endpoint>'),
        );
        if (endpoint?.type !== 'text')
          throw new Error('Missing Ink report endpoint');
        token = JSON.parse(
          endpoint.text.split('Body: ')[1].split('\n')[0],
        ).invocationToken;
        expect(endpoint.text).toContain('/agent/thread-1/ink-intent');
        expect(
          isActiveExternalInkIntentTurn('canvas-1', 'thread-1', token),
        ).toBe(true);
        expect(activeInkIntentOwnerNodeId('canvas-1', 'thread-1')).toBe(
          'question-1',
        );
        publishExternalInkReport('canvas-1', 'thread-1', token, {
          report: { status: 'inferred', text: 'Explain the drawing' },
          renamed: true,
        });
        const events = ctx.drainHostEvents?.() ?? [];
        const folder = createTranscriptFolder();
        for (const event of events) folder.fold(event);
        expect(
          folder
            .result()
            .map((message) => inferredIntentFromFoldedToolCall(message, false)),
        ).toContain('Explain the drawing');
        expect(ctx.drainHostEvents?.()).toEqual([]);
        if (outcome === 'error') throw new Error('Agent failed');
        if (outcome === 'cancel') {
          controller.abort();
          expect(isActiveInkIntentTurn('canvas-1', 'thread-1')).toBe(false);
        }
        yield* emptyEvents();
      });
      const stream = runAcpAgent({
        handle: { run } as unknown as AcpHandle,
        binding: { profileId: 'profile-1', alias: 'External Agent' },
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        inkIntentOwnerNodeId: 'question-1',
        envelope,
        submission: {
          type: 'huabu.chat',
          content: envelope,
          rendered: [
            {
              type: 'parts',
              parts: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
            },
          ],
        },
        overlay: emptyAcpOverlay(),
        signal: controller.signal,
        logger: { info: vi.fn() } as unknown as FastifyBaseLogger,
      });
      const drain = async () => {
        for await (const _event of stream) {
          /* Drain the turn. */
        }
      };
      if (outcome === 'error')
        await expect(drain()).rejects.toThrow('Agent failed');
      else await drain();
      expect(isActiveInkIntentTurn('canvas-1', 'thread-1')).toBe(false);
      expect(isActiveExternalInkIntentTurn('canvas-1', 'thread-1', token)).toBe(
        false,
      );
      expect(run.mock.calls[0][0].rendered?.[0]).toEqual({
        type: 'parts',
        parts: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      });
    },
  );
});
