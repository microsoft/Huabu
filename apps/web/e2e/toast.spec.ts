// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test.use({ hasTouch: false });

for (const theme of ['light', 'dark']) {
  for (const width of [320, 1100]) {
    test(`toast overflow remains operable at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 480 });
      await page.goto('/playground/components');
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);

      const entries = page.locator('body > div.fixed [role="status"]');
      await page
        .getByRole('button', { name: 'Stack 12 errors', exact: true })
        .click();
      await expect(entries).toHaveCount(12);
      await expect(entries.first()).toHaveCSS('opacity', '1');
      expect(
        await entries.first().evaluate((element) => {
          const stack = element.parentElement;
          if (!stack) throw new Error('Missing toast stack');
          const bounds = stack.getBoundingClientRect();
          return (
            element.getBoundingClientRect().top === 24 &&
            bounds.bottom <= innerHeight - 16 &&
            stack.scrollHeight > stack.clientHeight
          );
        }),
      ).toBe(true);

      await entries.first().getByRole('button', { name: 'Dismiss' }).focus();
      for (let index = 0; index < 11; index++) await page.keyboard.press('Tab');
      const lastClose = entries.last().getByRole('button', { name: 'Dismiss' });
      await expect(lastClose).toBeFocused();
      await expect(lastClose).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: test.info().outputPath(`stack-${theme}-${width}.png`),
      });
      await lastClose.press('Enter');
      await expect(entries).toHaveCount(11);

      await page.reload();
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);
      await page
        .getByRole('button', { name: 'Long error details', exact: true })
        .click();
      await expect(entries).toHaveCount(1);
      await expect(entries).toHaveCSS('opacity', '1');
      expect(
        await entries.evaluate((element) => {
          const stack = element.parentElement;
          if (!stack) throw new Error('Missing toast stack');
          return (
            element.getBoundingClientRect().height > stack.clientHeight &&
            stack.scrollWidth === stack.clientWidth &&
            element.textContent?.includes('Unable to save this note.')
          );
        }),
      ).toBe(true);
      await entries.hover({ position: { x: 40, y: 40 } });
      await page.mouse.wheel(0, 10000);
      const retry = entries.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeInViewport({ ratio: 1 });
      await retry.focus();
      await page.screenshot({
        path: test.info().outputPath(`long-${theme}-${width}.png`),
      });
      await retry.press('Enter');
      await expect(entries).toHaveText('Retry requested (demo)');
    });
  }
}
