/**
 * History projection — turn records → `ChatHistoryItem[]` for the UI.
 *
 * The transcript counterpart to `prompt/build-prompt.ts`: where that
 * renders a turn into prompt messages for the model, this rebuilds the
 * user-facing chat transcript from the same structured turn records
 * (envelope + transcript + ACP overlay). Pure functions over the stored
 * `ChatTurnRecord` — no IO, so the route stays a thin loader and this is
 * unit-testable in isolation.
 */

import { commandFromRawInput, variantForInternalTool } from '@sediment/shared';

import { projectUserVisibleAttachments } from './attachment-chips.js';

import type {
  ChatTurnRecord,
  PiMessage,
} from '../../store/chat-thread-store.js';
import type { ChatEnvelope } from '../envelope.js';
import type { ToolAcpExtension } from '@agenetes/acp-driver';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  AssistantHistoryPart,
  ChatAttachment,
  ChatHistoryItem,
  ImageGenerationData,
  SnapshotNodesData,
  ToolResponse,
  WebSearchToolResponse,
} from '@sediment/shared';

/**
 * Parse a pi-ai tool-result text payload into the canonical
 * `ToolResponse<…>` envelope. Mirrors the legacy `role:'tool'`
 * reconstruction logic — preserved here because every rich-variant
 * tool part carries this envelope as its `data` field.
 *
 * `isError` is the pi-agent-core flag set when the tool handler threw
 * (e.g. `read` on a missing path). Such results carry a plain message,
 * not a JSON envelope, so we map them to a `status: 'error'` response
 * with the message preserved — otherwise the `catch` below would
 * mislabel a failed call as a successful one with the error text buried
 * in `data.content`, and the UI could not tell success from failure.
 */
function parseToolResultText(
  toolName: string,
  resultText: string,
  isError = false,
): ToolResponse<string, unknown> {
  if (isError) {
    return { tool: toolName, status: 'error', error: resultText };
  }
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

/**
 * Index the `toolResult` messages in a message list by `toolCallId`,
 * so an assistant `toolCall` block can find its result in O(1).
 */
function indexToolResults(
  msgs: readonly PiMessage[],
): Map<string, { toolName: string; resultText: string; isError: boolean }> {
  const map = new Map<
    string,
    { toolName: string; resultText: string; isError: boolean }
  >();
  for (const m of msgs) {
    if (m.role === 'toolResult') {
      const resultText = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      map.set(m.toolCallId, {
        toolName: m.toolName ?? 'unknown',
        resultText,
        isError: m.isError === true,
      });
    }
  }
  return map;
}

/** Extract the text of a (possibly multipart) user message. */
function extractUserText(msg: Extract<PiMessage, { role: 'user' }>): string {
  return typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content
          .filter(
            (b): b is { type: 'text'; text: string } =>
              typeof b === 'object' && b !== null && b.type === 'text',
          )
          .map((b) => b.text)
          .join('\n')
      : '';
}

/**
 * Build the ordered `AssistantHistoryPart[]` for one pi-ai assistant
 * message: text / thinking blocks plus tool segments folded in by
 * `toolCallId`. The ACP overlay (`toolExtras`) supplies the semantic
 * fields; the matching pi-ai `toolResult` (when present) supplies the
 * typed `data` envelope for built-in tools. Plans are NOT appended
 * here — the caller owns plan placement (turn-level).
 */
function buildAssistantParts(
  msg: AssistantMessage,
  toolResultByCallId: Map<
    string,
    { toolName: string; resultText: string; isError: boolean }
  >,
  toolExtras: Record<string, ToolAcpExtension> | undefined,
): AssistantHistoryPart[] {
  const parts: AssistantHistoryPart[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) {
        parts.push({ kind: 'text', text: block.text });
      }
    } else if (block.type === 'thinking') {
      if (block.thinking.length > 0) {
        parts.push({ kind: 'thinking', text: block.thinking });
      }
    } else if (block.type === 'toolCall') {
      const toolCallId = block.id;
      const toolName = block.name;
      const result = toolResultByCallId.get(toolCallId);
      const extras = toolExtras?.[toolCallId];
      // Structural internal-vs-external discriminator: the internal
      // pi-ai bridge pushes a matching `toolResult`; the ACP path does
      // not. So the presence of `result` is itself the signal.
      const toolData = result
        ? parseToolResultText(toolName, result.resultText)
        : undefined;
      const variant = toolData ? variantForInternalTool(toolName) : 'generic';
      const command = commandFromRawInput(block.arguments);
      const base = {
        kind: 'tool' as const,
        toolCallId,
        title: toolName,
        ...(command ? { command } : {}),
        ...(extras?.toolKind ? { toolKind: extras.toolKind } : {}),
        ...(extras?.status ? { status: extras.status } : {}),
        ...(extras?.locations ? { locations: extras.locations } : {}),
        ...(extras?.content ? { content: extras.content } : {}),
        ...(extras?.rawOutput !== undefined
          ? { rawOutput: extras.rawOutput }
          : {}),
        ...(extras?.permission ? { permission: extras.permission } : {}),
      };
      switch (variant) {
        case 'agent_tool': {
          // Fold the call's input args UNDER the result payload (result
          // wins), mirroring the live stream (`applyInternalToolResult`).
          // This surfaces query params the result doesn't echo — e.g. a
          // `find` / `grep` `pattern` — so the UI can show WHAT was
          // searched, WITHOUT the tool echoing its own input back into
          // the model-visible result.
          const args =
            block.arguments && typeof block.arguments === 'object'
              ? (block.arguments as Record<string, unknown>)
              : undefined;
          const data =
            toolData && toolData.status === 'success' && args
              ? {
                  ...toolData,
                  data: {
                    ...args,
                    ...((toolData.data as
                      | Record<string, unknown>
                      | undefined) ?? {}),
                  },
                }
              : toolData;
          parts.push({
            ...base,
            variant: 'agent_tool',
            toolName,
            ...(data ? { data } : {}),
          });
          break;
        }
        case 'canvas_commands':
          parts.push({
            ...base,
            variant: 'canvas_commands',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'canvas_commands',
                    Record<string, unknown>
                  >,
                }
              : {}),
          });
          break;
        case 'web_search':
          parts.push({
            ...base,
            variant: 'web_search',
            ...(toolData ? { data: toolData as WebSearchToolResponse } : {}),
          });
          break;
        case 'image_generation':
          parts.push({
            ...base,
            variant: 'image_generation',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'generate_image',
                    ImageGenerationData
                  >,
                }
              : {}),
          });
          break;
        case 'snapshot_nodes':
          parts.push({
            ...base,
            variant: 'snapshot_nodes',
            ...(toolData
              ? {
                  data: toolData as ToolResponse<
                    'snapshot_nodes',
                    SnapshotNodesData
                  >,
                }
              : {}),
          });
          break;
        case 'generic':
          parts.push({ ...base, variant: 'generic' });
          break;
      }
    }
  }
  return parts;
}

/**
 * Convert the structured per-turn records into `ChatHistoryItem`
 * entries for the client.
 *
 * Each turn emits a user item directly from its {@link ChatEnvelope}
 * (no `[SYSTEM …]` tag stripping — selection / skills / attachments
 * are already structured fields) followed by the assistant/tool/status
 * items reconstructed from the turn's transcript. Message ORDER comes
 * from the transcript array; the ACP overlay (`turn.toolExtras` /
 * `turn.plan`) joins by stable `toolCallId` and is turn-level — no
 * timestamps, no position arrays, no separate sidecar.
 */
export function buildHistoryFromTurns(
  turns: readonly ChatTurnRecord[],
  messages: ChatHistoryItem[],
): void {
  for (const turn of turns) {
    const envelope: ChatEnvelope = turn.envelope;

    // 1. User item, straight from the structured envelope.
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
        ...(invokedSkills.length > 0 && { invokedSkills }),
      });
    }

    // 2. Transcript: assistant / tool / status items.
    let pendingStatus: ChatHistoryItem | null = null;
    let currentAssistant: Extract<
      ChatHistoryItem,
      { role: 'assistant' }
    > | null = null;
    const flushStatus = () => {
      if (pendingStatus) {
        messages.push(pendingStatus);
        pendingStatus = null;
        currentAssistant = null;
      }
    };

    const toolResultByCallId = indexToolResults(turn.transcript);
    const toolExtras = turn.toolExtras;

    for (const msg of turn.transcript) {
      if (msg.role === 'user') {
        // Only `[SYSTEM …]` status rows appear in a transcript — the
        // real user message is the envelope above. Legacy
        // `[SYSTEM PreparedPrompt]` rows (now retired) are ignored.
        const content = extractUserText(msg).trim();
        if (content.startsWith('[SYSTEM Interrupted]')) {
          pendingStatus = { role: 'status', status: 'interrupted' };
          continue;
        }
        if (content.startsWith('[SYSTEM Error]')) {
          const detail = content.slice('[SYSTEM Error] '.length);
          pendingStatus = { role: 'status', status: 'error', detail };
          continue;
        }
        // Any other unexpected user-role row in a transcript is ignored.
        continue;
      } else if (msg.role === 'assistant') {
        const parts = buildAssistantParts(msg, toolResultByCallId, toolExtras);
        if (parts.length > 0) {
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
        }
        flushStatus();
      }
      // toolResult: folded into the assistant turn via toolCallId.
    }

    // Turn-level plan (folded ACP overlay): appended once at the end.
    if (turn.plan && turn.plan.length > 0 && currentAssistant) {
      currentAssistant.parts.push({ kind: 'plan', entries: turn.plan });
    }

    flushStatus();
  }
}
