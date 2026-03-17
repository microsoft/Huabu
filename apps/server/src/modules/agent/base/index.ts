/**
 * Agent Base Module (pi-ai)
 *
 * Re-exports the agent service and types.
 * The old LangGraph-based BaseAgent, IAgent, etc. are no longer used.
 */

export {
  runAgent,
  createContext,
  type StreamEvent,
  type StreamEventType,
  type AgentRunOptions,
} from '../agent.service.js';
export type { AgentMode } from '@sediment/shared';
