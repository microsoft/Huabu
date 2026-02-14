import { readFile } from 'node:fs/promises';

import { PDFParse } from 'pdf-parse';

import type { IDocumentLoader, LoadResult } from './loader.interface.js';

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
          // ... other numeric metadata if needed
        },
      };
    } catch (error) {
      throw new Error(
        `PDF loading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Copied/Refactored from pdf-parser.ts
  private async parsePdfBuffer(buffer: Buffer): Promise<{
    success: boolean;
    text?: string;
    title?: string;
    numPages?: number;
    error?: string;
  }> {
    const parser = new PDFParse({
      data: buffer,
    });

    try {
      // Avoid parallel calls that can trigger data transfer/worker issues.
      const infoResult = await parser.getInfo();
      const textResult = await parser.getText();

      return {
        success: true,
        text: textResult.text,
        title:
          typeof infoResult.info?.Title === 'string'
            ? infoResult.info.Title
            : undefined,
        numPages: infoResult.total,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error parsing PDF buffer',
      };
    } finally {
      try {
        await parser.destroy();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
