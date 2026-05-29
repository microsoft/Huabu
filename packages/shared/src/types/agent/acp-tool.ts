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
} from '@agentclientprotocol/sdk';
