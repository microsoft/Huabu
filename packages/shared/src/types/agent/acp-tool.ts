/**
 * ACP rich-update types (re-exported from `@agentclientprotocol/sdk`).
 *
 * Re-exports a curated subset of the official ACP schema types under
 * Sediment-prefixed aliases (`Acp*`). All exports are **type-only**:
 * `export type { … }` collapses to zero bytes at runtime, so importing
 * this file from the web bundle does NOT pull the SDK or its zod
 * runtime in. Server-side validators live in
 * `../api/acp-tool.ts` (zod-bearing) and are imported separately.
 *
 * Why a curated re-export instead of using SDK names directly?
 *
 *   1. **Stable name space.** Sediment owns the `Acp*` namespace; if
 *      we ever fork the SDK or pin an older schema, internal callers
 *      keep compiling.
 *   2. **Discoverability.** `import type { AcpToolCall } from
 *      '@sediment/shared'` is one hop; chasing the SDK's deep
 *      `dist/schema/types.gen` is not.
 *   3. **Scope discipline.** Only the types we ACTUALLY consume in
 *      §1/§2/§4 of the assistant-segments plan are re-exported. The
 *      JSON-RPC plumbing (`AgentSideConnection`, …) stays in SDK
 *      land — we do not re-implement a JSON-RPC client.
 *
 * The list is intentionally narrow. Add more aliases here only when a
 * concrete consumer needs them; otherwise the import surface bloats.
 */

export type {
  // Tool-call lifecycle (translator emits `tool_call` / `tool_call_update`
  // SSE events; assistant-parts persist these for replay).
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallLocation as AcpToolCallLocation,
  ToolKind as AcpToolKind,
  // Generic content block — appears inside ToolCallContent and most
  // session-update payloads (text/image/audio/resource/link).
  ContentBlock as AcpContentBlock,
  // Plan updates — emitted alongside tool calls; rendered as a
  // task list above the chat.
  PlanEntry as AcpPlanEntry,
  Plan as AcpPlan,
  // Diff / Terminal — currently referenced only by tool-call
  // content blocks; re-exported so consumers can narrow on them
  // without a second SDK import.
  Diff as AcpDiff,
  Terminal as AcpTerminal,
  // Permission handshake — request flows into our auto-allow
  // handler in `acp/client.ts`; the chosen option round-trips
  // back via the response. Mirrors live on §2.4 `permission` field
  // (see `assistant-parts.ts`).
  PermissionOption as AcpPermissionOption,
  PermissionOptionKind as AcpPermissionOptionKind,
  RequestPermissionRequest as AcpRequestPermissionRequest,
  RequestPermissionResponse as AcpRequestPermissionResponse,
  // Union of every `session/update` notification body. Used by the
  // translator to discriminate on `update.sessionUpdate`.
  SessionUpdate as AcpSessionUpdate,
} from '@agentclientprotocol/sdk';
