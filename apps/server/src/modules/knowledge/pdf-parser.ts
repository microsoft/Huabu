import { readFile } from 'node:fs/promises';

import * as pdf from 'pdf-parse';

/**
 * Result of PDF parsing operation
 */
export interface ParsePdfResult {
  success: boolean;
  text?: string;
  title?: string;
  numPages?: number;
  error?: string;
}

/**
 * Parse PDF file and extract text content
 *
 * Uses pdf-parse library for text extraction
 * Handles common PDF formats (text-based PDFs)
 * May not work well with scanned PDFs or complex layouts
 *
 * @param filePath - Absolute path to PDF file
 * @returns Parsing result with extracted text
 */
export async function parsePdfFile(filePath: string): Promise<ParsePdfResult> {
  try {
    // Read PDF file as buffer
    const dataBuffer = await readFile(filePath);

    // Parse PDF using pdf-parse
    const data = await pdf(dataBuffer);

    return {
      success: true,
      text: data.text,
      title: data.info?.Title || undefined,
      numPages: data.numpages,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error parsing PDF file',
    };
  }
}

/**
 * Parse PDF from buffer (useful when file is already in memory)
 *
 * @param buffer - PDF file buffer
 * @returns Parsing result with extracted text
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<ParsePdfResult> {
  try {
    const data = await pdf(buffer);

    return {
      success: true,
      text: data.text,
      title: data.info?.Title || undefined,
      numPages: data.numpages,
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
