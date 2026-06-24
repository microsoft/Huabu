/**
 * Chat-panel playground that renders a whole conversation straight from
 * JSON. Paste a message array (or a single assistant turn with a
 * `parts`/`segments` array) on the left and the right pane renders it
 * through the real {@link MessageList} dispatch — the same renderer the
 * live chat panel uses — so every part variant (text, thinking, plan,
 * tool: generic / agent_tool / canvas_commands / web_search) is exercised
 * exactly as it would appear in production.
 *
 * Route: `/playground/tool-calls`
 */

import { useMemo, useState } from 'react';

import { MessageList } from '../components/Messages/MessageList';

import type { ChatMessage } from '../store/chatTypes';

// ─── Sample input ──────────────────────────────────────────────────────
//
// Shows the accepted shapes: a top-level array of messages, where an
// assistant turn may carry its parts under either `segments` or `parts`.
// Ids are optional — they're generated when missing.

const SAMPLE_JSON = JSON.stringify(
  [
    {
      role: 'user',
      content: 'Read app.ts and tell me what it does.',
    },
    {
      role: 'assistant',
      parts: [
        { kind: 'thinking', text: 'Let me open the entry file first.' },
        {
          kind: 'tool',
          toolCallId: 't1',
          title: 'Read app.ts',
          variant: 'generic',
          toolKind: 'read',
          status: 'completed',
          locations: [{ path: 'apps/server/src/app.ts', line: 1 }],
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'export function buildApp() {\n  return new Hono();\n}',
              },
            },
          ],
        },
        {
          kind: 'text',
          text: 'It exports `buildApp()`, which constructs the Hono server instance.',
        },
      ],
    },
  ],
  null,
  2,
);

// ─── Normalisation ───────────────────────────────────────────────────────

let idSeq = 0;
const nextId = () => `pg-${++idSeq}`;

interface NormalizeResult {
  messages: ChatMessage[];
  error: string | null;
}

/**
 * Coerce loosely-typed JSON into the `ChatMessage[]` the renderer expects.
 *
 * Accepted top-level shapes:
 *  - an array of message objects
 *  - `{ messages: [...] }`
 *  - a single message object (wrapped into a one-element array)
 *
 * Per message:
 *  - missing `id` → generated
 *  - assistant turns may carry their ordered parts under `segments` or
 *    `parts`; `parts` is mapped onto `segments`
 *  - a `role`-less object that has `parts`/`segments` is treated as an
 *    assistant turn
 */
function normalize(raw: unknown): NormalizeResult {
  let list: unknown[];

  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    list = Array.isArray(obj.messages) ? obj.messages : [obj];
  } else {
    return {
      messages: [],
      error: 'Top-level JSON must be an object or array.',
    };
  }

  const messages: ChatMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      return { messages: [], error: 'Each message must be an object.' };
    }
    const msg = item as Record<string, unknown>;
    const id = typeof msg.id === 'string' ? msg.id : nextId();
    const parts = msg.segments ?? msg.parts;
    const role =
      typeof msg.role === 'string'
        ? msg.role
        : Array.isArray(parts)
          ? 'assistant'
          : 'user';

    if (role === 'assistant') {
      messages.push({
        id,
        role: 'assistant',
        segments: Array.isArray(parts) ? parts : [],
        attachments: msg.attachments,
        selectedNodeIds: msg.selectedNodeIds,
      } as ChatMessage);
      continue;
    }

    if (role === 'user') {
      messages.push({
        id,
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : '',
        attachments: msg.attachments,
        selectedNodeIds: msg.selectedNodeIds,
      } as ChatMessage);
      continue;
    }

    // status / intent-select / prepared-prompt pass through as-is.
    messages.push({ id, ...msg } as ChatMessage);
  }

  return { messages, error: null };
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function ToolCallPlaygroundPage() {
  const [text, setText] = useState(SAMPLE_JSON);

  const { messages, error } = useMemo<NormalizeResult>(() => {
    idSeq = 0;
    if (!text.trim()) return { messages: [], error: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return {
        messages: [],
        error: e instanceof Error ? e.message : 'Invalid JSON.',
      };
    }
    return normalize(parsed);
  }, [text]);

  return (
    <div className="bg-bg-default flex h-full flex-col">
      <header className="border-edge-default flex shrink-0 items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-fg-default text-lg font-semibold">
            Conversation playground
          </h1>
          <p className="text-fg-muted text-xs">
            Paste a message array (or a single assistant turn with a{' '}
            <code>parts</code>/<code>segments</code> array) — it renders through
            the real chat <code>MessageList</code>.
          </p>
        </div>
        {error ? (
          <span className="text-danger text-xs font-medium">{error}</span>
        ) : (
          <span className="text-fg-subtle text-xs">
            {messages.length} message{messages.length === 1 ? '' : 's'}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: JSON editor */}
        <div className="border-edge-default flex w-1/2 min-w-0 flex-col border-r">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="text-fg-default bg-surface h-full w-full resize-none p-4 font-mono text-xs leading-relaxed outline-none"
            placeholder="Paste conversation JSON here…"
          />
        </div>

        {/* Right: rendered chat */}
        <div className="flex w-1/2 min-w-0 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-4 py-4">
            <MessageList messages={messages} isLoading={false} hideAIActions />
          </div>
        </div>
      </div>
    </div>
  );
}
