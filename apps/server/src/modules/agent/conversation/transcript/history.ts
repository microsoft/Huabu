// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * History projection — folded `AgentTurn`s → `ChatHistoryItem[]` for the UI.
 *
 * The transcript counterpart to `prompt/build-prompt.ts`: where that
 * projects a turn into prompt messages for the model, this rebuilds the
 * user-facing chat transcript from the same L2 Tier-2 records — a folded
 * {@link AgentTurn} per completed run (README I9.8). The user side is
 * rebuilt from `turn.request.content` (the persisted {@link ChatEnvelope},
 * wrapped as the host's `huabu.chat` request variant); the assistant / tool
 * side from `turn.transcript` (a flat {@link FoldedMessage}[] in emission
 * order). Pure functions — no IO, so the route stays a thin loader and this
 * is unit-testable in isolation.
 */

import { commandFromRawInput, variantForInternalTool } from '@huabu/shared';

import { projectUserVisibleAttachments } from './attachment-chips.js';
import {
  chatEnvelopeFromSubmission,
  interactiveViewEventFromSubmission,
} from '../../agenetes/handle.js';

import type { ChatEnvelope } from '../envelope.js';
import type { AgentTurn, FoldedMessage } from '@agenetes/protocol';
import type {
  AssistantHistoryPart,
  ChatAttachment,
  ChatHistoryItem,
  ImageGenerationData,
  SnapshotNodesData,
  ToolResponse,
  WebSearchToolResponse,
} from '@huabu/shared';

/** The folded `tool_call` payload, plus the host-extension fields that
 *  ride verbatim through the fold (never declared on the base schema). */
type FoldedToolCallData = Extract<
  FoldedMessage,
  { type: 'tool_call' }
>['data'] & {
  /** Machine tool name (built-in only) — drives the render variant. */
  internalToolName?: string;
  /** Result payload folded from `tool_call_update.rawOutput`. */
  rawOutput?: unknown;
};

/**
 * Parse a tool-result text payload into the canonical
 * `ToolResponse<…>` envelope. Every rich-variant tool part carries this
 * envelope as its `data` field. Built-in tools deliver a JSON-encoded
 * `ToolResponse` on the folded `tool_call.data.rawOutput`; a bare or
 * non-JSON payload is wrapped as a `status: 'success'` content blob.
 */
function parseToolResultText(
  toolName: string,
  resultText: string,
): ToolResponse<string, unknown> {
  try {
    const parsed = JSON.parse(resultText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      'status' in parsed
    ) {
      return parsed as ToolResponse<string, unknown>;
    }
    // `snapshot_nodes` returns a bare array; wrap it under `snapshots`
    // so the rich `SnapshotNodesToolPart.data.data` carries a stable
    // object shape (matching what the live stream merger produces).
    if (toolName === 'snapshot_nodes' && Array.isArray(parsed)) {
      return {
        tool: toolName,
        status: 'success',
        data: { snapshots: parsed },
      };
    }
    return {
      tool: toolName,
      status: 'success',
      data: parsed,
    };
  } catch {
    return {
      tool: toolName,
      status: 'success',
      data: { content: resultText },
    };
  }
}

function mergeInternalToolArgs(
  toolData: ToolResponse<string, unknown> | undefined,
  rawInput: unknown,
): ToolResponse<string, unknown> | undefined {
  if (
    !toolData ||
    toolData.status !== 'success' ||
    !rawInput ||
    typeof rawInput !== 'object'
  )
    return toolData;
  const resultData =
    toolData.data &&
    typeof toolData.data === 'object' &&
    !Array.isArray(toolData.data)
      ? (toolData.data as Record<string, unknown>)
      : {};
  return {
    ...toolData,
    data: {
      ...(rawInput as Record<string, unknown>),
      ...resultData,
    },
  } as ToolResponse<string, unknown>;
}

/**
 * Build one `AssistantHistoryPart` for a folded `tool_call` message.
 *
 * Everything the renderer needs already lives on the folded
 * `tool_call.data` (the initial `tool_call` merged with every
 * `tool_call_update`): the ACP semantic fields (`toolKind` / `status` /
 * `locations` / `content` / `rawOutput`). Live events may include the machine
 * `internalToolName`; folded internal workload history recovers that identity
 * from `title` before calling this function. External ACP titles are never
 * recovered as internal names, so those tools remain generic.
 */
function buildToolPart(
  data: FoldedToolCallData,
  recoverInternalToolName: boolean,
): AssistantHistoryPart {
  const toolCallId = data.toolCallId;
  const internalName =
    data.internalToolName ?? (recoverInternalToolName ? data.title : undefined);
  const command = data.command ?? commandFromRawInput(data.rawInput);
  // Internal tools carry a JSON `ToolResponse` string on `rawOutput`.
  // External ACP tools render their folded content, locations, and raw output
  // on the generic card instead.
  const toolData =
    internalName !== undefined && typeof data.rawOutput === 'string'
      ? parseToolResultText(internalName, data.rawOutput)
      : undefined;
  const variant = internalName
    ? variantForInternalTool(internalName)
    : 'generic';
  const mergedToolData = mergeInternalToolArgs(toolData, data.rawInput);

  const base = {
    kind: 'tool' as const,
    toolCallId,
    title: data.title ?? internalName ?? 'tool',
    ...(command ? { command } : {}),
    ...(data.toolKind ? { toolKind: data.toolKind } : {}),
    ...(data.status ? { status: data.status } : {}),
    ...(data.locations ? { locations: data.locations } : {}),
    ...(data.content ? { content: data.content } : {}),
    // Surface raw output for every generic card, including unknown internal
    // tools that do not have a dedicated renderer yet.
    ...(variant === 'generic' && data.rawOutput !== undefined
      ? { rawOutput: data.rawOutput }
      : {}),
  };

  switch (variant) {
    case 'agent_tool': {
      return {
        ...base,
        variant: 'agent_tool',
        toolName: internalName ?? base.title,
        ...(mergedToolData ? { data: mergedToolData } : {}),
      };
    }
    case 'space_commands': {
      return {
        ...base,
        variant: 'space_commands',
        ...(mergedToolData
          ? {
              data: {
                ...mergedToolData,
                tool: 'space_commands',
              } as ToolResponse<'space_commands', Record<string, unknown>>,
            }
          : {}),
      };
    }
    case 'web_search': {
      return {
        ...base,
        variant: 'web_search',
        ...(mergedToolData
          ? { data: mergedToolData as WebSearchToolResponse }
          : {}),
      };
    }
    case 'image_generation': {
      return {
        ...base,
        variant: 'image_generation',
        ...(mergedToolData
          ? {
              data: mergedToolData as ToolResponse<
                'generate_image',
                ImageGenerationData
              >,
            }
          : {}),
      };
    }
    case 'snapshot_nodes': {
      return {
        ...base,
        variant: 'snapshot_nodes',
        ...(mergedToolData
          ? {
              data: mergedToolData as ToolResponse<
                'snapshot_nodes',
                SnapshotNodesData
              >,
            }
          : {}),
      };
    }
    case 'generic':
    default:
      return { ...base, variant: 'generic' };
  }
}

/**
 * Extract the folded envelope from a turn's `request`. The host persists
 * its per-turn request as the `huabu.chat` variant (`{ type, content }`),
 * so the envelope is `request.content`. A `null` request (a resume turn
 * with no new user input) yields no user bubble.
 */
function envelopeOf(turn: AgentTurn): ChatEnvelope | null {
  return chatEnvelopeFromSubmission(turn.request);
}

/**
 * Convert the folded per-turn records into `ChatHistoryItem` entries for
 * the client.
 *
 * Each turn emits a user item from its {@link ChatEnvelope} (selection /
 * skills / attachments are structured fields — no `[SYSTEM …]` tag
 * stripping) followed by the assistant / tool / status items rebuilt from
 * the turn's folded transcript. Message ORDER is the transcript array
 * order; a turn-level `plan` (folded once at turn end) is appended after
 * the assistant parts, and an interrupted / errored run surfaces a status
 * row from `turn.meta.stopReason` / a folded `error` message.
 */
export function buildHistoryFromTurns(
  turns: readonly AgentTurn[],
  messages: ChatHistoryItem[],
  options: { recoverInternalToolNames?: boolean } = {},
): void {
  for (const turn of turns) {
    const envelope = envelopeOf(turn);
    const viewEvent = interactiveViewEventFromSubmission(turn.request);

    // 1. User item, straight from the structured envelope.
    if (envelope) {
      const allAttachments = [
        ...envelope.user.attachments,
        ...envelope.focus.selection.imageAttachments,
        ...envelope.focus.selection.snapshotAttachments,
      ];
      const attachments = projectUserVisibleAttachments(
        allAttachments,
        envelope.focus.selection.selectedIds,
      );
      const selectedNodeIds = envelope.focus.selection.selectedIds;
      const selectedStrokeIds = envelope.focus.selection.strokeSubsets ?? [];
      const invokedSkills = envelope.skills.invokedIds;
      if (
        envelope.user.text.trim() ||
        attachments.length > 0 ||
        selectedNodeIds.length > 0
      ) {
        messages.push({
          role: 'user',
          content: envelope.user.text,
          ...(attachments.length > 0 && {
            attachments: attachments as ChatAttachment[],
          }),
          ...(selectedNodeIds.length > 0 && { selectedNodeIds }),
          ...(selectedStrokeIds.length > 0 && { selectedStrokeIds }),
          ...(invokedSkills.length > 0 && { invokedSkills }),
        });
      }
    } else if (viewEvent) {
      messages.push({
        role: 'user',
        content: `Interactive View action: ${viewEvent.actionId}`,
      });
    }

    // 2. Transcript: assistant / tool items, in emission order.
    let currentAssistant: Extract<
      ChatHistoryItem,
      { role: 'assistant' }
    > | null = null;
    let planPart: AssistantHistoryPart | null = null;
    let errorDetail: string | null = null;

    const pushAssistantParts = (parts: AssistantHistoryPart[]): void => {
      if (parts.length === 0) return;
      if (currentAssistant) {
        currentAssistant.parts.push(...parts);
      } else {
        const item: Extract<ChatHistoryItem, { role: 'assistant' }> = {
          role: 'assistant',
          parts,
        };
        messages.push(item);
        currentAssistant = item;
      }
    };

    for (const msg of turn.transcript) {
      switch (msg.type) {
        case 'text':
          if (msg.data.content.length > 0) {
            pushAssistantParts([{ kind: 'text', text: msg.data.content }]);
          }
          break;
        case 'thinking':
          if (msg.data.content.length > 0) {
            pushAssistantParts([{ kind: 'thinking', text: msg.data.content }]);
          }
          break;
        case 'tool_call':
          pushAssistantParts([
            buildToolPart(
              msg.data as FoldedToolCallData,
              options.recoverInternalToolNames === true,
            ),
          ]);
          break;
        case 'plan':
          // Latest-wins; the fold appends it once at turn end. Held and
          // attached after the assistant parts (turn-level placement).
          if (msg.data.entries.length > 0) {
            planPart = { kind: 'plan', entries: msg.data.entries };
          }
          break;
        case 'error':
          errorDetail = msg.data.error ?? 'Agent error';
          break;
      }
    }

    // Turn-level plan (folded ACP overlay): appended once at the end to
    // this turn's assistant item (the last pushed message when present).
    if (planPart) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.parts.push(planPart);
      }
    }

    // 3. Terminal status row (interrupted / error), derived from the run
    // metadata + any folded error — not from a synthetic transcript row.
    // Both the built-in (`aborted`) and ACP (`cancelled`) backends signal a
    // user interruption via `meta.stopReason`.
    const stopReason = turn.meta?.stopReason;
    if (stopReason === 'aborted' || stopReason === 'cancelled') {
      messages.push({ role: 'status', status: 'interrupted' });
    } else if (errorDetail) {
      messages.push({ role: 'status', status: 'error', detail: errorDetail });
    }
  }
}
