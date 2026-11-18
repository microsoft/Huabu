// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { openNewCanvas, editsPerCommand } from './helpers';

import type {
  ArtifactUploadResponse,
  CreateCanvasResponse,
} from '@huabu/shared';

/**
 * Select all, cut, undo, and the Preview panel's per-Space state, driven
 * through the real keyboard, clipboard and server.
 */

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    localStorage.setItem('huabu.language', 'en');
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({
        state: { inputModePreference: 'mouse' },
        version: 0,
      }),
    );
  });
});

async function createSpace(page: Page, title: string) {
  const response = await page.request.post('/api/canvas', { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as CreateCanvasResponse).canvasId;
}

async function execute(page: Page, canvasId: string, commands: unknown[]) {
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      edits: editsPerCommand(commands),
      originator: { source: 'agent', threadId: 'e2e-select-all-cut' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as {
    edits: { results: { nodes?: { nodeId: string }[] }[] }[];
  };
}

function textPdf() {
  const stream = 'BT /F1 18 Tf 40 700 Td (Extracted body survives undo) Tj ET';
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

test('select all, cut, paste and undo act on whole nodes', async ({ page }) => {
  const canvasId = await createSpace(page, 'Select all and cut');
  await execute(page, canvasId, [
    {
      type: 'CREATE_NODES',
      nodes: ['One', 'Two', 'Three'].map((content, index) => ({
        nodeType: 'text',
        data: { content },
        position: { x: 80 + index * 260, y: 160 },
      })),
    },
  ]);
  await page.goto(`/canvas/${canvasId}`);
  const nodes = page.locator('.react-flow__node-text');
  await expect(nodes).toHaveCount(3);
  const toasts = page.locator('[role="status"]:not([id^="DndLiveRegion"])');

  // Nothing selected, focus on the Space itself.
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 20, y: 500 } });
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.react-flow__node-text.selected')).toHaveCount(3);

  // Cutting everything removes it, with no "selection changed" refusal.
  await page.keyboard.press('ControlOrMeta+x');
  await expect(nodes).toHaveCount(0);
  await expect(toasts).toHaveCount(0);

  // One undo brings all three back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(nodes).toHaveCount(3);

  // Cut one, then paste it back from the real clipboard.
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 20, y: 500 } });
  await nodes.filter({ hasText: 'Two' }).click();
  await expect(page.locator('.react-flow__node-text.selected')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+x');
  await expect(nodes).toHaveCount(2);
  await expect(nodes.filter({ hasText: 'Two' })).toHaveCount(0);
  await page.mouse.move(400, 520);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(3);
  await expect(nodes.filter({ hasText: 'Two' })).toHaveCount(1);
  await expect(toasts).toHaveCount(0);

  // The result is what the server holds, not only what the page shows.
  await page.reload();
  await expect(nodes).toHaveCount(3);
});

test('a cut PDF comes back on undo with its file and its extracted text', async ({
  page,
}) => {
  const canvasId = await createSpace(page, 'PDF undo');
  const upload = await page.request.post(
    `/api/canvas/${canvasId}/artifact/pdf`,
    {
      multipart: {
        file: {
          name: 'undo.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(textPdf()),
        },
      },
    },
  );
  expect(upload.ok(), await upload.text()).toBe(true);
  const { uri }: ArtifactUploadResponse = await upload.json();
  const created = await execute(page, canvasId, [
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          nodeType: 'pdf',
          position: { x: 100, y: 100 },
          size: { width: 400, height: 400 },
          // Stands in for text extracted when the PDF was first added.
          data: { label: 'Undo paper', src: uri, content: 'Seeded body' },
        },
      ],
    },
  ]);
  const nodeId = created.edits[0]?.results[0]?.nodes?.[0]?.nodeId;
  expect(nodeId).toBeTruthy();
  const body = async () => {
    const response = await page.request.get(
      `/api/canvas/${canvasId}/nodes/${nodeId}/content`,
    );
    return response.ok()
      ? (((await response.json()) as { content?: string }).content ?? '')
      : '';
  };

  await page.goto(`/canvas/${canvasId}`);
  const node = page.locator('.react-flow__node-pdf');
  await expect(node).toBeVisible();
  await expect.poll(body).toBe('Seeded body');

  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 20, y: 700 } });
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.react-flow__node-pdf.selected')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+x');
  await expect(node).toHaveCount(0);
  // Deleting the node deleted its sidecar, text included.
  await expect.poll(body, { timeout: 10_000 }).toBe('');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(node).toBeVisible();
  await expect(page.locator('.missing-file-banner')).toHaveCount(0);
  // The web never held the body, so it cannot write it back. What returns
  // is text the server extracted again from the PDF file itself.
  await expect.poll(body, { timeout: 20_000 }).toContain('Extracted body');

  await page.reload();
  await expect(node).toBeVisible();
  await expect(page.locator('.missing-file-banner')).toHaveCount(0);
});

test('a new Space starts with Preview closed and each Space remembers its own', async ({
  page,
}) => {
  // The device last had Preview open, as after working in another Space.
  await page.addInitScript(() => {
    if (localStorage.getItem('huabu-panel') === null)
      localStorage.setItem(
        'huabu-panel',
        JSON.stringify({ state: { isRightCollapsed: false }, version: 0 }),
      );
  });
  const panel = page.locator('[data-canvas-panel="right"]');
  const tabs = panel.getByRole('tab');
  const expand = page.getByRole('button', {
    name: 'Expand previews',
    exact: true,
  });

  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const first = page.url();
  await expect(panel).toBeHidden();
  await expect(expand).toBeVisible();

  // Opening it shows an empty panel, not a Chat nobody asked for.
  await expand.click();
  await expect(panel).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await expect(panel).toContainText('No preview open in this group');

  // A second new Space is closed again, even though the first is open.
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  expect(page.url()).not.toBe(first);
  await expect(panel).toBeHidden();

  // The first Space is as it was left, through navigation and a reload.
  await page.goto(first);
  await expect(panel).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await page.reload();
  await expect(panel).toBeVisible();
});
