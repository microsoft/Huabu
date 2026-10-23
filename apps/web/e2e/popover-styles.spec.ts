// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test.use({ hasTouch: false });

for (const width of [320, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`popover surfaces and custom controls at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/playground/node-toolbars');
      await expect(page.locator('.nt-toolbar')).toHaveCount(12);
      await page.evaluate(async (theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { mountPopoverStylesFixture } = await load(
          '/e2e/fixtures/popover-styles.tsx',
        );
        mountPopoverStylesFixture();
      }, theme);
      const command = page.getByRole('option', { name: /\/review/ });
      await expect(command).toBeVisible();
      const commandPanel = page.getByRole('listbox');
      await expect(commandPanel).toHaveCSS('padding', '4px');
      await expect(commandPanel).toHaveCSS('border-radius', '8px');
      await expect(command).toHaveCSS('border-radius', '6px');
      await expect(command).toHaveCSS('padding', '4px 8px');
      await expect(command.getByText('/review', { exact: true })).toHaveCSS(
        'font-size',
        '12px',
      );
      const input = page.getByRole('textbox', { name: 'Command input' });
      await input.focus();
      await input.press('ArrowDown');
      await expect(
        page.getByRole('option', { name: /\/explain/ }),
      ).toHaveAttribute('aria-selected', 'true');
      await command.click();
      await expect(input).toBeFocused();
      await expect(page.locator('[data-popover-result]')).toHaveText('review');
      await commandPanel.screenshot({
        path: test.info().outputPath('command-menu.png'),
        animations: 'disabled',
      });

      await page
        .locator('[data-agent-sample]')
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      const reviewer = page.getByRole('menuitem', { name: 'Reviewer' });
      await expect(reviewer).toHaveCSS('font-size', '13px');
      await expect(reviewer).toHaveCSS('height', '28px');
      await expect(reviewer).toHaveCSS('padding', '4px 8px');
      const panel = reviewer.locator(
        'xpath=ancestor::*[@data-floating-chrome][1]',
      );
      await expect(panel).toHaveCSS('padding', '4px');
      await expect(panel).toHaveCSS('border-radius', '8px');
      await expect(panel).toHaveCSS('overflow-y', 'auto');
      const externalHeading = panel.getByText('External Agents', {
        exact: true,
      });
      await expect(externalHeading).toHaveCSS('font-size', '12px');
      await expect(externalHeading).toHaveCSS('font-weight', '400');
      await expect(externalHeading.locator('..')).toHaveCSS(
        'margin-top',
        '16px',
      );
      await expect(externalHeading.locator('..')).toHaveCSS(
        'border-top-width',
        '0px',
      );
      await expect(panel.getByRole('separator')).toHaveCount(1);
      await expect(reviewer).toHaveCSS('font-weight', '400');
      expect(
        await reviewer.evaluate((el) => getComputedStyle(el).color),
      ).not.toBe(
        await externalHeading.evaluate((el) => getComputedStyle(el).color),
      );
      const hint = panel.getByText('Built-In Pi', { exact: true }).first();
      await expect(hint).toHaveCSS('font-size', '12px');
      expect(await hint.evaluate((el) => getComputedStyle(el).color)).toBe(
        await externalHeading.evaluate((el) => getComputedStyle(el).color),
      );
      const insets = await reviewer.evaluate((row) => {
        const parent = row.closest('[data-floating-chrome]');
        if (!parent) throw new Error('Missing Agent menu panel');
        const outer = parent.getBoundingClientRect();
        const inner = row.getBoundingClientRect();
        return {
          left: inner.left - outer.left,
          right: outer.right - inner.right,
          inside: outer.left >= 0 && outer.right <= window.innerWidth,
          fits: [...parent.querySelectorAll('[role="menuitem"]')].every(
            (item) => item.scrollWidth <= item.clientWidth,
          ),
        };
      });
      expect(insets).toEqual({ left: 5, right: 5, inside: true, fits: true });
      const labelContrast = await panel.evaluate((element) => {
        const label = element.querySelector('[role="presentation"]');
        const context = document.createElement('canvas').getContext('2d', {
          willReadFrequently: true,
        });
        if (!label || !context) throw new Error('Missing contrast sample');
        const luminance = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const rgb = context.getImageData(0, 0, 1, 1).data;
          return [0.2126, 0.7152, 0.0722].reduce((total, weight, i) => {
            const channel = rgb[i] / 255;
            return (
              total +
              weight *
                (channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        };
        const foreground = luminance(getComputedStyle(label).color);
        const background = luminance(getComputedStyle(element).backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
      expect(labelContrast).toBeGreaterThanOrEqual(4.5);
      await reviewer.hover();
      await expect(reviewer).not.toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await panel.screenshot({
        path: test.info().outputPath('agent-menu.png'),
        animations: 'disabled',
      });
      await reviewer.click();
      await expect(page.locator('[data-agent-sample]')).toHaveText('Reviewer');
      await expect(reviewer).toHaveCount(0);

      await page.locator('[data-icon-sample] button').click();
      const iconPanel = page.getByRole('dialog');
      const cloud = iconPanel.getByRole('button', {
        name: 'Cloud',
        exact: true,
      });
      await expect(iconPanel).toHaveCSS('padding', '8px');
      await expect(cloud).toHaveCSS('width', '32px');
      await expect(cloud).toHaveCSS('height', '32px');
      await expect(cloud.locator('svg')).toHaveCSS('width', '20px');
      await cloud.click();
      await expect(cloud).toHaveAttribute('aria-pressed', 'true');
      const red = iconPanel.getByRole('button', { name: 'Red', exact: true });
      await red.click();
      await expect(red).toHaveAttribute('aria-pressed', 'true');
      await expect(cloud).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Tab');
      await cloud.focus();
      await expect(cloud).toHaveCSS('outline-width', '2px');
      await iconPanel.screenshot({
        path: test.info().outputPath('agent-icon.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(iconPanel).toHaveCount(0);

      await page.getByRole('button', { name: 'Form sample' }).click();
      const form = page.getByRole('dialog');
      await expect(form).toHaveCSS('padding', '12px');
      await expect(form).toHaveCSS('border-radius', '8px');
      await page.getByRole('textbox', { name: 'Link title' }).fill('Changed');
      await page.getByRole('button', { name: 'Form selection' }).click();
      await page.getByRole('option', { name: 'Second value' }).click();
      await expect(form).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Form selection' }),
      ).toHaveText('Second value');
      await page.getByRole('button', { name: 'Form selection' }).click();
      await page.keyboard.press('Escape');
      await expect(form).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Form selection' }),
      ).toBeFocused();
      await form.screenshot({
        path: test.info().outputPath('nested-form.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(form).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Form sample' }),
      ).toBeFocused();
    });
  }
}
