import type { JsonRpcError } from '@agentlet/protocol';

/** Error returned by an agentlet control request, preserving JSON-RPC data. */
export class AgentletRequestError extends Error {
  readonly rpcCode: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'AgentletRequestError';
    this.rpcCode = error.code;
    this.data = error.data;
  }
}
