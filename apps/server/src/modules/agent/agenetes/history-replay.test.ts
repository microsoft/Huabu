// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  estimateReplayUnits,
  HISTORY_LOAD_SANITY_LIMIT,
  materializeHuabuHistory,
} from './history-replay.js';

import type { AgentTurn } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';

const { rebuildTurnMessages } = vi.hoisted(() => ({
  rebuildTurnMessages: vi.fn(),
}));

vi.mock('../conversation/prompt/build-prompt.js', () => ({
  rebuildTurnMessages,
}));

/** Durable turns are opaque here: the mocked renderer decides their messages. */
function durableTurn(id: string): AgentTurn {
  return { request: { type: 'huabu.chat', content: id }, transcript: [] };
}

/** Base64 body whose decoded size is roughly `bytes`. */
function base64Body(bytes: number, char: string): string {
  return char.repeat(Math.ceil((bytes * 4) / 3));
}

function imageMessage(data: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '<attachment type="image" origin="n-1" />' },
      { type: 'image', data, mimeType: 'image/png' },
    ],
    timestamp: 1,
  } as unknown as Message;
}

function textMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 } as unknown as Message;
}

function contentParts(
  messages: readonly Message[],
): { type: string; text?: string; data?: string }[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; text?: string; data?: string }[])
      : [],
  );
}

function replayGroups(groups: Message[][]): void {
  let call = 0;
  rebuildTurnMessages.mockImplementation(() =>
    Promise.resolve(groups[call++] ?? []),
  );
}

describe('materializeHuabuHistory', () => {
  it('replays every turn in order, images included', async () => {
    const older = base64Body(6 * 1024 * 1024, 'A');
    const newer = base64Body(6 * 1024 * 1024, 'B');
    replayGroups([[imageMessage(older)], [imageMessage(newer)]]);

    const { messages } = await materializeHuabuHistory(
      { mode: 'recover', turns: [durableTurn('a'), durableTurn('b')] },
      { canvasId: 'c1' },
    );

    const images = contentParts(messages).filter(
      (part) => part.type === 'image',
    );
    expect(images.map((part) => part.data)).toEqual([older, newer]);
  });

  it('keeps a long history whole rather than trimming it', async () => {
    replayGroups([
      [textMessage(`first ${'x'.repeat(150_000)}`)],
      [textMessage(`second ${'y'.repeat(150_000)}`)],
      [textMessage(`third ${'z'.repeat(150_000)}`)],
    ]);

    const { messages } = await materializeHuabuHistory(
      {
        mode: 'recover',
        turns: [durableTurn('a'), durableTurn('b'), durableTurn('c')],
      },
      { canvasId: null },
    );

    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toContain('first');
    expect(messages[2]?.content).toContain('third');
  });

  it('prices an image as a flat cost, not as the length of its base64 body', () => {
    // Image bytes alone must never trip the sanity limit, or a thread with
    // a few attachments would be denied recovery outright.
    const huge = imageMessage(base64Body(6 * 1024 * 1024, 'A'));

    expect(estimateReplayUnits([huge])).toBeLessThan(HISTORY_LOAD_SANITY_LIMIT);
  });
});
