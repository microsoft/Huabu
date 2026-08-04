/**
 * Debug prompt dump.
 *
 * When the `HUABU_DEBUG_PROMPT` env flag is set, writes a
 * human-readable rendering of the fully-assembled prompt (system prompt
 * + the pi-ai `Context.messages` the agent runs over) to a per-thread
 * append log, one clearly-separated block per turn. This is a developer
 * post-mortem aid only — the app never reads it back, and base64 vision
 * bytes are elided so the file stays readable.
 *
 * Gated and fully wrapped in try/catch so it can never affect a request.
 */

import { appendFileSync } from 'node:fs';

import { mkdirp } from '../../../../utils/fs.js';
import { chatDir, chatPromptLogPath } from '../../../storage/paths.js';

import type { Context } from '@earendil-works/pi-ai';
import type { FastifyBaseLogger } from 'fastify';

/** A pi-ai conversation message (the built-in agent's context unit). */
type PiMessage = Context['messages'][number];

/**
 * Truthy check for the debug flag.
 *
 * When `HUABU_DEBUG_PROMPT` is set explicitly its value wins: `1` /
 * `true` / `yes` / `on` enable it; anything else (including an empty
 * string) disables it.
 *
 * When unset, the default follows the environment — **on** in
 * development (convenient prompt debugging) and **off** in production.
 * This keeps packaged desktop builds from silently writing unbounded,
 * un-rotated per-thread `.prompt.log` dumps of the full prompt to disk:
 * the Electron main process injects `NODE_ENV=production` for packaged
 * builds (see apps/desktop/src/main.ts → buildServerEnv), so an end user
 * who never sets the flag gets no prompt dump. Set it explicitly to a
 * truthy value to re-enable it in a production build.
 */
export function isPromptDebugEnabled(): boolean {
  const v = process.env.HUABU_DEBUG_PROMPT;
  if (v === undefined) return process.env.NODE_ENV !== 'production';
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Max characters of a single text block we render before truncating. */
const MAX_TEXT_CHARS = 8000;
/** Max characters of a tool-call argument JSON we render. */
const MAX_ARGS_CHARS = 1000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more chars]`;
}

/** Render one pi-ai message into a readable, image-elided block. */
function formatMessage(msg: PiMessage, index: number): string {
  const lines: string[] = [`[${index}] ${msg.role}`];

  if (msg.role === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      lines.push(truncate(content, MAX_TEXT_CHARS));
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          lines.push(truncate(part.text, MAX_TEXT_CHARS));
        } else if (part.type === 'image') {
          const bytes = Math.floor((part.data?.length ?? 0) * 0.75);
          lines.push(`  ⟨image ${part.mimeType ?? 'image'} ~${bytes} bytes⟩`);
        } else {
          lines.push(`  ⟨${(part as { type?: string }).type ?? 'part'}⟩`);
        }
      }
    }
  } else if (msg.role === 'assistant') {
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text.length > 0)
          lines.push(truncate(block.text, MAX_TEXT_CHARS));
      } else if (block.type === 'thinking') {
        if (block.thinking.length > 0) {
          lines.push(
            `  (thinking) ${truncate(block.thinking, MAX_TEXT_CHARS)}`,
          );
        }
      } else if (block.type === 'toolCall') {
        const args = (() => {
          try {
            return truncate(
              JSON.stringify(block.arguments ?? {}),
              MAX_ARGS_CHARS,
            );
          } catch {
            return '<unserializable>';
          }
        })();
        lines.push(`  ⟐ toolCall ${block.name}(${args})  #${block.id}`);
      }
    }
  } else if (msg.role === 'toolResult') {
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    lines.push(
      `  ⤷ toolResult ${msg.toolName ?? 'unknown'} #${msg.toolCallId}`,
    );
    if (text) lines.push(truncate(text, MAX_TEXT_CHARS));
  }

  return lines.join('\n');
}

export interface DumpPromptParams {
  systemPrompt: string;
  /** The full assembled `Context.messages` for this turn (history + new). */
  messages: readonly PiMessage[];
  /** How many trailing messages were appended for THIS turn. */
  newMessageCount: number;
  /** 1-based turn number (prior turns + 1). */
  turnNumber: number;
  threadId: string;
  canvasId: string | null;
  /** Agent scope (`ask` / `operate`) or external alias label. */
  mode: string;
  logger: FastifyBaseLogger;
}

/**
 * Append a readable dump of the assembled prompt for one turn. No-op
 * unless `HUABU_DEBUG_PROMPT` is set or `canvasId` is missing (the log
 * lives under the canvas chat dir). Never throws.
 */
export function dumpAssembledPrompt(params: DumpPromptParams): void {
  if (!isPromptDebugEnabled()) return;
  const { systemPrompt, messages, newMessageCount, canvasId } = params;
  if (!canvasId) return;

  try {
    const boundary = messages.length - newMessageCount;
    const sep = '═'.repeat(78);
    const out: string[] = [
      '',
      sep,
      `TURN ${params.turnNumber} · ${new Date().toISOString()} · mode=${params.mode}`,
      `thread=${params.threadId} · canvas=${canvasId} · messages=${messages.length} (new this turn: ${newMessageCount})`,
      sep,
      '',
      `── SYSTEM PROMPT (${systemPrompt.length} chars) ──`,
      truncate(systemPrompt, MAX_TEXT_CHARS),
      '',
      `── MESSAGES (${messages.length}) ──`,
    ];

    messages.forEach((msg, i) => {
      if (i === boundary && newMessageCount > 0) {
        out.push('', '┄┄┄┄ ↓ NEW THIS TURN ↓ ┄┄┄┄');
      }
      out.push('', formatMessage(msg, i + 1));
    });
    out.push('', '');

    mkdirp(chatDir(canvasId));
    appendFileSync(
      chatPromptLogPath(canvasId, params.threadId),
      out.join('\n'),
      'utf-8',
    );
  } catch (err) {
    params.logger.warn(
      { err: String(err) },
      'dumpAssembledPrompt: failed to write prompt debug log',
    );
  }
}
