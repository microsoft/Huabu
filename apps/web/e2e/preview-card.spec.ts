// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

for (const nodeType of ['pdf', 'web']) {
  test(`${nodeType} Retry owns keyboard navigation and preserves native activation`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    let attempts = 0;
    await page.route('https://retry.example.test/cover.png', (route) => {
      attempts += 1;
      return route.fulfill({ status: 404, body: 'Unavailable' });
    });
    if (nodeType === 'web') {
      await page.route('**/api/web/preview**', (route) => {
        attempts += 1;
        return route.fulfill({
          status: 500,
          json: { error: 'Preview unavailable' },
        });
      });
    }
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType,
                  data: {
                    label: 'Retry keyboard regression',
                    src: 'https://retry.example.test/document',
                    coverUrl: 'https://retry.example.test/cover.png',
                  },
                  position: { x: 100, y: 100 },
                  size: { width: 400, height: 400 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-preview-retry' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const node = page.locator(`.react-flow__node-${nodeType}`);
    const retry = node.locator('.preview-card__error button');
    await expect(retry).toBeVisible();
    await node.locator('.preview-card__title').click();
    await expect(node).toHaveClass(/selected/);
    const bounds = await node.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error('Missing preview node bounds');
    const viewport = page.locator('.react-flow__viewport');
    const transform = await viewport.getAttribute('style');
    await retry.focus();
    for (const key of [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Shift+ArrowDown',
    ]) {
      await page.keyboard.press(key);
      expect(await node.boundingBox()).toEqual(bounds);
      await expect(retry).toBeFocused();
    }
    for (const key of ['Enter', 'Space']) {
      const before = attempts;
      await retry.focus();
      await page.keyboard.press(key);
      await expect.poll(() => attempts).toBe(before + 1);
      await expect(retry).toBeVisible();
      expect(await node.boundingBox()).toEqual(bounds);
      expect(await viewport.getAttribute('style')).toBe(transform);
    }
    await node.focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => (await node.boundingBox())?.y)
      .toBeGreaterThan(bounds.y);
  });
}

test('only vertical cards separate the cover and information with a full-width 1px neutral border', async ({
  page,
}) => {
  const css = await readFile(
    new URL(
      '../src/components/Nodes/previewCard/PreviewCard.css',
      import.meta.url,
    ),
    'utf8',
  );
  await page.setContent(`
    <style>${css}</style>
    <div class="preview-card" style="width: 400px; height: 400px; --edge-default: rgb(230, 230, 230)">
      <div class="preview-card__cover"></div>
      <div class="preview-card__info">Title</div>
    </div>
  `);
  const card = page.locator('.preview-card');
  const info = page.locator('.preview-card__info');
  for (const orientation of ['vertical', 'horizontal', 'text', 'vertical']) {
    await card.evaluate((element, value) => {
      (element as HTMLElement).dataset.orientation = value;
    }, orientation);
    await expect(info).toHaveCSS(
      'border-top-width',
      orientation === 'vertical' ? '1px' : '0px',
    );
    if (orientation === 'vertical') {
      await expect(info).toHaveCSS('border-top-color', 'rgb(230, 230, 230)');
      await expect(info).toHaveCSS('border-top-style', 'solid');
      const cardBounds = await card.boundingBox();
      const infoBounds = await info.boundingBox();
      expect(infoBounds?.x).toBe(cardBounds?.x);
      expect(infoBounds?.width).toBe(cardBounds?.width);
    }
    await expect(card).toHaveCSS('height', '400px');
  }
});

for (const accent of ['white', 'teal']) {
  test(`PDF divider stays inside the ${accent} border without shifting its title or badge`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    await page.route('**/divider-cover.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="white"/></svg>',
      }),
    );
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'pdf',
                  data: {
                    label: 'Divider regression',
                    src: 'https://example.com/document.pdf',
                    coverUrl: 'https://example.com/divider-cover.svg',
                    style: { accent },
                  },
                  position: { x: 100, y: 100 },
                  size: { width: 400, height: 400 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-preview-divider' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const node = page.locator('.react-flow__node-pdf');
    await expect(node.locator('.preview-card__image')).toBeVisible();
    await expect(node.locator('.semantic-lod-node')).toHaveAttribute(
      'data-lod',
      'full',
    );
    const geometry = await node.evaluate((el) => {
      const shell = el.querySelector<HTMLElement>('.semantic-lod-node');
      const content = el.querySelector<HTMLElement>('.semantic-lod-content');
      const card = el.querySelector<HTMLElement>('.preview-card');
      const info = el.querySelector<HTMLElement>('.preview-card__info');
      const title = el.querySelector<HTMLElement>('.preview-card__title');
      const badge = el.querySelector<HTMLElement>('.preview-card__cover-label');
      if (
        !shell ||
        !content ||
        !card?.parentElement ||
        !info ||
        !title ||
        !badge
      )
        throw new Error('Missing PDF node layout');
      const shellRect = shell.getBoundingClientRect();
      const scale = shellRect.width / shell.offsetWidth;
      const infoRect = info.getBoundingClientRect();
      const divider = getComputedStyle(info);
      const contentRect = content.getBoundingClientRect();
      const dividerLeft = infoRect.left;
      const dividerRight = infoRect.right;
      const cardRect = card.getBoundingClientRect();
      const cover = card.querySelector<HTMLElement>('.preview-card__cover');
      if (!cover) throw new Error('Missing cover');
      const cardStyle = getComputedStyle(card);
      const coverStyle = getComputedStyle(cover);
      const shellRadius = parseFloat(
        getComputedStyle(shell).borderTopLeftRadius,
      );
      return {
        cardRadius: parseFloat(cardStyle.borderTopLeftRadius),
        bottomRadius: parseFloat(cardStyle.borderBottomLeftRadius),
        coverRadius: parseFloat(coverStyle.borderTopLeftRadius),
        shellRadius,
        cornerHitsImage:
          card.querySelector('.preview-card__image') ===
          document.elementFromPoint(
            cardRect.left + scale,
            cardRect.top + scale,
          ),
        leftGap: (dividerLeft - shellRect.left) / scale,
        rightGap: (shellRect.right - dividerRight) / scale,
        clipLeftGap: (contentRect.left - shellRect.left) / scale,
        clipRightGap: (shellRect.right - contentRect.right) / scale,
        dividerHeight: divider.borderTopWidth,
        dividerPseudoContent: getComputedStyle(info, '::before').content,
        border: getComputedStyle(shell).borderLeftWidth,
        titleInset:
          (title.getBoundingClientRect().left - shellRect.left) / scale,
        badgeDelta:
          (badge.getBoundingClientRect().left -
            title.getBoundingClientRect().left) /
          scale,
        cardOverflow: getComputedStyle(card).overflow,
        bodyOverflow: getComputedStyle(card.parentElement).overflow,
      };
    });
    expect(geometry.leftGap).toBeCloseTo(3, 3);
    expect(geometry.rightGap).toBeCloseTo(3, 3);
    expect(geometry.clipLeftGap).toBeCloseTo(3, 3);
    expect(geometry.clipRightGap).toBeCloseTo(3, 3);
    expect(geometry.dividerHeight).toBe('1px');
    expect(geometry.dividerPseudoContent).toBe('none');
    expect(geometry.border).toBe('3px');
    expect(geometry.titleInset).toBeCloseTo(3 + 16 * (394 / 400), 1);
    expect(geometry.badgeDelta).toBeCloseTo(0, 3);
    expect(geometry.cardOverflow).toBe('hidden');
    expect(geometry.bodyOverflow).toBe('visible');
    expect(geometry.cardRadius).toBe(geometry.shellRadius - 3);
    expect(geometry.bottomRadius).toBe(geometry.cardRadius);
    expect(geometry.coverRadius).toBe(geometry.cardRadius);
    expect(geometry.cornerHitsImage).toBe(false);
  });
}

for (const nodeType of ['pdf', 'web']) {
  test(`${nodeType} reading corners remain concentric with the shell boundary`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    await page.route('https://reading.example.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body>Reading corner fixture</body></html>',
      }),
    );
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType,
                  data: {
                    label: 'Reading corners',
                    ...(nodeType === 'web'
                      ? { src: 'https://reading.example.test/' }
                      : {}),
                  },
                  position: { x: 100, y: 100 },
                  size: { width: 600, height: 400 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-reading-corners' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const shell = page.locator('.semantic-lod-node');
    await expect(shell).toHaveAttribute('data-presentation', 'reading');
    const geometry = await shell.evaluate((el) => {
      const content = el.querySelector<HTMLElement>('.semantic-lod-content');
      if (!content) throw new Error('Missing reading clip');
      const outer = el.getBoundingClientRect();
      const inner = content.getBoundingClientRect();
      const scale = outer.width / (el as HTMLElement).offsetWidth;
      const style = getComputedStyle(el);
      const clip = getComputedStyle(content);
      return {
        insets: [
          inner.left - outer.left,
          inner.top - outer.top,
          outer.right - inner.right,
          outer.bottom - inner.bottom,
        ].map((inset) => inset / scale),
        radiusDifference:
          parseFloat(style.borderTopLeftRadius) -
          parseFloat(clip.borderTopLeftRadius),
        overflow: clip.overflow,
        padding: clip.padding,
      };
    });
    for (const inset of geometry.insets) expect(inset).toBeCloseTo(3, 3);
    expect(geometry.radiusDifference).toBe(3);
    expect(geometry.overflow).toBe('hidden');
    expect(geometry.padding).toBe('0px');
  });
}

test('vertical PDF badges align with titles across all card tiers', async ({
  page,
}) => {
  const css = await readFile(
    new URL(
      '../src/components/Nodes/previewCard/PreviewCard.css',
      import.meta.url,
    ),
    'utf8',
  );
  for (const padding of [16, 24, 32]) {
    await page.setContent(`
      <style>* { box-sizing: border-box; } ${css}</style>
      <div class="preview-card" data-orientation="vertical"
        style="width: 400px; height: 400px; --card-padding: ${padding}px;
          --card-gap: ${padding / 2}px; --card-description-gap: ${padding / 4}px;
          --edge-default: rgb(230, 230, 230)">
        <div class="preview-card__cover">
          <div class="preview-card__cover-label">
            <span class="preview-card__metadata preview-card__type-label">PDF</span>
          </div>
        </div>
        <div class="preview-card__info">
          <div class="preview-card__heading">
            <h3 class="preview-card__title">Document title</h3>
          </div>
        </div>
      </div>
    `);
    const label = page.locator('.preview-card__cover-label');
    const labelBounds = await label.boundingBox();
    const titleBounds = await page
      .locator('.preview-card__title')
      .boundingBox();
    const coverBounds = await page
      .locator('.preview-card__cover')
      .boundingBox();
    expect(labelBounds).not.toBeNull();
    expect(titleBounds).not.toBeNull();
    expect(coverBounds).not.toBeNull();
    if (!labelBounds || !titleBounds || !coverBounds)
      throw new Error('Missing PDF card geometry');
    expect(labelBounds.x).toBe(titleBounds.x);
    expect(labelBounds.x - coverBounds.x).toBe(padding);
    expect(labelBounds.y - coverBounds.y).toBe(padding);
    await expect(label).toHaveCSS('pointer-events', 'none');
  }
});

test('summary CSS honors the measured line budget without expanding titles', async ({
  page,
}) => {
  const css = await readFile(
    new URL(
      '../src/components/Nodes/previewCard/PreviewCard.css',
      import.meta.url,
    ),
    'utf8',
  );
  await page.setContent(`
    <style>${css}</style>
    <div class="preview-card" data-orientation="text"
      style="width: 300px; height: 400px; --card-summary-lines: 6;
        --card-title-line: 24px; --card-description-line: 20px">
      <div class="preview-card__info">
        <h3 class="preview-card__title">${'Long document title '.repeat(20)}</h3>
        <p class="preview-card__summary">${'Detailed source summary. '.repeat(60)}</p>
      </div>
    </div>
  `);
  const summary = page.locator('.preview-card__summary');
  const title = page.locator('.preview-card__title');
  for (const orientation of ['text', 'horizontal']) {
    await page.locator('.preview-card').evaluate((card, value) => {
      (card as HTMLElement).dataset.orientation = value;
    }, orientation);
    for (const lines of [11, 6, 4, 3, 2]) {
      await page.locator('.preview-card').evaluate((card, count) => {
        (card as HTMLElement).style.setProperty(
          '--card-summary-lines',
          String(count),
        );
      }, lines);
      await expect(summary).toHaveCSS('-webkit-line-clamp', String(lines));
      await expect(summary).toHaveCSS('height', `${lines * 20}px`);
      await expect(title).toHaveCSS('-webkit-line-clamp', '2');
      await expect(title).toHaveCSS('height', '48px');
    }
  }
});
