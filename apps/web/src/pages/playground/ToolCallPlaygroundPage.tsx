// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Chat-panel playground that renders a whole conversation straight from
 * JSON. Paste a message array (or a single assistant turn with a
 * `parts`/`segments` array) on the left and the right pane renders it
 * through the real {@link MessageList} dispatch — the same renderer the
 * live chat panel uses — so every part variant (text, thinking, plan,
 * tool: generic / agent_tool / space_commands / web_search /
 * image_generation / snapshot_nodes) is exercised exactly as it would
 * appear in production.
 *
 * Route: `/playground/tool-calls`
 */

import { useMemo, useState } from 'react';

import { MessageList } from '@/components/Messages/MessageList';

import type { ChatMessage } from '@/store/chatTypes';

// ─── Sample input ──────────────────────────────────────────────────────
//
// Shows the accepted shapes: a top-level array of messages, where an
// assistant turn may carry its parts under either `segments` or `parts`.
// Ids are optional — they're generated when missing.
//
// The sample is intentionally a tour: it exercises every rich-tool
// variant the renderer dispatches on (generic / image_generation /
// snapshot_nodes) plus the executing / failed states so visual
// regressions are obvious. External image URLs (picsum.photos) are
// used for image_generation / snapshot_nodes previews because the
// playground has no live canvas to resolve artifact keys against —
// `resolveArtifactUrl` passes `https://` URLs through unchanged.

const SAMPLE_JSON = JSON.stringify(
  [
    // ── Section 1: generic ACP tool call ─────────────────────────────
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

    // ── Section 2: snapshot_nodes + generate_image (edit mode) ───────
    {
      role: 'user',
      content: 'Snapshot my selected sketches and turn them into a watercolor.',
    },
    {
      role: 'assistant',
      parts: [
        {
          kind: 'thinking',
          text: 'I need to snapshot the sketches first so the image-edit endpoint can use them as visual references.',
        },
        {
          kind: 'tool',
          toolCallId: 't-snap-1',
          title: 'snapshot_nodes',
          variant: 'snapshot_nodes',
          status: 'completed',
          data: {
            tool: 'snapshot_nodes',
            status: 'success',
            data: {
              nodeIds: ['sketch-a3', 'sketch-b1', 'sketch-c2'],
              snapshots: [
                {
                  src: 'https://picsum.photos/seed/snap-1/512/384',
                  width: 512,
                  height: 384,
                  originNodeIds: ['sketch-a3', 'sketch-b1'],
                },
                {
                  src: 'https://picsum.photos/seed/snap-2/512/384',
                  width: 512,
                  height: 384,
                  originNodeIds: ['sketch-c2'],
                },
              ],
            },
          },
        },
        {
          kind: 'thinking',
          text: 'Now I can feed those PNGs into generate_image as references.',
        },
        {
          kind: 'tool',
          toolCallId: 't-img-1',
          title: 'generate_image',
          variant: 'image_generation',
          status: 'completed',
          data: {
            tool: 'generate_image',
            status: 'success',
            data: {
              prompt: 'Reinterpret the sketches as a soft watercolor painting.',
              size: '1024x1024',
              quality: 'medium',
              referenceArtifactSrcs: [
                'https://picsum.photos/seed/snap-1/512/384',
                'https://picsum.photos/seed/snap-2/512/384',
              ],
              src: 'https://picsum.photos/seed/watercolor/1024/1024',
              width: 1024,
              height: 1024,
              revisedPrompt:
                'A soft, dreamy watercolor painting reinterpreting the input sketches with pastel washes and visible brush strokes.',
            },
          },
        },
        {
          kind: 'text',
          text: "Here's the watercolor version — drag it onto the canvas if you like it.",
        },
      ],
    },

    // ── Section 3: text-only generate_image (success + executing + failed) ─
    {
      role: 'user',
      content:
        'Now make a fantasy castle, and also try once with a bad prompt.',
    },
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          toolCallId: 't-img-2',
          title: 'generate_image',
          variant: 'image_generation',
          status: 'completed',
          data: {
            tool: 'generate_image',
            status: 'success',
            data: {
              prompt:
                'A grand fantasy castle on a misty mountain at sunset, painted in the style of a matte oil painting.',
              size: '1536x1024',
              quality: 'high',
              src: 'https://picsum.photos/seed/castle/1536/1024',
              width: 1536,
              height: 1024,
            },
          },
        },
        {
          kind: 'tool',
          toolCallId: 't-img-3',
          title: 'generate_image',
          variant: 'image_generation',
          status: 'pending',
          data: {
            tool: 'generate_image',
            status: 'success',
            data: {
              prompt: 'A cyberpunk fox holding a neon umbrella.',
              size: '1024x1024',
              quality: 'low',
            },
          },
        },
        {
          kind: 'tool',
          toolCallId: 't-img-4',
          title: 'generate_image',
          variant: 'image_generation',
          status: 'failed',
          data: {
            tool: 'generate_image',
            status: 'error',
            error:
              'Azure image request failed (HTTP 404): The API deployment for this resource does not exist. Common causes: (1) the deployment "gpt-image-1" doesn\'t exist on this Azure resource, (2) the api-version is malformed.',
          },
        },
        {
          kind: 'text',
          text: 'The castle is ready; the cyberpunk fox is still rendering, and the third attempt failed because the deployment is misconfigured.',
        },
      ],
    },

    // ── Section 4: snapshot_nodes pending + failed ───────────────────
    {
      role: 'user',
      content: 'Show me the executing / failed snapshot states.',
    },
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          toolCallId: 't-snap-2',
          title: 'snapshot_nodes',
          variant: 'snapshot_nodes',
          status: 'pending',
          data: {
            tool: 'snapshot_nodes',
            status: 'success',
            data: {
              nodeIds: ['sketch-x', 'sketch-y', 'sketch-z'],
            },
          },
        },
        {
          kind: 'tool',
          toolCallId: 't-snap-3',
          title: 'snapshot_nodes',
          variant: 'snapshot_nodes',
          status: 'failed',
          data: {
            tool: 'snapshot_nodes',
            status: 'error',
            error:
              'Node "sketch-deleted" not found on this canvas — it may have been deleted between the selection and the tool call.',
          },
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

    // status / prepared-prompt pass through as-is.
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
