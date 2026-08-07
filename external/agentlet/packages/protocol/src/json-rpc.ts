// ─── JSON-RPC 2.0 Base Types ──────────────────────────────────────────────────

/** JSON-RPC 2.0 request (expects a response) */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  id: string | number
  params?: Record<string, unknown>
}

/** JSON-RPC 2.0 notification (fire-and-forget, no response expected) */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

/** JSON-RPC 2.0 success response */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0'
  id: string | number
  result: unknown
}

/** JSON-RPC 2.0 error response */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number
  error: JsonRpcError
}

/** JSON-RPC 2.0 error object */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** Any JSON-RPC response */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

/** Any valid JSON-RPC 2.0 message */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/**
 * ACP message — semantically identical to JsonRpcMessage.
 * This alias clarifies intent: "a JSON-RPC message carrying ACP content."
 * Agentlet never interprets ACP payloads — it relays them verbatim.
 */
export type AcpMessage = JsonRpcMessage
