/**
 * Knowledge module exports
 * Provides centralized access to knowledge store functionality
 */

// Database
export { getKnowledgeDb, closeKnowledgeDb } from './knowledge.db.js';

// Interface (storage-agnostic contract)
export type { IKnowledgeRepository } from './knowledge.interface.js';

// Repository (Data Access Layer)
export {
  KnowledgeRepository,
  getKnowledgeRepository,
} from './knowledge.repository.js';

// Obsidian backend
export { ObsidianKnowledgeRepository } from './obsidian.repository.js';

// Service (Business Logic Layer)
export { IngestService, getIngestService } from './ingest.service.js';
export type {
  IngestTextSourceInput,
  IngestWebSourceInput,
  IngestPdfSourceInput,
  IngestSourceResult,
} from './ingest.service.js';

// Context Builder
export { buildContext, type SourceWithContent } from './context-builder.js';

// Utilities
export {
  normalizeUrl,
  computeContentHash,
  computeBufferHash,
  generateSourceId,
  generateRevisionId,
} from './utils.js';

// Fetchers/Parsers
export { fetchWebContent, type FetchWebContentResult } from './web-fetcher.js';
export {
  parsePdfFile,
  parsePdfBuffer,
  type ParsePdfResult,
} from './pdf-parser.js';

// Types
export type {
  SourceType,
  SourceRow,
  SourceRevisionRow,
  SourceMetadata,
  CreateSourceInput,
  CreateRevisionInput,
} from './types.js';
