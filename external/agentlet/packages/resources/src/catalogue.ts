import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { resourceSubdirPath } from './resource-dir.js';
import { parseReceipt, type ResourceReceipt } from './receipts.js';

/**
 * Minimal machine-local resource record.
 *
 * Field-for-field, this mirrors the canonical Agenetes `AgentResource` shape
 * described in `docs/proposals/agent-resource-registry.md`
 * (`schemaVersion: 1`, `id`, `name`, `provider`, `description`,
 * `instructions`). Agentlet has no build/workspace dependency on the
 * Agenetes packages — they live in a separate repository and pnpm
 * workspace — so this type is a self-contained adapter shape rather than an
 * import of the Agenetes type. A host integration (Huabu's Agentlet
 * provider) maps `LocalResourceRecord` onto its own `AgentResource` type
 * one field at a time at that adapter boundary; because the shapes match,
 * the mapping is a structural no-op.
 */
export interface LocalResourceRecord {
  schemaVersion: 1;
  id: string;
  name: string;
  provider: string;
  description: string;
  instructions: string;
}

export interface LocalResourceDiagnostic {
  receiptPath: string;
  code: 'invalid_receipt' | 'receipt_unreadable';
  message: string;
}

export interface LocalResourceEnumeration {
  rootPath: string;
  records: LocalResourceRecord[];
  diagnostics: LocalResourceDiagnostic[];
}

function projectRecord(receipt: ResourceReceipt): LocalResourceRecord {
  return {
    schemaVersion: 1,
    id: receipt.id,
    name: receipt.name,
    provider: receipt.provider,
    description: receipt.description,
    instructions: receipt.instructions,
  };
}

/**
 * Enumerate validated receipts under `<root>/receipts` and project them into
 * minimal, safe-to-publish catalogue records.
 *
 * This only ever reads inside the resource root's bounded `receipts`
 * subdirectory — it never scans `root` itself, sibling directories, or any
 * other machine path. Invalid or unreadable receipts are reported as
 * diagnostics rather than aborting the whole enumeration, mirroring
 * `scanAgentTeamRoot`'s tolerant-scan-with-diagnostics contract.
 */
export function enumerateLocalResources(
  root: string,
  expectedProvider?: string,
): LocalResourceEnumeration {
  if (!isAbsolute(root)) {
    throw new Error('Resource root must be absolute');
  }

  const receiptsDir = resourceSubdirPath(root, 'receipts');
  const records: LocalResourceRecord[] = [];
  const diagnostics: LocalResourceDiagnostic[] = [];
  const seenIds = new Set<string>();

  if (!existsSync(receiptsDir)) {
    return { rootPath: root, records, diagnostics };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(receiptsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error('Cannot scan the resource receipts directory', {
      cause: error,
    });
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const receiptPath = join(receiptsDir, entry.name);
    try {
      const raw = readFileSync(receiptPath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ReceiptUnreadableError(`Receipt is not valid JSON: ${receiptPath}`);
      }
      const receipt = parseReceipt(parsed, root);
      if (expectedProvider && receipt.provider !== expectedProvider) {
        throw new Error('Receipt provider does not match this Agentlet');
      }
      const filenameId = basename(entry.name, '.json');
      if (receipt.id !== filenameId) {
        throw new Error('Receipt filename must match its resource id');
      }
      if (seenIds.has(receipt.id)) {
        throw new Error('Duplicate resource receipt id');
      }
      seenIds.add(receipt.id);
      records.push(projectRecord(receipt));
    } catch (error) {
      const unreadable = error instanceof ReceiptUnreadableError;
      diagnostics.push({
        receiptPath,
        code: unreadable ? 'receipt_unreadable' : 'invalid_receipt',
        message: unreadable
          ? 'Receipt is not valid JSON'
          : 'Receipt failed validation',
      });
    }
  }

  return { rootPath: root, records, diagnostics };
}

class ReceiptUnreadableError extends Error {}
