/**
 * FROZEN legacy schema — the pre-Agenetes chat turn record.
 *
 * This module is a snapshot of the on-disk shape that the old chat
 * thread store persisted to `<canvasDir>/.history/chat/<threadId>.turns.jsonl`
 * (one {@link LegacyChatTurnRecord} per line). It exists ONLY so the
 * boot migrators can read that legacy log and fold it forward into the
 * new Agenetes-era two-tier log (`chat_v2/`).
 *
 * ### Why a frozen copy instead of importing the live types?
 *
 * The migrators' only dependency on the past must be an inert,
 * snapshotted schema — never the evolving live `ChatEnvelope` /
 * `ChatTurnRecord` types. If a future refactor changes the live
 * `ChatEnvelope`, that change must NOT silently re-interpret bytes that
 * were written under the old shape. Freezing the descriptor here
 * decouples "how we read old data" from "how the app models data today",
 * so the live store code can be deleted without breaking migration.
 *
 * The types here are deliberately a structural SUPERSET (looser, mostly
 * optional) of what the live code once wrote, so the still-shipped
 * first-hop migrator (`migrate-chat-threads.ts`, which constructs these
 * records from even older pi-ai `Context` files) keeps type-checking
 * against it while the second-hop migrator reads it back defensively.
 *
 * Only stable, versioned package wire-types are referenced by `import
 * type` (pi-ai messages, the ACP overlay, the shared attachment type);
 * every host-owned shape is snapshotted locally. No behavioural host
 * imports.
 */

import type { ToolAcpExtension } from '@agenetes/acp-driver';
import type { Context } from '@earendil-works/pi-ai';
import type { AcpPlanEntry, ChatAttachment } from '@sediment/shared';

/** A pi-ai message as stored on a legacy {@link Context}. */
export type LegacyPiMessage = Context['messages'][number];

/** A user-invoked skill resolved to its body, as once persisted. */
export interface LegacyResolvedSkill {
  id: string;
  name: string;
  body: string;
}

/**
 * A selected-node reference as once persisted in the envelope. Kept
 * deliberately loose (every field bar `id` optional) so any historical
 * node-preview shape parses, and so the live `AgentNodePreview` the
 * first-hop migrator builds is structurally assignable to it.
 */
export interface LegacyNodePreview {
  id: string;
  type?: string;
  label?: string;
  filename?: string;
  summary?: string;
  preview?: string;
  rev?: string;
}

/**
 * The structured per-turn context envelope, snapshotted. A structural
 * superset of the historical `ChatEnvelope`: the migrator reads
 * `user.text`, `skills.invokedIds`, and `focus.selection.{refs,
 * selectedIds}`; the remaining fields are carried for fidelity but
 * typed loosely because no reader depends on their internals.
 */
export interface LegacyChatEnvelope {
  user: {
    text: string;
    attachments: ChatAttachment[];
  };
  skills: {
    invokedIds: string[];
    resolved: LegacyResolvedSkill[];
  };
  focus: {
    selection: {
      refs: LegacyNodePreview[];
      selectedIds: string[];
      imageAttachments: ChatAttachment[];
      snapshotAttachments: ChatAttachment[];
    };
    anchor?: {
      nodeId: string;
      label?: string;
      neighbourhood?: unknown;
    };
  };
}

/**
 * One legacy turn: the user's structured input envelope, the
 * assistant/tool transcript, and the optional rich-ACP overlay
 * (`toolExtras` keyed by `toolCallId`, `plan` the turn's final plan).
 */
export interface LegacyChatTurnRecord {
  envelope: LegacyChatEnvelope;
  transcript: LegacyPiMessage[];
  toolExtras?: Record<string, ToolAcpExtension>;
  plan?: AcpPlanEntry[];
}

/** Tolerant guard for a persisted {@link LegacyChatTurnRecord} line. */
export function isLegacyChatTurnRecord(
  value: unknown,
): value is LegacyChatTurnRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Partial<LegacyChatTurnRecord>;
  return (
    typeof rec.envelope === 'object' &&
    rec.envelope !== null &&
    Array.isArray(rec.transcript)
  );
}
