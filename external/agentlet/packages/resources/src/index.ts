/**
 * @agentlet/resources
 *
 * Machine-local resource root layout, receipt persistence, and a bounded
 * catalogue projection for Agentlet-managed Skills, tools, and connectors.
 * See `spec/local-resources.md` for the full contract.
 */

// Resource root — AGENT_RESOURCE_DIR resolution and bounded directory layout
export {
  RESOURCE_SUBDIRS,
  resolveResourceRoot,
  resourceSubdirPath,
  ensureResourceLayout,
} from './resource-dir.js';
export type { ResourceSubdir } from './resource-dir.js';

// Receipts — versioned, atomically persisted local installation records
export {
  RECEIPT_SCHEMA_VERSION,
  parseReceipt,
  readReceipt,
  writeReceipt,
  removeReceipt,
  assertInsideResourceRoot,
} from './receipts.js';
export type { ResourceKind, ResourceReceipt, ResourceReceiptInput } from './receipts.js';

// Catalogue — machine-local resource enumeration/projection for host integration
export { enumerateLocalResources } from './catalogue.js';
export type {
  LocalResourceRecord,
  LocalResourceDiagnostic,
  LocalResourceEnumeration,
} from './catalogue.js';
