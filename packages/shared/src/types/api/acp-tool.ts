// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Runtime zod schemas for ACP wire payloads. Server-side validators
 * paired with the type-only re-exports in `../agent/acp-tool.ts`;
 * used by `acp/translator.ts` and `acp/client.ts` to `safeParse`
 * every payload from an external agent process.
 *
 * Deep import is required: the SDK's main entry only re-exports
 * types, not the runtime zod barrel.
 *
 * Web-bundle hygiene: this file is zod runtime, so all web imports
 * of `@huabu/shared` must be `import type` (enforced by
 * `__tests__/acp-tool-bundle.test.ts`).
 */

export {
  zToolCall as ZAcpToolCall,
  zToolCallUpdate as ZAcpToolCallUpdate,
  zToolCallContent as ZAcpToolCallContent,
  zToolKind as ZAcpToolKind,
  zToolCallStatus as ZAcpToolCallStatus,
  zToolCallLocation as ZAcpToolCallLocation,
  zContentBlock as ZAcpContentBlock,
  zPlan as ZAcpPlan,
  zPlanEntry as ZAcpPlanEntry,
  zSessionUpdate as ZAcpSessionUpdate,
  // Session-meta variants — surfaced for explicit shape narrowing in
  // `handleSessionMetaUpdate` and for validating the
  // `config_options_update` / `current_mode_update` / `session_info_update`
  // / `usage_update` SSE payloads that travel through
  // `EnsureAcpSessionResponse` and `AcpThreadCommandsResponse`.
  zSessionConfigOption as ZAcpSessionConfigOption,
  zSessionMode as ZAcpSessionMode,
  zSessionModeState as ZAcpSessionModeState,
  zSessionModelState as ZAcpSessionModelState,
  zModelInfo as ZAcpModelInfo,
  zSessionInfoUpdate as ZAcpSessionInfoUpdate,
  zUsageUpdate as ZAcpUsageUpdate,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
