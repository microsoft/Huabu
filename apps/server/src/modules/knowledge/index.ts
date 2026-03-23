/**
 * Knowledge module exports
 * Provides centralized access to knowledge store functionality
 */

// Interface (storage-agnostic contract)
export type { IKnowledgeRepository } from './knowledge.interface.js';

// Repository (Data Access Layer)
export {
  getKnowledgeRepository,
  resetKnowledgeRepository,
} from './knowledge.repository.js';

// Obsidian backend
export { ObsidianKnowledgeRepository } from './obsidian.repository.js';

// Context Builder
export { buildContext, type SourceWithContent } from './context-builder.js';

// Utilities
export {
  normalizeUrl,
  computeContentHash,
  computeBufferHash,
  generateSourceId,
} from './utils.js';

// Fetchers/Parsers
export {
  fetchWebContent,
  type FetchWebContentResult,
} from './loaders/web.loader.js';

// Types
export type {
  SourceType,
  SourceOverview,
  SourceMetadata,
  CreateSourceInput,
} from './types.js';
