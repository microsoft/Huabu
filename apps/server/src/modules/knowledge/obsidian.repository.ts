import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { createId } from '@sediment/shared';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type {
  CreateRevisionInput,
  CreateSourceInput,
  Source,
  SourceOverview,
  SourceRevision,
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
    } else if (value && value.startsWith('"') && value.endsWith('"')) {
      // Use JSON.parse to handle escaped characters correctly (e.g. "{\"foo\":\"bar\"}")
      try {
        value = JSON.parse(value);
      } catch {
        // Fallback if parsing fails
        value = value ? value.slice(1, -1) : '';
      }
    } else if (value && value.startsWith("'") && value.endsWith("'")) {
      // Un-quote single quotes
      value = value ? value.slice(1, -1) : '';
    }
    meta[key] = value;
  }

  let contentStart = endIdx + 4; // skip "\n---"
  // Consume the distinct newline after the closing marker so it's not part of the content.
  if (raw.slice(contentStart, contentStart + 2) === '\r\n') {
    contentStart += 2;
  } else if (raw[contentStart] === '\n') {
    contentStart += 1;
  }

  const content = raw.slice(contentStart);
  return { meta, content };
}

// ────────────────────────────────────────────────────────────────────────────
// File-based helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse frontmatter + content -> Source object.
 */
function toSource(
  meta: Record<string, string | null>,
  content: string,
): Source {
  return {
    sourceId: meta['source_id'] ?? '',
    workspaceId: meta['workspace_id'] ?? '',
    type: (meta['type'] ?? 'text') as Source['type'],
    title: meta['title'] ?? null,
    src: meta['src'] ?? null,
    createdAt: Number(meta['created_at'] ?? 0),
    updatedAt: Number(meta['updated_at'] ?? 0),
    content: content,
    contentHash: meta['content_hash'] ?? '',
    metaJson: meta['meta_json'] ?? null,
  };
}

/**
 * Build a SourceRevision from parsed frontmatter + content.
 */
function toRevisionRow(
  meta: Record<string, string | null>,
  content: string,
): SourceRevision {
  return {
    revisionId: meta['revision_id'] ?? '',
    workspaceId: meta['workspace_id'] ?? '',
    sourceId: meta['source_id'] ?? '',
    createdAt: Number(meta['created_at'] ?? 0),
    content: content,
    contentHash: meta['content_hash'] ?? '',
    metaJson: meta['meta_json'] ?? null,
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
 *         <source_id>.md          �?one file per source
 *       revisions/
 *         <source_id>/
 *           <revision_id>.md      �?one file per revision
 *
 * Each .md file uses YAML frontmatter for metadata and the body for content.
 * This makes every source browsable and editable directly in Obsidian.
 */
export class ObsidianKnowledgeRepository implements IKnowledgeRepository {
  private readonly vaultPath: string;
  private readonly sourcesDir: string;
  private readonly revisionsDir: string;

  /**
   * In-memory index: source_id �?absolute file path.
   * Built once on construction and kept up-to-date on writes.
   * This allows users to freely rename files in Obsidian without
   * breaking the link �?we always locate files by the `source_id`
   * stored in YAML frontmatter, not by filename.
   */
  private sourceIndex = new Map<string, string>();

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
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
   * Scan entire vault for .md files and build index.
   */
  private rebuildSourceIndex(): void {
    this.sourceIndex.clear();
    const files = this.scanVault(this.vaultPath);

    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { meta } = parseFrontmatter(raw);

        let id = meta['source_id'];
        if (!id) {
          // Unmanaged file: use relative path (minus extension) as ID
          const rel = path.relative(this.vaultPath, filePath);
          id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
        }

        if (id) {
          this.sourceIndex.set(String(id), filePath);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  private scanVault(dir: string, fileList: string[] = []): string[] {
    if (!existsSync(dir)) return fileList;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue; // Skip hidden

        const fullPath = path.join(dir, entry);
        if (fullPath === this.revisionsDir) continue; // Skip revisions

        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          this.scanVault(fullPath, fileList);
        } else if (entry.endsWith('.md')) {
          fileList.push(fullPath);
        }
      }
    } catch {
      // ignore access errors
    }
    return fileList;
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

  private readSource(filePath: string): Source | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, content } = parseFrontmatter(raw);

    // If source_id is missing, infer from filename and treat as a generic note
    if (!meta['source_id']) {
      const rel = path.relative(this.vaultPath, filePath);
      const id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
      meta['source_id'] = id;

      // Use filename for title if missing
      if (!meta['title']) meta['title'] = path.basename(filePath, '.md');
      if (!meta['type']) meta['type'] = 'note';
    }

    return toSource(meta, content);
  }

  private readSourceOverview(filePath: string): SourceOverview | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta } = parseFrontmatter(raw);

    // If source_id is missing, infer from filename and treat as a generic note
    if (!meta['source_id']) {
      const rel = path.relative(this.vaultPath, filePath);
      const id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
      meta['source_id'] = id;

      // Use filename for title if missing
      if (!meta['title']) meta['title'] = path.basename(filePath, '.md');
      if (!meta['type']) meta['type'] = 'note';
    }

    return {
      sourceId: meta['source_id'] ?? '',
      workspaceId: meta['workspace_id'] ?? '',
      type: (meta['type'] ?? 'text') as Source['type'],
      title: meta['title'] ?? null,
      src: meta['src'] ?? null,
      createdAt: Number(meta['created_at'] ?? 0),
      updatedAt: Number(meta['updated_at'] ?? 0),
      contentHash: meta['content_hash'] ?? '',
      metaJson: meta['meta_json'] ?? null,
    };
  }

  private writeSource(source: Source, existingFilePath?: string): void {
    const fm = toFrontmatter({
      source_id: source.sourceId,
      workspace_id: source.workspaceId,
      type: source.type,
      title: source.title,
      src: source.src,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      content_hash: source.contentHash,
      meta_json: source.metaJson,
    });
    const fileContent = `${fm}\n${source.content}`;

    // Resolve the target path:
    // 1. If specifically told to overwrite a file (renaming ID case), use that.
    // 2. Else if ID exists in index, use that.
    // 3. Else build new filename.
    let targetPath = existingFilePath;
    if (!targetPath) {
      targetPath = this.sourceIndex.has(source.sourceId)
        ? this.sourceFilePath(source.sourceId)
        : path.join(
            this.sourcesDir,
            this.buildSourceFileName(source.sourceId, source.title),
          );
    }

    writeFileSync(targetPath, fileContent, 'utf-8');

    // Keep the index up-to-date
    this.sourceIndex.set(source.sourceId, targetPath);
  }

  private readRevision(filePath: string): SourceRevision | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, content } = parseFrontmatter(raw);
    return toRevisionRow(meta, content);
  }

  private writeRevision(rev: SourceRevision): void {
    const dir = this.revisionDir(rev.sourceId);
    mkdirSync(dir, { recursive: true });

    const fm = toFrontmatter({
      revision_id: rev.revisionId,
      source_id: rev.sourceId,
      created_at: rev.createdAt,
      content_hash: rev.contentHash,
      meta_json: rev.metaJson,
    });
    const fileContent = `${fm}\n${rev.content}`;
    writeFileSync(
      this.revisionFilePath(rev.sourceId, rev.revisionId),
      fileContent,
      'utf-8',
    );
  }

  // ==================== Source Operations ====================

  findSourceById(sourceId: string): Source | null {
    // Try indexed / default path first
    const source = this.readSource(this.sourceFilePath(sourceId));
    if (source) return source;

    // Index miss �?the file may have been renamed by the user.
    // Do a full scan and rebuild the index entry.
    this.rebuildSourceIndex();
    const retryPath = this.sourceIndex.get(sourceId);
    if (retryPath) {
      return this.readSource(retryPath);
    }
    return null;
  }

  findSourceByHash(workspaceId: string, contentHash: string): Source | null {
    // Scan all indexed files (metadata only)
    const all = this.findAllSourcesOverview(workspaceId);
    const match = all.find((s) => s.contentHash === contentHash);
    if (!match) return null;
    return this.findSourceById(match.sourceId);
  }

  findAllSources(): Source[] {
    // Update index to ensure we capture new external files
    this.rebuildSourceIndex();

    const results: Source[] = [];
    for (const filePath of this.sourceIndex.values()) {
      const source = this.readSource(filePath);
      if (source) {
        results.push(source);
      }
    }
    return results;
  }

  findAllSourcesOverview(workspaceId?: string): SourceOverview[] {
    // Update index to ensure we capture new external files
    this.rebuildSourceIndex();

    const results: SourceOverview[] = [];
    for (const filePath of this.sourceIndex.values()) {
      const source = this.readSourceOverview(filePath);
      if (source) {
        // If workspaceId is specified, filter by it
        // But allow sources without workspace_id (legacy files) to match any workspace
        if (
          workspaceId &&
          source.workspaceId &&
          source.workspaceId !== workspaceId
        )
          continue;
        results.push(source);
      }
    }
    return results;
  }

  createSource(input: CreateSourceInput): Source {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const source: Source = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      type: input.type,
      title: input.title ?? null,
      src: input.src ?? null,
      createdAt: now,
      updatedAt: now,
      content: input.content ?? '',
      contentHash: input.contentHash,
      metaJson: metaJson,
    };

    this.writeSource(source);
    return source;
  }

  updateSource(
    sourceId: string,
    updates: {
      content?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): Source {
    const existing = this.findSourceById(sourceId);
    if (!existing) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    // Check if we need to promote this to a managed ID.
    // If the file exists but lacks an explicit source_id in frontmatter,
    // we should generate one now to ensure persistence.
    let finalId = existing.sourceId;
    const currentFilePath = this.sourceIndex.get(sourceId);

    // If we have a file path, check if it was inferred
    if (currentFilePath && existsSync(currentFilePath)) {
      try {
        const raw = readFileSync(currentFilePath, 'utf-8');
        const { meta } = parseFrontmatter(raw);
        if (!meta['source_id']) {
          // No explicit ID found -> this is an unmanaged file.
          // Generate a permanent ID now.
          finalId = createId('note');
        }
      } catch {
        // failed to read/parse, keep existing ID
      }
    }

    const updated: Source = {
      ...existing,
      sourceId: finalId, // Use the (potentially new) ID
      content: updates.content ?? existing.content,
      contentHash: updates.contentHash ?? existing.contentHash,
      title: updates.title ?? existing.title,
      metaJson: updates.metadata
        ? JSON.stringify(updates.metadata)
        : existing.metaJson,
      updatedAt: Date.now(),
    };

    // If we are renaming the ID (promoting), we want to overwrite the SAME file
    // with the new metadata, rather than creating a new file.
    const fileToWrite = finalId !== sourceId ? currentFilePath : undefined;

    this.writeSource(updated, fileToWrite);

    // If ID changed, clean up the old index entry (the new one is set in writeSource)
    if (finalId !== sourceId) {
      this.sourceIndex.delete(sourceId);
    }

    return updated;
  }

  // ==================== Revision Operations ====================

  findLatestRevision(sourceId: string): SourceRevision | null {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    let latest: SourceRevision | null = null;

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (rev && (!latest || rev.createdAt > latest.createdAt)) {
        latest = rev;
      }
    }
    return latest;
  }

  findRevisionById(revisionId: string): SourceRevision | null {
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
  ): SourceRevision | null {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    let match: SourceRevision | null = null;

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (
        rev &&
        rev.contentHash === contentHash &&
        (!match || rev.createdAt > match.createdAt)
      ) {
        match = rev;
      }
    }
    return match;
  }

  createRevision(input: CreateRevisionInput): SourceRevision {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const rev: SourceRevision = {
      revisionId: input.revisionId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      createdAt: now,
      content: input.content ?? '',
      contentHash: input.contentHash,
      metaJson: metaJson,
    };

    this.writeRevision(rev);
    return rev;
  }

  findRevisionsBySourceId(sourceId: string): SourceRevision[] {
    const dir = this.revisionDir(sourceId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const revisions: SourceRevision[] = [];

    for (const file of files) {
      const rev = this.readRevision(path.join(dir, file));
      if (rev) revisions.push(rev);
    }

    // Sort descending by created_at (newest first)
    return revisions.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ==================== Transaction Support ====================

  /**
   * File-based storage has no real transaction support.
   * Simply execute the function �?individual writes are atomic at OS level.
   */
  transaction<T>(fn: () => T): T {
    return fn();
  }
}
