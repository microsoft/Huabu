// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test('menus fit localized content and constrain long labels within their boundary', async ({
  page,
}) => {
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const reactModule = await load('/node_modules/.vite/deps/react.js');
    const React = reactModule.default ?? reactModule;
    const domModule = await load(
      '/node_modules/.vite/deps/react-dom_client.js',
    );
    const { createRoot } = domModule.default ?? domModule;
    const { DropdownMenu, DropdownMenuItem, DropdownMenuSubmenu } = await load(
      '/src/components/Common/DropdownMenu.tsx',
    );
    const { Select } = await load('/src/components/Common/Select.tsx');
    const { Popover } = await load('/src/components/Common/Popover.tsx');
    const { Button } = await load('/src/components/Common/Button.tsx');
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;inset:0;background:var(--bg-surface);z-index:9000;overflow:auto';
    document.body.append(host);
    const element = React.createElement;
    const longLabel = 'LongUnbrokenOption'.repeat(30);
    function Fixture() {
      const [result, setResult] = React.useState('');
      const [boundary, setBoundary] = React.useState(null);
      return element(
        'div',
        { style: { padding: 16 } },
        element('output', { 'data-result': true }, result),
        ...['默认', 'Default font family'].map((label) =>
          element(
            DropdownMenu,
            {
              key: label,
              floating: true,
              trigger: element(Button, null, label),
            },
            element(
              DropdownMenuItem,
              { onClick: () => setResult(label) },
              label,
            ),
            element(
              DropdownMenuSubmenu,
              { label: 'Fonts' },
              element(
                DropdownMenuItem,
                { onClick: () => setResult('nested') },
                'Serif',
              ),
            ),
          ),
        ),
        element(
          DropdownMenu,
          { trigger: element(Button, null, 'Long menu') },
          element(
            DropdownMenuItem,
            { onClick: () => setResult('long') },
            longLabel,
          ),
        ),
        element(
          'div',
          { style: { width: 640 } },
          element(Select, {
            className: 'w-full',
            ariaLabel: 'Wide select',
            value: 'short',
            onChange: setResult,
            options: [
              { value: 'short', label: 'Short' },
              { value: 'long', label: longLabel },
            ],
          }),
        ),
        element(
          'div',
          {
            ref: setBoundary,
            'data-boundary': true,
            style: {
              position: 'relative',
              width: 'min(220px, 100%)',
              height: 220,
              marginTop: 20,
            },
          },
          boundary &&
            element(
              Popover,
              { boundary, position: { x: 500, y: 250 }, className: 'w-96' },
              element(
                'span',
                { 'data-boundary-content': true },
                'Bounded form',
              ),
            ),
        ),
      );
    }
    createRoot(host).render(element(Fixture));
  });

  const panelFor = (locator: ReturnType<typeof page.locator>) =>
    locator.locator('xpath=ancestor::*[@data-floating-chrome][1]');
  const fit = async (panel: ReturnType<typeof page.locator>) => {
    await expect(panel).toBeVisible();
    await expect
      .poll(async () =>
        panel.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.left >= 11 &&
            rect.right <= innerWidth - 11 &&
            el.scrollWidth <= el.clientWidth + 1
          );
        }),
      )
      .toBe(true);
  };
  const widths: number[] = [];
  for (const label of ['默认', 'Default font family']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const item = page.getByRole('menuitem', { name: label, exact: true });
    const panel = panelFor(item);
    await fit(panel);
    widths.push((await panel.boundingBox())!.width);
    await page.getByRole('menuitem', { name: 'Fonts' }).hover();
    const nested = page.getByRole('menuitem', { name: 'Serif', exact: true });
    await fit(panelFor(nested));
    await nested.click();
    await expect(page.locator('[data-result]')).toHaveText('nested');
    await page.keyboard.press('Escape');
  }
  expect(widths[0]).toBeLessThan(widths[1]);
  expect(widths[0]).toBeLessThan(160);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const side of ['left', 'right']) {
      const trigger = page.getByRole('button', { name: '默认', exact: true });
      await trigger.evaluate((button, edge) => {
        const wrapper = button.parentElement;
        if (!wrapper) throw new Error('Missing menu trigger wrapper');
        wrapper.style.cssText = `position:fixed;top:24px;${edge}:16px`;
      }, side);
      await trigger.click();
      const parent = panelFor(
        page.getByRole('menuitem', { name: '默认', exact: true }),
      );
      await page.getByRole('menuitem', { name: 'Fonts' }).hover();
      const nested = page.getByRole('menuitem', { name: 'Serif', exact: true });
      const child = panelFor(nested);
      await fit(child);
      await expect
        .poll(async () => {
          const parentRect = await parent.boundingBox();
          const childRect = await child.boundingBox();
          if (!parentRect || !childRect) return false;
          return side === 'left'
            ? childRect.x >= parentRect.x + parentRect.width + 4
            : childRect.x + childRect.width <= parentRect.x - 4;
        })
        .toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`submenu-${width}-${side}.png`),
      });
      await nested.click();
      await expect(page.locator('[data-result]')).toHaveText('nested');
      await page.keyboard.press('Escape');
      await trigger.evaluate((button) =>
        button.parentElement?.removeAttribute('style'),
      );
    }
  }
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Long menu', exact: true }).click();
    const item = page.getByRole('menuitem', { name: /^LongUnbrokenOption/ });
    await fit(panelFor(item));
    await item.click();
    await expect(page.locator('[data-result]')).toHaveText('long');
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Wide select', exact: true })
      .click();
    const option = page.getByRole('option', { name: /^LongUnbrokenOption/ });
    await fit(panelFor(option));
    await option.click();
    await expect(option).toHaveCount(0);
    const bounded = panelFor(page.locator('[data-boundary-content]'));
    await expect
      .poll(async () => {
        const outer = await page.locator('[data-boundary]').boundingBox();
        const inner = await bounded.boundingBox();
        return Boolean(
          outer &&
          inner &&
          inner.width <= outer.width - 24 + 1 &&
          inner.x >= outer.x + 11 &&
          inner.x + inner.width <= outer.x + outer.width - 11,
        );
      })
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`popup-width-${width}.png`),
    });
  }
});
