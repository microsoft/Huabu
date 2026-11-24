// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import en from '../src/i18n/resources/en/common.json' with { type: 'json' };
import zhCN from '../src/i18n/resources/zh-CN/common.json' with { type: 'json' };

test('production move anchor survives Ctrl, Cmd and Shift modifier combinations', async ({
  page,
}) => {
  await page.route('**/api/canvas', (route) =>
    route.fulfill({
      json: { canvases: [{ canvasId: 'destination', title: 'Destination' }] },
    }),
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar').first()).toBeVisible();
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountMoveSelectionToolbar } = await load(
      '/e2e/fixtures/move-selection-toolbar.tsx',
    );
    await mountMoveSelectionToolbar();
  });
  const toolbar = page.locator('.node-floating-toolbar');
  const trigger = toolbar.getByRole('button', { name: 'More', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name: en.moveSelection.action }).click();
  const panel = page.getByRole('dialog', { name: en.moveSelection.title });
  await expect(panel).toBeVisible();
  // The panel is one searchable list of existing Spaces; search takes focus.
  const input = panel.getByRole('textbox', { name: en.moveSelection.search });
  await expect(input).toBeFocused();
  await expect(
    panel.getByRole('button', { name: 'Destination', exact: true }),
  ).toBeVisible();
  await input.fill('Dest');
  const initial = await panel.boundingBox();
  if (!initial) throw new Error('Missing move panel bounds');
  expect(initial.x).toBeGreaterThan(100);
  expect(initial.y).toBeGreaterThan(100);
  const anchor = await trigger.elementHandle();
  if (!anchor) throw new Error('Missing move panel anchor');
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.down(modifier);
    for (const withShift of [false, true]) {
      if (withShift) await page.keyboard.down('Shift');
      await expect(toolbar).toBeVisible();
      expect(await anchor.evaluate((el) => el.isConnected)).toBe(true);
      await expect(input).toBeFocused();
      const box = await panel.boundingBox();
      if (!box)
        throw new Error('Move panel disappeared while modifiers were held');
      expect(Math.abs(box.x - initial.x)).toBeLessThan(1);
      expect(Math.abs(box.y - initial.y)).toBeLessThan(1);
      if (withShift) await page.keyboard.up('Shift');
    }
    await page.keyboard.up(modifier);
  }
  await input.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.locator('.react-flow__node').focus();
  await page.keyboard.down('Control');
  await expect(toolbar).toHaveCount(0);
  await page.keyboard.up('Control');
  await expect(toolbar).toBeVisible();
});

for (const consumePointer of [false, true]) {
  test(`canvas press closes the move panel and clears selection (capture consumed: ${consumePointer})`, async ({
    page,
  }) => {
    await page.route('**/api/canvas', (route) =>
      route.fulfill({
        json: { canvases: [{ canvasId: 'destination', title: 'Destination' }] },
      }),
    );
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar').first()).toBeVisible();
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountMoveSelectionToolbar } = await load(
        '/e2e/fixtures/move-selection-toolbar.tsx',
      );
      await mountMoveSelectionToolbar();
    });
    const toolbar = page.locator('.node-floating-toolbar');
    await toolbar.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: en.moveSelection.action }).click();
    const panel = page.getByRole('dialog', { name: en.moveSelection.title });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Destination', exact: true }),
    ).toBeVisible();
    const pane = page.locator('.react-flow__pane');
    if (consumePointer) {
      await pane.evaluate((element) => {
        element.addEventListener(
          'pointerdown',
          (event) => {
            event.stopPropagation();
            event.stopImmediatePropagation();
          },
          { capture: true },
        );
      });
    }
    const bounds = await pane.boundingBox();
    if (!bounds) throw new Error('Missing canvas pane bounds');
    await page.mouse.move(bounds.x + 100, bounds.y + 650);
    await page.mouse.down();
    await expect(panel).toHaveCount(0);
    await page.mouse.up();
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  });
}

for (const [language, strings] of [
  ['en', en],
  ['zh-CN', zhCN],
] as const) {
  test(`move popover uses matching controls and keyboard dismissal in ${language}`, async ({
    page,
  }) => {
    await page.addInitScript((locale) => {
      localStorage.setItem('huabu.language', locale);
    }, language);
    await page.goto('/playground/node-toolbars');
    const trigger = page
      .getByRole('group', { name: 'Note 工具栏', exact: true })
      .getByRole('button', { name: '更多', exact: true });
    const panel = page.getByRole('dialog', {
      name: strings.moveSelection.title,
    });
    const search = panel.getByRole('textbox', {
      name: strings.moveSelection.search,
    });
    const destinations = panel
      .getByRole('list', { name: strings.moveSelection.spaces })
      .getByRole('button');
    const open = async () => {
      await trigger.click();
      await page
        .getByRole('menuitem', { name: '移至其他 Space', exact: true })
        .click();
      await expect(panel).toBeVisible();
      await expect(search).toBeFocused();
    };

    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await open();
      await expect(panel).not.toHaveAttribute('aria-modal', 'true');
      await expect(panel).not.toContainText(strings.moveSelection.frameNotice);
      // Existing Spaces only: no creation step and no ownership controls.
      await expect(panel.getByRole('textbox')).toHaveCount(1);
      await expect(panel.getByRole('checkbox')).toHaveCount(0);
      await expect(panel.getByRole('combobox')).toHaveCount(0);
      await expect(
        panel.getByText(strings.moveSelection.createNewDestination),
      ).toHaveCount(0);
      await expect(destinations).toHaveText([
        'Design notebook',
        'Research archive',
      ]);
      expect(
        await destinations.evaluateAll((elements) =>
          elements.map((el) => ({
            height: el.getBoundingClientRect().height,
            fontSize: getComputedStyle(el).fontSize,
          })),
        ),
      ).toEqual(
        Array.from({ length: 2 }, () => ({ height: 32, fontSize: '13px' })),
      );
      await expect(search).toHaveCSS('font-size', '13px');
      await expect(search).toHaveCSS('height', '36px');
      await expect
        .poll(() =>
          panel.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left >= 11 &&
              rect.right <= innerWidth - 11 &&
              rect.top >= 11 &&
              rect.bottom <= innerHeight - 11 &&
              el.scrollWidth <= el.clientWidth
            );
          }),
        )
        .toBe(true);
      const surface = panel.locator('..');
      await expect(surface).toHaveCSS('padding', '8px');
      const footer = panel.getByText(
        strings.moveSelection.description.replace('{{count}}', '1'),
      );
      await expect(footer).toHaveCSS('font-size', '12px');
      await expect(footer).toHaveCSS('border-top-width', '1px');

      // Arrow keys walk from search into the list and back.
      await search.press('ArrowDown');
      await expect(destinations.first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(destinations.nth(1)).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await expect(search).toBeFocused();

      await search.fill('research');
      await expect(destinations).toHaveText(['Research archive']);
      await search.fill('no such space');
      await expect(destinations).toHaveCount(0);
      await expect(panel).toContainText(strings.moveSelection.noTargets);
      await search.fill('');
      await expect(destinations).toHaveCount(2);
      await surface.screenshot({
        path: test.info().outputPath(`move-${language}-${width}.png`),
      });
      await search.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }

    // Choosing a destination submits at once.
    await open();
    await destinations.filter({ hasText: 'Research archive' }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: '样例目标：Research archive' }),
    ).toBeVisible();

    // An outside press dismisses the panel and discards the search.
    await open();
    await search.fill('design');
    await expect(destinations).toHaveCount(1);
    await page
      .getByRole('heading', { name: 'Node toolbars', exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await open();
    await expect(search).toHaveValue('');
    await expect(destinations).toHaveCount(2);
  });
}
