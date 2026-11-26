// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Every preprocessed node type, end to end, as the server starts it: a node
 * is created by an Agent's batch with no page open, through the real
 * executor, job and pipeline on a Disk Space, with real documents. Only the
 * model is replaced, by fixed answers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ZipArchive } from 'archiver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/functional-text.js', () => ({ runFunctionalText: vi.fn() }));

import {
  preprocessAfterWrites,
  waitForNodePreprocessing,
} from './node-jobs.js';
import { runFunctionalText } from '../agent/functional-text.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { setCommitReactions } from '../canvas/commit-follow-up.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { getCanvasStore, resetStorageCache, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand, CanvasSyncEvent } from '@huabu/shared';

const CANVAS = 'types';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A one-page PDF with a text layer. */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(
    `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

/** A Word document with one paragraph. */
async function docx(text: string): Promise<Buffer> {
  const zip = new ZipArchive();
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    out.on('end', resolve);
    zip.on('error', reject);
  });
  zip.pipe(out);
  zip.append(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    { name: '[Content_Types].xml' },
  );
  zip.append(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    { name: '_rels/.rels' },
  );
  zip.append(
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    { name: 'word/document.xml' },
  );
  await zip.finalize();
  await done;
  return Buffer.concat(chunks);
}

let tmp: string;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-jobs-types-'));
  vi.stubEnv('HUABU_DATA_DIR', tmp);
  setWorkspacePath(tmp);
  createCanvas(CANVAS);
  events = [];
  unsubscribe = subscribeCanvasUpdates(CANVAS, (event) => events.push(event));
  // The model: metadata as JSON when asked about a document's text, a
  // short title otherwise (an image, a Frame).
  vi.mocked(runFunctionalText).mockImplementation(async (prompt) =>
    /respond with a JSON object/.test(String(prompt))
      ? JSON.stringify({
          label: 'Title from the model',
          summary: 'Summary from the model',
          keywords: ['first', 'second'],
        })
      : 'Short title from the model',
  );
  setCommitReactions(preprocessAfterWrites);
});

afterEach(async () => {
  await waitForNodePreprocessing();
  setCommitReactions(undefined);
  unsubscribe();
  vi.mocked(runFunctionalText).mockReset();
  vi.unstubAllEnvs();
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** An Agent creates one node; nobody has the Space open. */
async function create(
  id: string,
  nodeType: string,
  data: Record<string, unknown>,
  parentId?: string,
) {
  const out = await executeOnServer({
    canvasId: CANVAS,
    originator: { source: 'agent' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id,
            nodeType,
            ...(parentId ? { parentId } : {}),
            position: { x: 0, y: 0 },
            size: { width: 400, height: 300 },
            data,
          },
        ],
      },
    ] as CanvasCommand[],
  });
  expect(out.results[0], JSON.stringify(out.results[0])).toMatchObject({
    applied: true,
  });
  await waitForNodePreprocessing();
  return getCanvasStore(CANVAS).readNode(id) as Record<string, unknown>;
}
const statuses = (id: string) =>
  events.flatMap((event) =>
    event.type === 'preprocess' && event.data.nodeId === id
      ? [event.data.status]
      : [],
  );

describe('each node type is preprocessed by the server after it is created', () => {
  it('note: titled from its first heading', async () => {
    const record = await create('node-note', 'note', {
      content: '# Heading of the note\n\nBody',
    });
    expect(record).toMatchObject({
      label: 'Heading of the note',
      labelSource: 'auto',
    });
    expect(statuses('node-note')).toEqual(['pending', 'done']);
  });

  it('text: titled from its first line', async () => {
    const record = await create('node-text', 'text', {
      content: 'First line of the text\nSecond line',
    });
    // The title a text node is created with is already its first line, so
    // the run has nothing to change: it is not claimed for a person.
    expect(record).toMatchObject({ label: 'First line of the text' });
    expect(record.labelSource ?? 'auto').toBe('auto');
    expect(statuses('node-text')).toEqual(['pending', 'done']);
  });

  it('pdf: text extracted from the file and stored, and titled', async () => {
    await space(CANVAS).artifacts.put(
      'paper.pdf',
      textPdf('Text inside the PDF'),
    );
    const record = await create('node-pdf', 'pdf', { src: 'paper.pdf' });
    expect(record.content).toContain('Text inside the PDF');
    expect(record).toMatchObject({
      label: 'Title from the model',
      labelSource: 'auto',
    });
    expect(statuses('node-pdf')).toEqual(['pending', 'done']);
  });

  it('office: text extracted, with a summary and keywords', async () => {
    await space(CANVAS).artifacts.put(
      'report.docx',
      await docx('Text inside the Word document'),
    );
    const record = await create('node-office', 'office', {
      src: 'report.docx',
      format: 'docx',
    });
    expect(record.content).toContain('Text inside the Word document');
    expect(record).toMatchObject({
      summary: 'Summary from the model',
      keywords: ['first', 'second'],
    });
    expect(statuses('node-office')).toEqual(['pending', 'done']);
  });

  it('web: a saved page is read, with a summary and keywords', async () => {
    await space(CANVAS).artifacts.put(
      'page.html',
      Buffer.from(
        '<html><head><title>Saved page</title></head><body><article><h1>Saved page</h1><p>Text inside the saved web page, long enough to be taken for the article of the page rather than for chrome around it.</p></article></body></html>',
      ),
    );
    const record = await create('node-web', 'web', { src: 'page.html' });
    expect(record.content).toContain('Text inside the saved web page');
    expect(record).toMatchObject({
      summary: 'Summary from the model',
      keywords: ['first', 'second'],
    });
    expect(statuses('node-web')).toEqual(['pending', 'done']);
  });

  it('image: titled by the model from the picture', async () => {
    await space(CANVAS).artifacts.put('picture.png', TINY_PNG);
    const record = await create('node-image', 'image', {
      src: 'picture.png',
    });
    expect(record).toMatchObject({
      label: 'Short title from the model',
      labelSource: 'auto',
    });
    expect(statuses('node-image')).toEqual(['pending', 'done']);
  });

  it('frame: titled by the model from its children’s titles', async () => {
    await create('node-frame', 'frame', {});
    await create(
      'node-child',
      'note',
      { label: 'A child', labelSource: 'agent' },
      'node-frame',
    );
    expect(getCanvasStore(CANVAS).readNode('node-frame')).toMatchObject({
      label: 'Short title from the model',
      labelSource: 'auto',
    });
    expect(statuses('node-frame').slice(-2)).toEqual(['pending', 'done']);
  });
});
