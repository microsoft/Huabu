// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
  test(`Ink history shows one normal-color paragraph without headings in ${locale}`, async ({
    page,
  }) => {
    const text =
      locale === 'zh-CN'
        ? '比较 ChatGPT、Gemini 和 Claude 的交互 UI 功能，按手绘三列表格填写特性及一行总结，并联系 VizTA 的研究视角。'
        : 'Compare ChatGPT, Gemini and Claude interaction features using the hand-drawn table, with a one-line summary.';
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(
      async ({ locale, text }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { mountInkUserMessage } = await load(
          '/e2e/fixtures/ink-toolbar.tsx',
        );
        await mountInkUserMessage(locale, {
          state: 'reported',
          text,
          explanation:
            'This explanation remains in the record, not in the bubble.',
        });
      },
      { locale, text },
    );
    const message = page.locator('[data-chat-user-message]');
    await expect(message).toHaveText(text);
    await expect(
      message.getByRole('img', {
        name: locale === 'zh-CN' ? '笔迹请求' : 'Ink request',
      }),
    ).toBeVisible();
    const layout = await message
      .locator('[data-ink-interpretation]')
      .evaluate((summary) => {
        const paragraph = summary.parentElement;
        const bubble = paragraph?.parentElement;
        if (!paragraph || !bubble) throw new Error('Missing message paragraph');
        return {
          color: getComputedStyle(summary).color,
          bodyColor: getComputedStyle(bubble).color,
          display: getComputedStyle(summary).display,
          blockCount: bubble.children.length,
          paragraphHeight: paragraph.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(paragraph).lineHeight),
          scrollWidth: paragraph.scrollWidth,
          width: paragraph.clientWidth,
        };
      });
    expect(layout.color).toBe(layout.bodyColor);
    expect(layout.display).toBe('inline');
    expect(layout.blockCount).toBe(1);
    expect(layout.paragraphHeight).toBeGreaterThan(layout.lineHeight);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    await message.screenshot({
      path: test.info().outputPath(`ink-summary-${locale}.png`),
    });
  });
}
