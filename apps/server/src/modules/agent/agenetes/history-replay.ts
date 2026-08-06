// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Durable history → replayable pi messages for the built-in agent.
 *
 * Recovery restores the context the live agent would still be holding had
 * its handle never been lost: every turn replays the canonical inputs it
 * was submitted with, so role attribution, `toolCall`/`toolResult` pairing
 * and images all survive.
 *
 * It deliberately does not trim. Context growth belongs to the
 * conversation, not to recovery: the live path carries every past turn and
 * image for as long as the handle lives. Budgeting only here would make a
 * recovered thread quietly forget what a never-restarted one remembers,
 * and would hide a gap that has to be closed for both paths at once.
 */

import { rebuildTurnMessages } from '../conversation/prompt/build-prompt.js';

import type { PiHistoryInput, PiHistoryReplay } from '@agenetes/pi-driver';
import type { AgentInputPart } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';

/**
 * Instance-level guard against a pathological turn log, in the unit
 * {@link estimateReplayUnits} produces. This is not a context budget: it
 * only has to sit far above any genuine conversation so admission control
 * still catches a corrupt or runaway log.
 */
export const HISTORY_LOAD_SANITY_LIMIT = 2_000_000;

/**
 * What one replayed image costs against the estimate. Providers price an
 * image as a flat-ish tile count, nothing like the length of its base64
 * body, so it must not be estimated as text.
 */
const IMAGE_REPLAY_UNITS = 1_500;

/** Cheap token-like estimate, matching Agenetes' text heuristic. */
function textUnits(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4.5);
}

function isImagePart(
  part: unknown,
): part is Extract<AgentInputPart, { type: 'image' }> {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'image' &&
    typeof (part as { data?: unknown }).data === 'string'
  );
}

function messageUnits(message: Message): number {
  const content: unknown = message.content;
  if (typeof content === 'string') return textUnits(content);
  if (!Array.isArray(content)) return textUnits(JSON.stringify(content) ?? '');
  return content.reduce<number>((total, part) => {
    if (isImagePart(part)) return total + IMAGE_REPLAY_UNITS;
    return total + textUnits(JSON.stringify(part) ?? '');
  }, 0);
}

/** Size a replay payload the way the instance's history limit measures it. */
export function estimateReplayUnits(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + messageUnits(message), 0);
}

/**
 * Lower durable turns into the pi messages a recovered or forked built-in
 * agent starts from. Registered as the pi driver's `materializeHistory` port.
 */
export async function materializeHuabuHistory(
  input: PiHistoryInput,
  ctx: { canvasId: string | null },
): Promise<PiHistoryReplay> {
  const messages: Message[] = [];
  for (const turn of input.turns) {
    messages.push(...(await rebuildTurnMessages(turn, ctx)));
  }
  return { messages, estimatedSize: estimateReplayUnits(messages) };
}
