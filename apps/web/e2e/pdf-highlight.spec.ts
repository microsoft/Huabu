// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator } from '@playwright/test';

import {
  expectSelectionToolbarOutsideSelection,
  openNewCanvas,
} from './helpers';

import type * as CanvasModule from '../src/store/canvasStore';
import type * as ChatModule from '../src/store/chatStore';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type { ArtifactUploadResponse } from '@huabu/shared';

async function expectReadableGrip(grip: Locator) {
  const ratio = await grip.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Missing contrast measurement context');
    const luminance = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    };
    const style = getComputedStyle(element);
    const background = luminance(style.backgroundColor);
    const foreground = luminance(style.color);
    return (
      (Math.max(background, foreground) + 0.05) /
      (Math.min(background, foreground) + 0.05)
    );
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

function textPdf(height = 792) {
  const stream = `BT /F1 18 Tf 40 ${height - 92} Td (Persistent PDF highlight) Tj 0 -30 Td (Another line of selectable text) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
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
  'comment-scroll',
] as const) {
  test(
    direction === 'comment-scroll'
      ? 'PDF comments survive scrolling and the grip leaves partial-line text unobscured'
      : `PDF ${direction} highlight persists after clicking blank space and reloading`,
    async ({ page }, testInfo) => {
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
              buffer: Buffer.from(
                textPdf(direction === 'comment-scroll' ? 1600 : 792),
              ),
            },
          },
        },
      );
      expect(upload.ok(), await upload.text()).toBe(true);
      const { uri }: ArtifactUploadResponse = await upload.json();
      const created = await page.request.post(
        `/api/canvas/${canvasId}/execute`,
        {
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
        },
      );
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
      const text = reader
        .locator('.textLayer span[role="presentation"]')
        .filter({
          hasText: 'Persistent PDF highlight',
        });
      await expect(text).toBeVisible();
      const highlighter = page.getByRole('button', {
        name: 'Highlight Text',
        exact: true,
      });
      await expect(highlighter).toHaveCount(0);
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toBeHidden();
      const box = await text.boundingBox();
      if (!box) throw new Error('Missing PDF text bounds');
      const start =
        direction === 'comment-scroll'
          ? box.x + box.width * 0.4
          : direction === 'forward' || direction === 'multiline'
            ? box.x + 1
            : box.x + box.width * 0.8;
      const end =
        direction === 'forward' ||
        direction === 'multiline' ||
        direction === 'comment-scroll'
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
      await expect(page.locator('.selection-context-toolbar')).toHaveCount(0);
      await page.mouse.up();
      await expect(
        reader.locator('[data-pdf-text-selection-outline]'),
      ).toHaveCount(1);
      if (direction === 'multiline') {
        const bounds = await reader
          .locator('[data-pdf-text-selection-outline]')
          .boundingBox();
        expect(bounds?.height).toBeGreaterThan(box.height * 2);
        await page.screenshot({
          path: testInfo.outputPath('pdf-multiline-selection.png'),
          animations: 'disabled',
        });
      }
      await expect(reader.locator('[data-pdf-text-drag]')).toHaveCount(1);
      await expectSelectionToolbarOutsideSelection(page);
      await expect(reader.locator('[style*="--pdf-highlight-bg"]')).toHaveCount(
        0,
      );
      if (direction === 'comment-scroll') {
        const grip = await reader.locator('[data-pdf-text-drag]').boundingBox();
        if (!grip) throw new Error('Missing grip bounds');
        expect(grip.x + grip.width).toBeLessThanOrEqual(box.x);
        const viewport = reader.locator('[data-pdf-scroll-viewport]');
        const viewportBounds = await viewport.boundingBox();
        if (!viewportBounds) throw new Error('Missing viewport bounds');
        expect(grip.x).toBeGreaterThanOrEqual(viewportBounds.x);
        await page.screenshot({
          path: testInfo.outputPath('pdf-gutter-grip.png'),
          animations: 'disabled',
        });
        await page
          .getByRole('button', { name: 'Comment on selection', exact: true })
          .click();
        const comment = page.getByRole('textbox', {
          name: 'Comment',
          exact: true,
        });
        await comment.fill('Keep this unfinished comment');
        await viewport.evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              element.addEventListener(
                'scroll',
                () => {
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  );
                },
                { once: true },
              );
              element.scrollTop += 40;
            }),
        );
        await expect(comment).toHaveValue('Keep this unfinished comment');
        await expect(reader.locator('[data-pdf-text-drag]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(comment).toHaveCount(0);
        return;
      }
      await highlighter.click();
      await expect(
        reader.locator('[data-pdf-text-selection-outline]'),
      ).toHaveCount(0);
      await expect(highlighter).toHaveCount(0);
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
        const restored = await text.boundingBox();
        if (!restored) throw new Error('Missing restored PDF text bounds');
        await page.mouse.click(
          restored.x + restored.width * 0.3,
          restored.y + restored.height / 2,
        );
        const toolbar = page.locator('.selection-context-toolbar');
        await expect(toolbar).toBeVisible();
        const highlightBounds = await highlights.first().boundingBox();
        const toolbarBounds = await toolbar.boundingBox();
        if (!highlightBounds || !toolbarBounds)
          throw new Error('Missing restored highlight or toolbar bounds');
        expect(
          toolbarBounds.y >= highlightBounds.y + highlightBounds.height + 7 ||
            toolbarBounds.y + toolbarBounds.height <= highlightBounds.y - 7,
        ).toBe(true);
        await expect(toolbar.locator('.canvas-context-toolbar')).toHaveCount(2);
        await expect(
          toolbar.locator('.ink-agent-destination-trigger'),
        ).toHaveCount(0);
        await expect(toolbar.locator('[draggable="true"]')).toHaveCount(0);
        await expect(
          toolbar.getByRole('button', { name: 'Copy', exact: true }),
        ).toHaveCount(0);
        await expect(
          toolbar.getByRole('button', { name: 'Add as note', exact: true }),
        ).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath('pdf-selection-toolbar.png'),
        });
        const readerBounds = await reader.boundingBox();
        if (!readerBounds) throw new Error('Missing PDF reader bounds');
        expect(
          await toolbar.evaluate(
            (element, bounds) =>
              [...element.querySelectorAll('.canvas-context-toolbar')].every(
                (capsule) => {
                  const rect = capsule.getBoundingClientRect();
                  return (
                    rect.left >= bounds.x &&
                    rect.right <= bounds.x + bounds.width
                  );
                },
              ),
            readerBounds,
          ),
        ).toBe(true);
        await page.evaluate(() =>
          document.documentElement.classList.add('dark'),
        );
        await page.screenshot({
          path: testInfo.outputPath('pdf-selection-toolbar-dark.png'),
          animations: 'disabled',
        });
        await page.evaluate(() =>
          document.documentElement.classList.remove('dark'),
        );
        await text.click({ clickCount: 3 });
        expect(
          await page.evaluate(() => window.getSelection()?.toString()),
        ).toContain('Persistent');
        const grip = page.locator('[data-pdf-text-drag]');
        const outline = page
          .locator('[data-pdf-text-selection-outline]')
          .first();
        await expect(grip).toBeVisible();
        await expect(outline).toHaveCSS('pointer-events', 'none');
        await expect(outline).toHaveCSS('border-top-style', 'dashed');
        const gripBounds = await grip.boundingBox();
        const selectionBounds = await outline.boundingBox();
        if (!gripBounds || !selectionBounds)
          throw new Error('Missing selection drag bounds');
        expect(gripBounds.width).toBeCloseTo(24, 0);
        expect(gripBounds.x + gripBounds.width).toBeLessThanOrEqual(
          selectionBounds.x,
        );
        expect(gripBounds.y + gripBounds.height / 2).toBeCloseTo(
          selectionBounds.y + selectionBounds.height / 2,
          0,
        );
        const restingBorder = await outline.evaluate(
          (element) => getComputedStyle(element).borderTopColor,
        );
        await expectReadableGrip(grip);
        const restingGripBackground = await grip.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await page.screenshot({
          path: testInfo.outputPath('pdf-selection-drag-rest.png'),
          animations: 'disabled',
        });
        await grip.hover();
        await expect(grip).toHaveCSS('cursor', 'grab');
        await expect
          .poll(() =>
            grip.evaluate(
              (element) => getComputedStyle(element).backgroundColor,
            ),
          )
          .not.toBe(restingGripBackground);
        await expectReadableGrip(grip);
        expect(
          await outline.evaluate(
            (element) => getComputedStyle(element).borderTopColor,
          ),
        ).not.toBe(restingBorder);
        await page.screenshot({
          path: testInfo.outputPath('pdf-selection-drag-hover.png'),
          animations: 'disabled',
        });
        await page.mouse.move(20, 400);
        await grip.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(grip).toBeFocused();
        expect(
          await outline.evaluate(
            (element) => getComputedStyle(element).borderTopColor,
          ),
        ).not.toBe(restingBorder);
        await page.evaluate(() =>
          document.documentElement.classList.add('dark'),
        );
        await page.screenshot({
          path: testInfo.outputPath('pdf-selection-drag-dark.png'),
          animations: 'disabled',
        });
        await expectReadableGrip(grip);
        await grip.evaluate((element) => element.blur());
        await expectReadableGrip(grip);
        await page.evaluate(() =>
          document.documentElement.classList.remove('dark'),
        );
        await text.click({ clickCount: 3 });
        await page.mouse.move(
          restored.x + restored.width * 0.3,
          restored.y + restored.height / 2,
        );
        await page.mouse.down();
        await page.waitForTimeout(250); // Allow the browser's native selected-text drag delay.
        await page.mouse.move(40, 650, { steps: 15 });
        await page.mouse.up();
        const excerpt = page.locator('.react-flow__node-note');
        await expect(excerpt).toHaveCount(1);
        await expect(excerpt).toContainText('Persistent');
        expect(
          await page.evaluate(async () => {
            const path = '/src/store/canvasStore.ts';
            const { default: canvas }: typeof CanvasModule = await import(
              /* @vite-ignore */ path
            );
            return canvas.getState().nodes.find((node) => node.type === 'note')
              ?.data.origin;
          }),
        ).toEqual({ type: 'user-excerpt', excerptFromNodeId: nodeId });
        await expect(highlights).toHaveCount(1);
        await text.click({ clickCount: 3 });
        await page.mouse.move(
          restored.x + restored.width * 0.3,
          restored.y + restored.height / 2,
        );
        await page.mouse.down();
        await page.waitForTimeout(250); // Match the native selection-drag delay above.
        await page.mouse.move(40, 600, { steps: 15 });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(excerpt).toHaveCount(1);
        await expect(highlights).toHaveCount(1);
        await text.click({ clickCount: 3 });
        await expect(grip).toBeVisible();
        await grip.dragTo(page.locator('.react-flow__pane'), {
          targetPosition: { x: 810, y: 650 },
        });
        await expect(excerpt).toHaveCount(2);
        await expect(grip).toHaveCount(0);
        await expect(highlights).toHaveCount(1);
        await text.click({ clickCount: 3 });
        const cancelGrip = await grip.boundingBox();
        if (!cancelGrip) throw new Error('Missing drag handle');
        await page.mouse.move(
          cancelGrip.x + cancelGrip.width / 2,
          cancelGrip.y + cancelGrip.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(40, 600, { steps: 15 });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(excerpt).toHaveCount(2);
        await expect(grip).toHaveCount(0);
        await text.evaluate((element) => {
          const node = element.firstChild;
          if (!(node instanceof Text)) throw new Error('Missing PDF text');
          node.splitText(4);
        });
        await page.mouse.click(
          restored.x + restored.width * 0.3,
          restored.y + restored.height / 2,
        );
        await toolbar
          .getByRole('button', { name: 'Comment on selection', exact: true })
          .click();
        const addComment = page.getByRole('button', {
          name: 'Add to input',
          exact: true,
        });
        await expect(addComment).toBeDisabled();
        await page
          .getByRole('textbox', { name: 'Comment', exact: true })
          .fill('Explain the highlight');
        await page.locator('.ink-agent-destination-trigger').click();
        await page
          .getByRole('menu', { name: 'Comment destination' })
          .getByRole('menuitem', { name: 'Chat Built-In Pi', exact: true })
          .click();
        expect(
          await page.evaluate(async () => {
            const path = '/src/store/chatStore.ts';
            const { useChatStore }: typeof ChatModule = await import(
              /* @vite-ignore */ path
            );
            return Object.keys(useChatStore.getState().threadsById);
          }),
        ).toEqual([]);
        await addComment.click();
        const quoted = await page.evaluate(async () => {
          const path = '/src/store/chatStore.ts';
          const { useChatStore }: typeof ChatModule = await import(
            /* @vite-ignore */ path
          );
          return Object.values(useChatStore.getState().threadsById).flatMap(
            (thread) => thread.pendingQuotedComments,
          );
        });
        expect(quoted).toHaveLength(1);
        expect(quoted[0]).toMatchObject({
          comment: 'Explain the highlight',
          source: { kind: 'pdf', canvasId, nodeId, pages: [1] },
        });
        expect(quoted[0].quote).toContain('Persistent');
        await expect(
          page.locator('textarea[name="agent-message"]'),
        ).toBeFocused();
        const moved = await text.boundingBox();
        if (!moved) throw new Error('Missing PDF text after staging');
        await page.mouse.click(
          moved.x + moved.width * 0.3,
          moved.y + moved.height / 2,
        );
        await page
          .getByRole('button', { name: 'Remove highlight', exact: true })
          .click();
        await expect(highlights).toHaveCount(0);
      }
    },
  );
}
