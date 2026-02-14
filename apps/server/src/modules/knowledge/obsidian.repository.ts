import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type {
  CreateRevisionInput,
  CreateSourceInput,
  SourceRevisionRow,
  SourceRow,
} from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// YAML Frontmatter helpers (lightweight, no external dependency)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Serialise a flat record to YAML frontmatter string (no library needed).
 */
function toFrontmatter(meta: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'string') {
      // Quote strings that could be mis-interpreted
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse YAML frontmatter from a Markdown string.
 * Returns { meta, content } where content is everything after the second `---`.
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string | null>;
  content: string;
} {
  const meta: Record<string, string | null> = {};

  if (!raw.startsWith('---')) {
    return { meta, content: raw };
  }

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta, content: raw };
  }

  const yamlBlock = raw.slice(4, endIdx); // skip opening "---\n"
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | null = line.slice(colonIdx + 1).trim();
    if (value === 'null') {
      value = null;
    } else if (value.startsWith('"') && value.endsWith('"')) {
      // Use JSON.parse to handle escaped characters correctly (e.g. "{\"foo\":\"bar\"}")
      try {
        value = JSON.parse(value);
      } catch {
        // Fallback if parsing fails
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      // Un-quote single quotes
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  const content = raw.slice(endIdx + 4); // skip "\n---\n"
  return { meta, content };
}

// ────────────────────────────────────────────────────────────────────────────
// File-based helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a SourceRow from parsed frontmatter + content.
 */
function toSourceRow(
  meta: Record<string, string | null>,
  content: string,
): SourceRow {
  return {
    source_id: meta['source_id'] ?? '',
    workspace_id: meta['workspace_id'] ?? '',
    type: (meta['type'] ?? 'text') as SourceRow['type'],
    title: meta['title'] ?? null,
    uri: meta['uri'] ?? null,
    created_at: Number(meta['created_at'] ?? 0),
    updated_at: Number(meta['updated_at'] ?? 0),
    content_text: content,
    content_hash: meta['content_hash'] ?? '',
    meta_json: meta['meta_json'] ?? null,
  };
}

/**
 * Build a SourceRevisionRow from parsed frontmatter + content.
 */
function toRevisionRow(
  meta: Record<string, string | null>,
  content: string,
): SourceRevisionRow {
  return {
    revision_id: meta['revision_id'] ?? '',
    workspace_id: meta['workspace_id'] ?? '',
    source_id: meta['source_id'] ?? '',
    created_at: Number(meta['created_at'] ?? 0),
    content_text: content,
    content_hash: meta['content_hash'] ?? '',
    meta_json: meta['meta_json'] ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ObsidianKnowledgeRepository
// ────────────────────────────────────────────────────────────────────────────

/**
 * Obsidian-vault-backed knowledge repository.
 *
 * Directory layout inside the vault:
 *
 *   <vaultPath>/
 *     Sediment/
 *       sources/
 *         <source_id>.md          – one file per source
 *       revisions/
 *         <source_id>/
 *           <revision_id>.md      – one file per revision
 *
 * Each .md file uses YAML frontmatter for metadata and the body for content.
 * This makes every source browsable and editable directly in Obsidian.
 */
export class ObsidianKnowledgeRepository implements IKnowledgeRepository {
  private readonly sourcesDir: string;
  private readonly revisionsDir: string;

  /**
   * In-memory index: source_id → absolute file path.
   * Built once on construction and kept up-to-date on writes.
   * This allows users to freely rename files in Obsidian without
   * breaking the link – we always locate files by the `source_id`
   * stored in YAML frontmatter, not by filename.
   */
  private sourceIndex = new Map<string, string>();

  constructor(vaultPath: string) {
    const baseDir = path.join(vaultPath, 'Sediment');
    this.sourcesDir = path.join(baseDir, 'sources');
    this.revisionsDir = path.join(baseDir, 'revisions');

    // Ensure directories exist
    mkdirSync(this.sourcesDir, { recursive: true });
    mkdirSync(this.revisionsDir, { recursive: true });

    // Build the source index from existing files
    this.rebuildSourceIndex();
  }

  // ==================== Internal helpers ====================

  /**
   * Scan all .md files in the sources directory and build an index
   * mapping source_id (from frontmatter) → file path.
   */
  private rebuildSourceIndex(): void {
    this.sourceIndex.clear();
    if (!existsSync(this.sourcesDir)) return;

    const files = readdirSync(this.sourcesDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(this.sourcesDir, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { meta } = parseFrontmatter(raw);
        const id = meta['source_id'];
        if (id) {
          this.sourceIndex.set(id, filePath);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  /**
   * Build a human-friendly filename for a source.
   * Uses the title when available, falling back to the source_id.
   * The source_id is always appended in parentheses to guarantee uniqueness.
   */
  private buildSourceFileName(sourceId: string, title?: string | null): string {
    if (title) {
      // Sanitise: remove characters that are invalid in most file systems
      const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;
      const safe = title.replace(UNSAFE_FILENAME_CHARS, '').trim().slice(0, 80);
      if (safe.length > 0) {
        return `${safe} (${sourceId}).md`;
      }
    }
    return `${sourceId}.md`;
  }

  private sourceFilePath(sourceId: string): string {
    // Prefer the indexed path (survives user renames)
    const indexed = this.sourceIndex.get(sourceId);
    if (indexed && existsSync(indexed)) return indexed;

    // Fallback: default name (new file or index miss)
    return path.join(this.sourcesDir, `${sourceId}.md`);
  }

  private revisionDir(sourceId: string): string {
    return path.join(this.revisionsDir, sourceId);
  }

  private revisionFilePath(sourceId: string, revisionId: string): string {
    return path.join(this.revisionsDir, sourceId, `${revisionId}.md`);
  }

  private readSource(filePath: string): SourceRow | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, content } = parseFrontmatter(raw);
    return toSourceRow(meta, content);
  }

  private writeSource(source: SourceRow): void {
    const fm = toFrontmatter({
      source_id: source.source_id,
      workspace_id: source.workspace_id,
      type: source.type,
      title: source.title,
      uri: source.uri,
      created_at: source.created_at,
      updated_at: source.updated_at,
      content_hash: source.content_hash,
      meta_json: source.meta_json,
    });
    const fileContent = `${fm}\n${source.content_text}`;

    // Resolve the target path: reuse the existing file (possibly renamed)
    // or create a new one with a human-friendly name.
    const targetPath = this.sourceIndex.has(source.source_id)
      ? this.sourceFilePath(source.source_id)
      : path.join(
          this.sourcesDir,
          this.buildSourceFileName(source.source_id, source.title),
        );

    writeFileSync(targetPath, fileContent, 'utf-8');

    // Keep the index up-to-date
    this.sourceIndex.set(source.source_id, targetPath);
  }

  private readRevision(filePath: string): SourceRevisionRow | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, content } = parseFrontmatter(raw);
    return toRevisionRow(meta, content);
  }

  private writeRevision(rev: SourceRevisionRow): void {
    const dir = this.revisionDir(rev.source_id);
    mkdirSync(dir, { recursive: true });

    const fm = toFrontmatter({
      revision_id: rev.revision_id,
      workspace_id: rev.workspace_id,
      source_id: rev.source_id,
      created_at: rev.created_at,
      content_hash: rev.content_hash,
      meta_json: rev.meta_json,
    });
    const fileContent = `${fm}\n${rev.content_text}`;
    writeFileSync(
      this.revisionFilePath(rev.source_id, rev.revision_id),
      fileContent,
      'utf-8',
    );
  }

  // ==================== Source Operations ====================

  findSourceById(sourceId: string): SourceRow | null {
    // Try indexed / default path first
    const source = this.readSource(this.sourceFilePath(sourceId));
    if (source) return source;

    // Index miss – the file may have been renamed by the user.
    // Do a full scan and rebuild the index entry.
    this.rebuildSourceIndex();
    const retryPath = this.sourceIndex.get(sourceId);
    if (retryPath) {
      return this.readSource(retryPath);
    }
    return null;
  }

  findSourceByHash(workspaceId: string, contentHash: string): SourceRow | null {
    // Scan all source files (linear search – acceptable for vault-scale data)
    if (!existsSync(this.sourcesDir)) return null;
    const files = readdirSync(this.sourcesDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const source = this.readSource(path.join(this.sourcesDir, file));
      if (
        source &&
        source.workspace_id === workspaceId &&
        source.content_hash === contentHash
      ) {
        return source;
      }
    }
    return null;
  }

  createSource(input: CreateSourceInput): SourceRow {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const source: SourceRow = {
      source_id: input.sourceId,
      workspace_id: input.workspaceId,
      type: input.type,
      title: input.title ?? null,
      uri: input.uri ?? null,
      created_at: now,
      updated_at: now,
      content_text: input.contentText ?? '',
      content_hash: input.contentHash,
      meta_json: metaJson,
    };

    this.writeSource(source);
    return source;
  }

  updateSource(
    sourceId: string,
    updates: {
      contentText?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): SourceRow {
    const existing = this.findSourceById(sourceId);
    if (!existing) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    const updated: SourceRow = {
      ...existing,
      content_text: updates.contentText ?? existing.content_text,
      content_hash: updates.contentHash ?? existing.content_hash,
      title: updates.title ?? existing.title,
      meta_json: updates.metadata
        ? JSON.stringify(updates.metadata)
        : existing.meta_json,
      updated_at: Date.now(),
    };

    this.writeSource(updated);
    return updated;
  }

  // ==================== Revision Operations ====================

  findLatestRevision(sourceId: string): SourceRevisionRow | null {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    let latest: SourceRevisionRow | null = null;

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (rev && (!latest || rev.created_at > latest.created_at)) {
        latest = rev;
      }
    }
    return latest;
  }

  findRevisionById(revisionId: string): SourceRevisionRow | null {
    // We need to search across all source revision directories
    if (!existsSync(this.revisionsDir)) return null;

    const sourceDirs = readdirSync(this.revisionsDir, {
      withFileTypes: true,
    }).filter((d) => d.isDirectory());

    for (const dir of sourceDirs) {
      const filePath = path.join(
        this.revisionsDir,
        dir.name,
        `${revisionId}.md`,
      );
      const rev = this.readRevision(filePath);
      if (rev) return rev;
    }
    return null;
  }

  findRevisionByHash(
    sourceId: string,
    contentHash: string,
  ): SourceRevisionRow | null {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    let match: SourceRevisionRow | null = null;

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (
        rev &&
        rev.content_hash === contentHash &&
        (!match || rev.created_at > match.created_at)
      ) {
        match = rev;
      }
    }
    return match;
  }

  createRevision(input: CreateRevisionInput): SourceRevisionRow {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const rev: SourceRevisionRow = {
      revision_id: input.revisionId,
      workspace_id: input.workspaceId,
      source_id: input.sourceId,
      created_at: now,
      content_text: input.contentText ?? '',
      content_hash: input.contentHash,
      meta_json: metaJson,
    };

    this.writeRevision(rev);
    return rev;
  }

  findRevisionsBySourceId(sourceId: string): SourceRevisionRow[] {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const revisions: SourceRevisionRow[] = [];

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (rev) revisions.push(rev);
    }

    // Sort descending by created_at (newest first)
    return revisions.sort((a, b) => b.created_at - a.created_at);
  }

  // ==================== Transaction Support ====================

  /**
   * File-based storage has no real transaction support.
   * Simply execute the function – individual writes are atomic at OS level.
   */
  transaction<T>(fn: () => T): T {
    return fn();
  }
}
