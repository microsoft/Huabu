import { describe, expect, it, vi } from 'vitest';

import {
  HISTORY_REPLAY_BUDGET,
  materializeHuabuHistory,
} from './history-replay.js';
import { MAX_INLINE_IMAGE_BYTES } from '../conversation/prompt/image-inlining.js';

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
  it('re-inlines recent images and degrades older ones to a placeholder', async () => {
    // The byte budget fits two full-size images; the newest one claims its
    // share first, so the older one no longer fits.
    const older = base64Body(MAX_INLINE_IMAGE_BYTES * 1.5, 'A');
    const newer = base64Body(MAX_INLINE_IMAGE_BYTES * 1.5, 'B');
    replayGroups([[imageMessage(older)], [imageMessage(newer)]]);

    const { messages } = await materializeHuabuHistory(
      { mode: 'recover', turns: [durableTurn('a'), durableTurn('b')] },
      { canvasId: 'c1' },
    );

    const parts = contentParts(messages);
    const images = parts.filter((part) => part.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.data).toBe(newer);
    expect(
      parts.some((part) => part.text?.includes('Earlier image omitted')),
    ).toBe(true);
  });

  it('prices an image as a flat cost, not as the length of its base64 body', async () => {
    replayGroups([[imageMessage(base64Body(MAX_INLINE_IMAGE_BYTES, 'A'))]]);

    const { estimatedSize } = await materializeHuabuHistory(
      { mode: 'recover', turns: [durableTurn('a')] },
      { canvasId: 'c1' },
    );

    expect(estimatedSize).toBeLessThan(HISTORY_REPLAY_BUDGET);
  });

  it('drops whole oldest turns over budget and tells the model', async () => {
    replayGroups([
      [textMessage(`first ${'x'.repeat(150_000)}`)],
      [textMessage(`second ${'y'.repeat(150_000)}`)],
      [textMessage(`third ${'z'.repeat(150_000)}`)],
    ]);

    const { messages, estimatedSize } = await materializeHuabuHistory(
      {
        mode: 'recover',
        turns: [durableTurn('a'), durableTurn('b'), durableTurn('c')],
      },
      { canvasId: null },
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('2 oldest turn(s)');
    expect(messages[1]?.content).toContain('third');
    expect(estimatedSize).toBeLessThan(HISTORY_REPLAY_BUDGET);
  });

  it('keeps the newest turn even when it alone exceeds the budget', async () => {
    replayGroups([[textMessage('q'.repeat(600_000))]]);

    const { messages } = await materializeHuabuHistory(
      { mode: 'recover', turns: [durableTurn('a')] },
      { canvasId: null },
    );

    expect(messages).toHaveLength(1);
  });
});
