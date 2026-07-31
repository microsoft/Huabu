/**
 * Durable history → replayable pi messages for the built-in agent.
 *
 * Recovery re-renders each durable turn through the SAME renderer the live
 * turn uses ({@link rebuildTurnMessages}), so a recovered thread keeps its
 * role attribution, its `toolCall`/`toolResult` pairing, and its images —
 * the artifacts are still on disk, so historical images are re-inlined as
 * real vision parts instead of being flattened into text.
 *
 * Two budgets bound the result, newest-first, because a recovered thread
 * must never be more expensive than the live one it replaces:
 *
 *  - image bytes: older images past the cap degrade to a placeholder that
 *    points at the `origin` caption the renderer already emitted;
 *  - total units: whole turns are dropped from the front, never split, and
 *    the loss is announced to the model.
 */

import { rebuildTurnMessages } from '../conversation/prompt/build-prompt.js';
import {
  base64DecodedByteLength,
  MAX_INLINE_IMAGE_BYTES,
} from '../conversation/prompt/image-inlining.js';

import type { PiHistoryInput, PiHistoryReplay } from '@agenetes/pi-driver';
import type { AgentInputPart } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';

/**
 * Ceiling for the replayed history, in the same unit `estimateReplayUnits`
 * produces. Shared with the mounted `AutoRecoverPolicy` so the instance-level
 * guard and the projection that has to satisfy it cannot drift.
 */
export const HISTORY_REPLAY_BUDGET = 64_000;

/**
 * Total decoded image bytes re-inlined into a recovered context. Two
 * full-size images' worth: enough to keep the recent visual thread alive
 * without rebuilding a request body the provider would reject.
 */
const REPLAY_IMAGE_BYTE_BUDGET = 2 * MAX_INLINE_IMAGE_BYTES;

/**
 * What one re-inlined image costs against {@link HISTORY_REPLAY_BUDGET}.
 * Providers price an image as a flat-ish tile count, nothing like the
 * length of its base64 body, so it must not be estimated as text.
 */
const IMAGE_REPLAY_UNITS = 1_500;

const OMITTED_IMAGE_TEXT =
  '[Earlier image omitted from the recovered context to stay within the replay budget. ' +
  'Call `snapshot_nodes` on the origin node id above, or `read` the node, to see it again.]';

const droppedTurnsNotice = (count: number): string =>
  `[SYSTEM Recovery] The ${count} oldest turn(s) of this conversation were omitted while restoring it after a restart, to stay within the context budget. Ask the user if you need details from before that point.`;

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

/**
 * Replace image parts beyond the byte budget with a placeholder, walking
 * newest-first so the images nearest the current request survive. Mutates
 * nothing: returns fresh messages for the ones that changed.
 */
function applyImageBudget(messages: readonly Message[]): Message[] {
  let remaining = REPLAY_IMAGE_BYTE_BUDGET;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    const content = message?.content;
    if (!message || !Array.isArray(content)) continue;
    let changed = false;
    const parts = content.map((part) => {
      if (!isImagePart(part)) return part;
      const bytes = base64DecodedByteLength(part.data);
      if (bytes <= remaining) {
        remaining -= bytes;
        return part;
      }
      changed = true;
      return { type: 'text' as const, text: OMITTED_IMAGE_TEXT };
    });
    if (changed) out[i] = { ...message, content: parts } as Message;
  }
  return out;
}

/** Size one rebuilt message against the replay budget. */
function messageUnits(message: Message): number {
  const content: unknown = message.content;
  if (typeof content === 'string') return textUnits(content);
  if (!Array.isArray(content)) return textUnits(JSON.stringify(content) ?? '');
  return content.reduce<number>((total, part) => {
    if (isImagePart(part)) return total + IMAGE_REPLAY_UNITS;
    return total + textUnits(JSON.stringify(part) ?? '');
  }, 0);
}

/**
 * Lower durable turns into the pi messages a recovered or forked built-in
 * agent starts from. Registered as the pi driver's `materializeHistory` port.
 */
export async function materializeHuabuHistory(
  input: PiHistoryInput,
  ctx: { canvasId: string | null },
): Promise<PiHistoryReplay> {
  const groups: Message[][] = [];
  for (const turn of input.turns) {
    groups.push(await rebuildTurnMessages(turn, { canvasId: ctx.canvasId }));
  }

  const budgeted = applyImageBudget(groups.flat());
  // Re-slice the budgeted messages back onto their turns so a drop stays
  // turn-aligned.
  const sizes = groups.map((group) => group.length);
  const perTurn: Message[][] = [];
  let cursor = 0;
  for (const size of sizes) {
    perTurn.push(budgeted.slice(cursor, cursor + size));
    cursor += size;
  }

  const units = perTurn.map((group) =>
    group.reduce((total, message) => total + messageUnits(message), 0),
  );

  let firstKept = 0;
  let total = units.reduce((a, b) => a + b, 0);
  // Always keep the newest turn: replaying nothing is worse than replaying
  // one oversized turn, which the provider will trim on its own.
  while (total > HISTORY_REPLAY_BUDGET && firstKept < perTurn.length - 1) {
    total -= units[firstKept] ?? 0;
    firstKept++;
  }

  const messages = perTurn.slice(firstKept).flat();
  if (firstKept === 0) return { messages, estimatedSize: total };

  const notice = droppedTurnsNotice(firstKept);
  return {
    messages: [
      { role: 'user', content: notice, timestamp: Date.now() },
      ...messages,
    ],
    estimatedSize: total + textUnits(notice),
  };
}
