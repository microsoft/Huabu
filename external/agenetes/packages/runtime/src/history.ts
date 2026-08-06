// History replay projections shared by drivers whose replay channel cannot
// carry the durable payload verbatim.

import { resolveAgentInputs } from '@agenetes/protocol';

import type { AgentInput, AgentInputPart, AgentTurn } from '@agenetes/protocol';

function approximateDecodedBytes(data: string): number {
  const base64 = data.startsWith('data:') ? (data.split(',')[1] ?? '') : data;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function projectTextHistoryPart(part: AgentInputPart): AgentInputPart {
  if (part.type !== 'image') return part;
  const kb = Math.max(1, Math.round(approximateDecodedBytes(part.data) / 1024));
  return {
    type: 'text',
    text: `[image omitted from text-only history replay: ${part.mimeType}, ~${kb} KB. Its description, if any, is in the surrounding text.]`,
  };
}

function projectTextHistoryInput(input: AgentInput): AgentInput {
  switch (input.type) {
    case 'parts':
      return { ...input, parts: input.parts.map(projectTextHistoryPart) };
    case 'command':
      return { ...input, context: input.context.map(projectTextHistoryPart) };
    default:
      return input;
  }
}

/**
 * Project one durable turn into a text-only replay payload. Text is kept
 * verbatim; image bodies become compact placeholders because base64 embedded
 * in a text prompt restores no image semantics and would otherwise consume the
 * whole history-load budget. Drivers with a structured replay channel should
 * lower the turn natively instead of calling this.
 */
export function projectTextHistoryTurn(turn: AgentTurn): AgentTurn {
  if (turn.request === null) return turn;
  return {
    ...turn,
    request: {
      ...turn.request,
      rendered: resolveAgentInputs(turn.request).map(projectTextHistoryInput),
    },
  };
}
