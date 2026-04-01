import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { createId } from '@sediment/shared';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type { CreateSourceInput, Source, SourceOverview } from './types.js';

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
 * Title is provided externally (derived from the filename).
 */
function toSource(
  meta: Record<string, string | null>,
  content: string,
  title: string | null,
): Source {
  return {
    sourceId: meta['id'] ?? '',
    type: (meta['type'] ?? 'text') as Source['type'],
    title,
    src: meta['src'] ?? null,
    content: content,
    contentHash: meta['content_hash'] ?? '',
    metaJson: meta['meta_json'] ?? null,
  };
}

/**
 * File-based knowledge repository using Markdown with YAML frontmatter.
 *
 * Directory layout:
 *
 *   <sourcesDir>/
 *     <Title>.md   - one file per source
 *
 * The filename IS the title (without the `.md` extension).
 * Internal metadata (source_id, type, etc.) lives in YAML frontmatter.
 * Title is NOT stored in frontmatter – it is derived from the filename.
 */
export class FileKnowledgeRepository implements IKnowledgeRepository {
  private readonly sourcesDir: string;

  /**
   * In-memory index: source_id -> absolute file path.
   * Built once on construction and kept up-to-date on writes.
   */
  private sourceIndex = new Map<string, string>();

  constructor(sourcesDir: string) {
    this.sourcesDir = sourcesDir;

    // Ensure directory exists
    mkdirSync(this.sourcesDir, { recursive: true });

    // Build the source index from existing files
    this.rebuildSourceIndex();
  }

  // ==================== Internal helpers ====================

  /** Pattern matching legacy filenames that contain a sourceId suffix: `Title (src_xxx).md` */
  private static readonly LEGACY_FILENAME_RE = /^(.+)\s+\(src_[^)]+\)\.md$/;

  /**
   * Scan sources directory for .md files, build the in-memory index,
   * and migrate legacy files that still embed sourceId in the filename
   * or carry deprecated fields (`title`, `source_id`) in frontmatter.
   *
   * TODO(migration): Remove the migration blocks below once all existing
   * deployments have been upgraded. After removal, `rebuildSourceIndex()`
   * should only scan + index, without any rewrite / rename logic.
   * Removable items:
   *   - LEGACY_FILENAME_RE constant
   *   - Migration block: remove `title` from frontmatter
   *   - Migration block: rename `source_id` → `id`
   *   - Migration block: rename "Title (src_xxx).md" → "Title.md"
   */
  private rebuildSourceIndex(): void {
    this.sourceIndex.clear();
    const files = this.scanDir(this.sourcesDir);

    for (let filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { meta, content } = parseFrontmatter(raw);

        let id = meta['id'];
        if (!id) {
          // Unmanaged file: use relative path (minus extension) as ID
          const rel = path.relative(this.sourcesDir, filePath);
          id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
        }

        // ── TODO(migration): remove `title` from frontmatter ──
        let needsRewrite = false;
        if (meta['title'] !== undefined) {
          delete meta['title'];
          needsRewrite = true;
        }
        // ── TODO(migration): rename legacy "source_id" → "id" ──
        if (meta['source_id'] !== undefined) {
          if (!meta['id']) meta['id'] = meta['source_id'];
          id = meta['id'];
          delete meta['source_id'];
          needsRewrite = true;
        }

        // ── TODO(migration): rename legacy "Title (src_xxx).md" → "Title.md" ──
        const basename = path.basename(filePath);
        const legacyMatch = basename.match(
          FileKnowledgeRepository.LEGACY_FILENAME_RE,
        );
        if (legacyMatch) {
          const cleanName = `${legacyMatch[1].trim()}.md`;
          let newPath = path.join(path.dirname(filePath), cleanName);

          // Avoid collision with another file
          if (existsSync(newPath) && newPath !== filePath) {
            let n = 2;
            const stem = legacyMatch[1].trim();
            while (existsSync(newPath)) {
              newPath = path.join(path.dirname(filePath), `${stem} (${n}).md`);
              n++;
            }
          }

          if (needsRewrite) {
            // Rewrite frontmatter (without title) and rename in one go
            const fm = toFrontmatter(meta);
            writeFileSync(filePath, `${fm}\n${content}`, 'utf-8');
            needsRewrite = false;
          }

          renameSync(filePath, newPath);
          filePath = newPath;
        } else if (needsRewrite) {
          const fm = toFrontmatter(meta);
          writeFileSync(filePath, `${fm}\n${content}`, 'utf-8');
        }

        if (id) {
          this.sourceIndex.set(String(id), filePath);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  private scanDir(dir: string, fileList: string[] = []): string[] {
    if (!existsSync(dir)) return fileList;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue; // Skip hidden

        const fullPath = path.join(dir, entry);

        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          this.scanDir(fullPath, fileList);
        } else if (entry.endsWith('.md')) {
          fileList.push(fullPath);
        }
      }
    } catch {
      // ignore access errors
    }
    return fileList;
  }

  /** Characters that are invalid in most file systems. */
  private static readonly UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;

  /**
   * Build a filename for a source.
   * The filename IS the title. Falls back to 'Untitled' when no title is available.
   */
  private buildSourceFileName(sourceId: string, title?: string | null): string {
    if (title) {
      const safe = title
        .replace(FileKnowledgeRepository.UNSAFE_FILENAME_CHARS, '')
        .trim()
        .slice(0, 80);
      if (safe.length > 0) return `${safe}.md`;
    }
    return 'Untitled.md';
  }

  /**
   * Return a non-colliding filename inside sourcesDir.
   * If `name.md` already exists AND belongs to a different sourceId,
   * appends " (2)", " (3)" etc. until unique.
   */
  private deduplicateFileName(
    desiredName: string,
    ownSourceId: string,
  ): string {
    const base = desiredName.replace(/\.md$/, '');
    let candidate = desiredName;
    let n = 1;
    while (true) {
      const fullPath = path.join(this.sourcesDir, candidate);
      if (!existsSync(fullPath)) return candidate;

      // If the existing file IS this same source, no collision
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const { meta } = parseFrontmatter(raw);
        if (meta['id'] === ownSourceId) return candidate;
      } catch {
        // unreadable – treat as collision
      }

      n++;
      candidate = `${base} (${n}).md`;
    }
  }

  /**
   * Extract the title from a filename by stripping the `.md` extension.
   */
  private static extractTitleFromFilename(filePath: string): string {
    return path.basename(filePath, '.md');
  }

  private sourceFilePath(sourceId: string): string {
    // Prefer the indexed path (survives user renames)
    const indexed = this.sourceIndex.get(sourceId);
    if (indexed && existsSync(indexed)) return indexed;

    // Fallback: default name (new file or index miss)
    return path.join(this.sourcesDir, `${sourceId}.md`);
  }

  private readSource(filePath: string): Source | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, content } = parseFrontmatter(raw);

    // If id is missing, infer from filename and treat as a generic note
    if (!meta['id']) {
      const rel = path.relative(this.sourcesDir, filePath);
      const id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
      meta['id'] = id;
      if (!meta['type']) meta['type'] = 'note';
    }

    // Title is always derived from the filename
    const title = FileKnowledgeRepository.extractTitleFromFilename(filePath);

    return toSource(meta, content, title);
  }

  private readSourceOverview(filePath: string): SourceOverview | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const { meta } = parseFrontmatter(raw);

    // If id is missing, infer from filename and treat as a generic note
    if (!meta['id']) {
      const rel = path.relative(this.sourcesDir, filePath);
      const id = rel.replace(/\\/g, '/').replace(/\.md$/, '');
      meta['id'] = id;
      if (!meta['type']) meta['type'] = 'note';
    }

    // Title is always derived from the filename
    const title = FileKnowledgeRepository.extractTitleFromFilename(filePath);
    return {
      sourceId: meta['id'] ?? '',
      type: (meta['type'] ?? 'text') as Source['type'],
      title,
      src: meta['src'] ?? null,
      contentHash: meta['content_hash'] ?? '',
      metaJson: meta['meta_json'] ?? null,
    };
  }

  private writeSource(source: Source, existingFilePath?: string): void {
    // Title is NOT stored in frontmatter – it's the filename.
    const fm = toFrontmatter({
      id: source.sourceId,
      type: source.type,
      src: source.src,
      content_hash: source.contentHash,
      meta_json: source.metaJson,
    });
    const fileContent = `${fm}\n${source.content}`;

    // Determine the desired filename from the title
    const desiredName = this.deduplicateFileName(
      this.buildSourceFileName(source.sourceId, source.title),
      source.sourceId,
    );
    const desiredPath = path.join(this.sourcesDir, desiredName);

    // Resolve the current file path (if it already exists on disk)
    const currentPath =
      existingFilePath ??
      (this.sourceIndex.has(source.sourceId)
        ? this.sourceFilePath(source.sourceId)
        : null);

    if (currentPath && existsSync(currentPath)) {
      // Write content to the existing file first
      writeFileSync(currentPath, fileContent, 'utf-8');

      // If the filename should change (title changed), rename the file
      if (path.resolve(currentPath) !== path.resolve(desiredPath)) {
        renameSync(currentPath, desiredPath);
      }
    } else {
      // New file – write directly to the desired path
      writeFileSync(desiredPath, fileContent, 'utf-8');
    }

    // Keep the index up-to-date
    this.sourceIndex.set(source.sourceId, desiredPath);
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

  findSourceByHash(contentHash: string): Source | null {
    // Scan all indexed files (metadata only)
    const all = this.findAllSourcesOverview();
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

  findAllSourcesOverview(): SourceOverview[] {
    // Update index to ensure we capture new external files
    this.rebuildSourceIndex();

    const results: SourceOverview[] = [];
    for (const filePath of this.sourceIndex.values()) {
      const source = this.readSourceOverview(filePath);
      if (source) {
        results.push(source);
      }
    }
    return results;
  }

  createSource(input: CreateSourceInput): Source {
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const source: Source = {
      sourceId: input.sourceId,
      type: input.type,
      title: input.title ?? null,
      src: input.src ?? null,
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
        if (!meta['id']) {
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

  async deleteSource(sourceId: string): Promise<boolean> {
    const filePath = this.sourceIndex.get(sourceId);
    if (!filePath || !existsSync(filePath)) return false;

    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
    this.sourceIndex.delete(sourceId);
    return true;
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
