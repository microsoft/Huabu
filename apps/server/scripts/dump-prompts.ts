// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Prompt-assembly inspector.
 *
 * One-shot diff of the user-facing prompt text each backend assembles
 * from the SAME {@link ChatEnvelope}:
 *   - the BUILT-IN agent (`renderEnvelopeMessages` → single pi-ai user
 *     message), and
 *   - the EXTERNAL/ACP agent (`prepareExternalAgentPrompt` → plain-text
 *     `session/prompt` payload).
 *
 * Run it after touching either serializer to eyeball that the two stay
 * in lock-step (selection, neighbourhood, attachments, user text):
 *
 *   pnpm -F @huabu/server dump:prompts
 *
 * The canvas is mocked: every fixture is built with `canvasId: null` and
 * inline attachment content, so the script performs no canvas-store or
 * network I/O. Cases are deliberately few but cover the orthogonal
 * envelope concerns (plain text, full context, slash command).
 */

import { prepareExternalAgentPrompt } from '../src/modules/agent/acp/preprocessor.js';
import { renderEnvelopeMessages } from '../src/modules/agent/conversation/prompt/build-prompt.js';
import { buildAgentNodePreview } from '../src/modules/agent/node-ref.js';

import type {
  ChatEnvelope,
  ResolvedSkill,
} from '../src/modules/agent/conversation/envelope.js';
import type { AgentNodeRef } from '../src/modules/agent/node-ref.js';
import type { NodeNeighbourhoodContext } from '../src/modules/canvas/node-neighbourhood.js';
import type { ChatAttachment } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

// ─── Mock plumbing ───────────────────────────────────────────────────────────

// `prepareExternalAgentPrompt` only ever calls `logger.debug`; a no-op
// satisfies the type without pulling in pino.
const noopLogger = new Proxy(
  {},
  { get: () => () => undefined },
) as unknown as FastifyBaseLogger;

function envelope(over: {
  text?: string;
  attachments?: ChatAttachment[];
  refs?: AgentNodeRef[];
  neighbourhood?: NodeNeighbourhoodContext;
  resolvedSkills?: ResolvedSkill[];
}): ChatEnvelope {
  return {
    user: { text: over.text ?? '', attachments: over.attachments ?? [] },
    skills: {
      invokedIds: (over.resolvedSkills ?? []).map((s) => s.id),
      resolved: over.resolvedSkills ?? [],
    },
    focus: {
      selection: {
        refs: over.refs ?? [],
        selectedIds: (over.refs ?? []).map((r) => r.id),
        imageAttachments: [],
        snapshotAttachments: [],
      },
      ...(over.neighbourhood
        ? { anchor: { nodeId: 'anchor', neighbourhood: over.neighbourhood } }
        : {}),
    },
  };
}

/** Flatten a built-in user-message content to readable text. */
function renderBuiltInContent(
  content:
    | string
    | Array<{ type: string; text?: string; mimeType?: string; data?: string }>,
): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : `[${part.type} ${part.mimeType ?? ''} ${
            part.data ? `${part.data.length}b` : ''
          }]`,
    )
    .join('\n');
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CASES: Array<{ name: string; env: ChatEnvelope }> = [
  {
    name: 'plain text only',
    env: envelope({ text: 'Summarize the key risks in this proposal.' }),
  },
  {
    name: 'full context (selection + neighbourhood + skill + attachments)',
    env: envelope({
      text: 'Compare these two notes and draft a synthesis.',
      refs: [
        {
          id: 'node-aaaa',
          type: 'note',
          label: 'Risks',
          filename: 'nodes/risks.md',
          preview: 'supply chain, regulatory, fx',
        },
        {
          id: 'node-bbbb',
          type: 'note',
          label: 'Mitigations',
          filename: 'nodes/mitigations.md',
          preview: 'hedging, dual-sourcing',
        },
      ],
      neighbourhood: {
        layers: [
          {
            frameLabel: 'Strategy',
            groups: [
              {
                dx: 0,
                dy: -120,
                arrangement: 'horizontal row',
                _minEdgeDist: 30,
                nodes: [
                  buildAgentNodePreview({
                    id: 'node-dddd',
                    type: 'note',
                    label: 'Assumptions',
                    summary: 'demand flat, fx stable',
                  }),
                ],
              },
              {
                dx: 260,
                dy: 0,
                arrangement: 'single node',
                _minEdgeDist: 50,
                nodes: [
                  buildAgentNodePreview({
                    id: 'node-eeee',
                    type: 'note',
                    label: 'Open Questions',
                    summary: 'pricing, timeline',
                  }),
                ],
              },
            ],
          },
        ],
        relevantEdges: [
          {
            source: 'node-aaaa',
            target: 'node-eeee',
            sourceLabel: 'Risks',
            targetLabel: 'Open Questions',
          },
        ],
      },
      resolvedSkills: [
        {
          id: 'synthesize',
          name: 'Synthesize',
          body: 'State the thesis first, then evidence.',
        },
      ],
      attachments: [
        {
          type: 'text',
          source: 'upload',
          label: 'board-memo',
          content: 'Q3 exposure rose 12% on fx volatility.',
          originNodeId: 'node-cccc',
        },
        {
          type: 'web',
          source: 'upload',
          label: 'FX outlook',
          url: 'https://example.com/fx',
          content: 'Analysts expect continued volatility into Q4.',
        },
      ],
    }),
  },
  {
    name: 'slash command (ACP leads with command, context appended)',
    env: envelope({
      text: '/review focus on security',
      refs: [
        {
          id: 'node-aaaa',
          type: 'note',
          label: 'Risks',
          filename: 'nodes/risks.md',
          preview: 'supply chain, regulatory, fx',
        },
      ],
    }),
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

const RULE = '='.repeat(78);
const SUB = '-'.repeat(78);

async function main(): Promise<void> {
  for (const { name, env } of CASES) {
    console.log(`\n${RULE}\nCASE: ${name}\n${RULE}`);

    const { messages } = await renderEnvelopeMessages(env, { canvasId: null });
    console.log(`\n[BUILT-IN AGENT] pi-ai user message(s): ${messages.length}`);
    console.log(SUB);
    if (messages.length === 0) {
      console.log('(empty turn — no message rendered)');
    } else {
      console.log(renderBuiltInContent(messages[0].content as never));
    }

    const acp = await prepareExternalAgentPrompt({
      envelope: env,
      agentAlias: 'claude',
      includeSystem: false,
      logger: noopLogger,
    });
    console.log(`\n[EXTERNAL/ACP AGENT] session/prompt payload:`);
    console.log(SUB);
    console.log(acp.serialized);
  }
  console.log(`\n${RULE}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
