// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type { ArtifactUploadResponse } from '@huabu/shared';

function textPdf() {
  const stream =
    'BT /F1 18 Tf 40 700 Td (Persistent PDF highlight) Tj 0 -30 Td (Another line of selectable text) Tj ET';
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
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

for (const direction of [
  'forward',
  'backward',
  'multiline',
  'selection-before-tool',
  'without-random-uuid',
] as const) {
  test(`PDF ${direction} highlight persists after clicking blank space and reloading`, async ({
    page,
  }, testInfo) => {
    if (direction === 'without-random-uuid') {
      await page.addInitScript(() => {
        Object.defineProperty(globalThis.crypto, 'randomUUID', {
          value: undefined,
        });
      });
    }
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    const upload = await page.request.post(
      `/api/canvas/${canvasId}/artifact/pdf`,
      {
        multipart: {
          file: {
            name: 'highlight.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(textPdf()),
          },
        },
      },
    );
    expect(upload.ok(), await upload.text()).toBe(true);
    const { uri }: ArtifactUploadResponse = await upload.json();
    const created = await page.request.post(`/api/canvas/${canvasId}/execute`, {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'pdf',
                position: { x: 100, y: 100 },
                size: { width: 400, height: 400 },
                data: {
                  label: 'Highlight regression',
                  src: uri,
                  content: 'Persistent PDF highlight',
                },
              },
            ],
          },
        ],
        originator: { source: 'agent', threadId: 'e2e-pdf-highlight' },
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const node = page.locator('.react-flow__node-pdf');
    await expect(node).toBeVisible();
    const nodeId = await node.getAttribute('data-id');
    if (!nodeId) throw new Error('Missing PDF node ID');
    await page.evaluate(async (nodeId) => {
      const actionsPath = '/src/store/previewWorkspace/actions.ts';
      const { openPreviewNode }: typeof PreviewActions = await import(
        /* @vite-ignore */ actionsPath
      );
      openPreviewNode(nodeId);
    }, nodeId);
    const reader = page.locator('[data-pdf-reader="preview"]');
    const text = reader.locator('.textLayer span[role="presentation"]').filter({
      hasText: 'Persistent PDF highlight',
    });
    await expect(text).toBeVisible();
    const highlighter = page.getByRole('button', {
      name: 'Highlight Text',
      exact: true,
    });
    if (direction !== 'selection-before-tool') await highlighter.click();
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toBeHidden();
    const box = await text.boundingBox();
    if (!box) throw new Error('Missing PDF text bounds');
    const start =
      direction === 'forward' || direction === 'multiline'
        ? box.x + 1
        : box.x + box.width * 0.8;
    const end =
      direction === 'forward' || direction === 'multiline'
        ? box.x + box.width * 0.8
        : box.x + 1;
    await page.mouse.move(start, box.y + box.height / 2);
    await page.mouse.down();
    let endY = box.y + box.height / 2;
    if (direction === 'multiline') {
      const otherBox = await reader
        .locator('.textLayer span[role="presentation"]')
        .filter({ hasText: 'Another line' })
        .boundingBox();
      if (!otherBox) throw new Error('Missing second PDF line bounds');
      endY = otherBox.y + otherBox.height / 2;
    }
    await page.mouse.move(end, endY, { steps: 12 });
    expect(
      await page.evaluate(() => window.getSelection()?.toString()),
    ).not.toBe('');
    await page.mouse.up();
    if (direction === 'selection-before-tool') await highlighter.click();
    await expect(highlighter).toHaveAttribute('aria-pressed', 'true');
    const highlights = reader.locator(
      '[data-pdf-page-index] > div[style*="--pdf-highlight-bg"]',
    );
    await reader.click({ position: { x: 15, y: 250 } });
    expect(errors).toEqual([]);
    await expect(highlights).toHaveCount(direction === 'multiline' ? 2 : 1);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '',
    );
    await page.reload();
    await expect(highlights).toHaveCount(direction === 'multiline' ? 2 : 1);
    if (direction === 'selection-before-tool') {
      await page.screenshot({
        path: testInfo.outputPath('highlight-persisted.png'),
      });
      await highlighter.click();
      const restored = await text.boundingBox();
      if (!restored) throw new Error('Missing restored PDF text bounds');
      await page.mouse.move(
        restored.x + restored.width * 0.8,
        restored.y + restored.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(restored.x + 1, restored.y + restored.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await expect(highlights).toHaveCount(0);
    }
  });
}
