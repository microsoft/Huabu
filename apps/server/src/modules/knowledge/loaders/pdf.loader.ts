import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { IDocumentLoader, LoadResult } from './loader.interface.js';

const require = createRequire(import.meta.url);
const pdf2md = require('@opendocsg/pdf2md') as (
  pdfBuffer: Buffer,
  callbacks?: {
    metadataParsed?: (metadata: { info?: { Title?: string } }) => void;
    pageParsed?: (pages: unknown[]) => void;
    fontParsed?: (font: unknown) => void;
    documentParsed?: (document: unknown, pages: unknown[]) => void;
  },
) => Promise<string>;

export class PdfLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return sourceType === 'pdf';
  }

  async load(
    source: string | Buffer,
    _options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    try {
      let buffer: Buffer;

      if (typeof source === 'string') {
        buffer = await readFile(source);
      } else if (Buffer.isBuffer(source)) {
        buffer = source;
      } else {
        throw new Error(
          'Invalid source for PDF loader. Expected file path or Buffer.',
        );
      }

      const result = await this.parsePdfBuffer(buffer);

      if (!result.success || !result.text) {
        throw new Error(result.error || 'Failed to extract text from PDF');
      }

      return {
        content: result.text,
        title: result.title,
        metadata: {
          pageCount: result.numPages,
        },
      };
    } catch (error) {
      throw new Error(
        `PDF loading failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async parsePdfBuffer(buffer: Buffer): Promise<{
    success: boolean;
    text?: string;
    title?: string;
    numPages?: number;
    error?: string;
  }> {
    try {
      let title: string | undefined;
      let numPages: number | undefined;

      const text: string = await pdf2md(buffer, {
        metadataParsed: (metadata: { info?: { Title?: string } }) => {
          if (typeof metadata.info?.Title === 'string') {
            title = metadata.info.Title;
          }
        },
        documentParsed: (_pdfDocument: unknown, pages: unknown[]) => {
          numPages = pages.length;
        },
      });

      return {
        success: true,
        text,
        title,
        numPages,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error parsing PDF buffer',
      };
    }
  }
}
