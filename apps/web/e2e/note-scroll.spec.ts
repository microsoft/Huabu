// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas, readViewportTransform } from './helpers';

for (const size of [
  { width: 400, height: 200 },
  { width: 600, height: 400 },
]) {
  test(`sole-selected ${size.width}×${size.height} fixed Note scrolls without moving the canvas`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'note',
                  data: {
                    label: 'Scrollable note',
                    content:
                      'A paragraph of readable document text.\n\n'.repeat(35),
                  },
                  position: { x: 100, y: 100 },
                  size,
                },
                {
                  nodeType: 'note',
                  data: { label: 'Other note', content: 'Other document.' },
                  position: { x: 750, y: 100 },
                  size: { width: 200, height: 200 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-note-scroll' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const note = page
      .locator('.react-flow__node-note')
      .filter({ hasText: 'A paragraph' });
    const viewport = note.locator('[data-note-content-viewport]');
    await expect(note.locator('.ProseMirror')).toHaveCount(1);
    await expect(viewport).toHaveAttribute('data-note-scroll-enabled', 'false');
    await expect(viewport).toHaveCSS('scrollbar-width', 'none');
    await expect(note.getByRole('button', { name: 'Show more' })).toHaveCount(
      0,
    );
    const readDocumentGeometry = () =>
      note.locator('.ProseMirror').evaluate((el) => ({
        width: el.clientWidth,
        height: el.scrollHeight,
        paragraphs: Array.from(el.querySelectorAll('p'), (p) => p.clientHeight),
      }));
    const unselectedGeometry = await readDocumentGeometry();
    await note.click({ position: { x: 60, y: 60 } });
    await expect(viewport).toHaveAttribute('data-note-scroll-enabled', 'true');
    expect(await readDocumentGeometry()).toEqual(unselectedGeometry);
    const scrollbar = await viewport.evaluate((el) => {
      const prose = el.querySelector('.ProseMirror');
      const frame = el.closest('.huabu-note-scroll-frame');
      if (!prose || !frame)
        throw new Error('Note document or scale frame is missing');
      const rect = el.getBoundingClientRect();
      const scale = rect.width / (el as HTMLElement).offsetWidth;
      const laneLeft = rect.left + el.clientWidth * scale;
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
      return {
        width: getComputedStyle(el, '::-webkit-scrollbar').width,
        radius: thumb.borderRadius,
        color: thumb.backgroundColor,
        rightGap: frame.getBoundingClientRect().right - rect.right,
        textBeforeLane: prose.getBoundingClientRect().right <= laneLeft + 1,
      };
    });
    expect(scrollbar.width).toBe('8px');
    expect(scrollbar.radius).toBe('999px');
    expect(scrollbar.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(scrollbar.textBeforeLane).toBe(true);
    expect(Math.abs(scrollbar.rightGap)).toBeLessThanOrEqual(1);
    const before = await readViewportTransform(page);
    await viewport.hover();
    await page.mouse.wheel(0, 160);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    expect(await readViewportTransform(page)).toBe(before);
    await page.mouse.wheel(0, 100000);
    await expect(note.locator('[data-note-truncation-fade]')).toHaveCount(0);
    const bottom = await viewport.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    expect(Math.abs(bottom.top - bottom.max)).toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, 120);
    expect(await readViewportTransform(page)).toBe(before);

    // Pinch-style ctrl-wheel retains the canvas's capture-phase zoom owner.
    await viewport.dispatchEvent('wheel', {
      deltaY: -80,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await expect.poll(() => readViewportTransform(page)).not.toBe(before);

    const other = page
      .locator('.react-flow__node-note')
      .filter({ hasText: 'Other document.' });
    await other.click({ modifiers: ['Shift'], position: { x: 40, y: 40 } });
    await expect(viewport).toHaveAttribute('data-note-scroll-enabled', 'false');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await readDocumentGeometry()).toEqual(unselectedGeometry);
    await expect(note.locator('[data-note-truncation-fade]')).toHaveCount(1);
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 60, y: 500 } });
    await expect(viewport).toHaveAttribute('data-note-scroll-enabled', 'false');
    const unselectedBefore = await readViewportTransform(page);
    await viewport.hover();
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => readViewportTransform(page))
      .not.toBe(unselectedBefore);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0);
  });
}
