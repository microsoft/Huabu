// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Action-log node reference.
 *
 * The LLM-facing ref ladder (`AgentNodeRef` / `AgentNodePreview` /
 * `AgentNodeOutline`) lives server-only in
 * `apps/server/src/modules/agent/node-ref.ts`. Wire shapes posted
 * from the web client (`WireNodeRef` / `WireSelectionNode` /
 * `WireCanvasNode`) live in `../api/agent.ts`.
 *
 * What stays here is just `NodeRef` — the on-disk action-log shape,
 * shared between server and web because the web reads action-log
 * payloads back from `RecentAction` events.
 */

import type { CanvasNodeType, NodeOrigin } from '../canvas/node.js';

/**
 * Shared minimum for any node reference, regardless of consumer
 * (action log, LLM prompt, UI badge). Kept deliberately small so the
 * field names stay identical across the codebase.
 */
export interface NodeRefBase {
  id: string;
  type: CanvasNodeType;
  /** Display name; omitted when blank (e.g. fresh frame). */
  label?: string;
}

/**
 * Reference persisted to `<canvas>/.history/events.jsonl` and carried
 * inside `RecentAction` payloads. Adds `origin` so the agent can
 * reason about how the node came to exist (user-created, ai-operate,
 * etc.).
 *
 * Distinct from the server-only `AgentNodeRef`: the action log is
 * long-lived historical data, while `AgentNodeRef` is a per-turn LLM
 * input.
 */
export interface NodeRef extends NodeRefBase {
  origin?: NodeOrigin;
}
