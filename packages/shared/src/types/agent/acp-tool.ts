// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP rich-update types re-exported from `@agentclientprotocol/sdk`
 * under `Acp*` aliases. Type-only — zero runtime cost; safe for the
 * web bundle. Server-side zod validators live in `../api/acp-tool.ts`.
 */
export type {
  // Tool-call lifecycle
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallLocation as AcpToolCallLocation,
  ToolKind as AcpToolKind,
  // Content & plan
  ContentBlock as AcpContentBlock,
  PlanEntry as AcpPlanEntry,
  Plan as AcpPlan,
  Diff as AcpDiff,
  Terminal as AcpTerminal,
  // Permission handshake
  PermissionOption as AcpPermissionOption,
  PermissionOptionKind as AcpPermissionOptionKind,
  RequestPermissionRequest as AcpRequestPermissionRequest,
  RequestPermissionResponse as AcpRequestPermissionResponse,
  // Session update union
  SessionUpdate as AcpSessionUpdate,
  // Session-meta variants (mode / model / config / info / usage)
  // Re-exported so both server (translator + session entry) and web
  // (SSE handlers + selector UI) can share the wire shapes verbatim.
  SessionConfigOption as AcpSessionConfigOption,
  SessionConfigOptionCategory as AcpSessionConfigOptionCategory,
  SessionConfigSelectOption as AcpSessionConfigSelectOption,
  SessionConfigSelectGroup as AcpSessionConfigSelectGroup,
  SessionConfigValueId as AcpSessionConfigValueId,
  SessionConfigId as AcpSessionConfigId,
  SessionMode as AcpSessionMode,
  SessionModeId as AcpSessionModeId,
  SessionModeState as AcpSessionModeState,
  SessionModelState as AcpSessionModelState,
  ModelInfo as AcpModelInfo,
  ModelId as AcpModelId,
  SessionInfoUpdate as AcpSessionInfoUpdate,
  UsageUpdate as AcpUsageUpdate,
  Cost as AcpCost,
} from '@agentclientprotocol/sdk';
