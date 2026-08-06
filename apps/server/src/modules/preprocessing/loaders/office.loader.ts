// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile } from 'node:fs/promises';

import { OfficeParser, type SupportedFileType } from 'officeparser';

import { stripOfficeparserPreamble } from './office-strip.js';

import type { IDocumentLoader, LoadResult } from './loader.interface.js';

/**
 * File-type hints accepted by the office loader. Mirrors `OfficeFormat`
 * in `@huabu/shared` plus the `'office'` umbrella alias used by the
 * extract stage when a specific format has not been resolved yet.
 */
const OFFICE_SOURCE_TYPES = new Set<string>(['office', 'docx', 'pptx', 'xlsx']);

/**
 * Map an `OfficeFormat` (or generic `'office'`) onto the `fileType`
 * hint that `officeparser` requires when parsing from a buffer (some
 * formats lack magic bytes).
 */
function toOfficeFileType(sourceType: string): SupportedFileType | undefined {
  if (sourceType === 'docx') return 'docx';
  if (sourceType === 'pptx') return 'pptx';
  if (sourceType === 'xlsx') return 'xlsx';
  return undefined;
}

/**
 * Loads a Word / PowerPoint / Excel document and converts it to
 * Markdown via `officeparser`. The Markdown body is persisted into the
 * per-node `.md` sidecar so the canvas preview can render it without
 * re-parsing the original file on every read.
 *
 * `officeparser` ignores embedded images / charts unless
 * `extractAttachments` is set; we deliberately leave that off so the
 * extracted body stays small (preview is text-only by design).
 */
export class OfficeLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return OFFICE_SOURCE_TYPES.has(sourceType);
  }

  async load(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    const buffer = await this.toBuffer(source);
    const fileType = this.resolveFileType(source, options);

    const ast = await OfficeParser.parseOffice(buffer, {
      ignoreNotes: false,
      ignoreComments: true,
      ...(fileType ? { fileType } : {}),
    });

    // Generate Markdown from the AST. `OfficeConverter.convert` would
    // re-parse the buffer; reusing the already-parsed AST is cheaper.
    const { value: markdown } = await ast.to('md');
    const raw =
      typeof markdown === 'string' ? markdown : String(markdown ?? '');
    const content = stripOfficeparserPreamble(raw);

    const metadata = ast.metadata ?? {};
    const title =
      typeof metadata.title === 'string' && metadata.title.trim().length > 0
        ? metadata.title.trim()
        : undefined;

    return {
      content,
      title,
      metadata: {
        author: metadata.author,
        keywords: metadata.keywords,
        created: metadata.created,
        modified: metadata.modified,
        format: ast.type,
      },
    };
  }

  private async toBuffer(source: string | Buffer): Promise<Buffer> {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === 'string') return readFile(source);
    throw new Error(
      'Invalid source for Office loader. Expected file path or Buffer.',
    );
  }

  private resolveFileType(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): SupportedFileType | undefined {
    const fromOptions = options?.['fileType'];
    if (typeof fromOptions === 'string') {
      const mapped = toOfficeFileType(fromOptions);
      if (mapped) return mapped;
    }
    if (typeof source === 'string') {
      const ext = source.slice(source.lastIndexOf('.') + 1).toLowerCase();
      const mapped = toOfficeFileType(ext);
      if (mapped) return mapped;
    }
    return undefined;
  }
}
