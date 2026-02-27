/**
 * Agent Base Module
 *
 * Unified infrastructure for all agent implementations.
 */

// Types
export type {
  AgentType,
  AgentConfig,
  BaseAgentState,
  AgentEventType,
  AgentEvent,
} from './agent.types.js';

// Interface
export type { IAgent } from './agent.interface.js';

// Base class
export { BaseAgent } from './base-agent.js';
