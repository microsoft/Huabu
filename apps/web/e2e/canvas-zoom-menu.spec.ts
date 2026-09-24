// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/playground/space-previews');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountCanvasZoomFixture } = await load(
      '/e2e/fixtures/canvas-zoom-menu.tsx',
    );
    await mountCanvasZoomFixture();
  });
});

test('percentage digit count never changes the fixed trigger width or inner gap', async ({
  page,
}) => {
  const trigger = page.getByRole('button', {
    name: /Canvas zoom .*Open zoom menu/,
  });
  const input = page.getByRole('textbox', { name: 'Zoom level' });
  for (const percentage of ['8', '80', '100', '500']) {
    await trigger.click();
    await input.fill(percentage);
    await input.press('Enter');
    await expect(trigger).toHaveText(`${percentage}%`);
    await expect(page.locator('.react-flow__controls')).toHaveCSS(
      'width',
      '72px',
    );
    await expect(page.locator('.react-flow__controls')).toHaveCSS(
      'height',
      '34px',
    );
    const geometry = await trigger.evaluate((button) => {
      const text = button.querySelector('span');
      const arrow = button.querySelector('svg');
      if (!text || !arrow) throw new Error('Missing zoom label or chevron');
      const buttonRect = button.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const arrowRect = arrow.getBoundingClientRect();
      return {
        gap: arrowRect.left - textRect.right,
        groupCenter: (textRect.left + arrowRect.right) / 2,
        buttonCenter: (buttonRect.left + buttonRect.right) / 2,
        overflows: button.scrollWidth > button.clientWidth,
      };
    });
    expect(geometry.gap).toBeCloseTo(4, 1);
    expect(geometry.groupCenter).toBeCloseTo(geometry.buttonCenter, 1);
    expect(geometry.overflows).toBe(false);
  }
});

test('compact upward menu validates percentages and supports keyboard dismissal', async ({
  page,
}) => {
  const trigger = page.getByRole('button', {
    name: /Canvas zoom .*Open zoom menu/,
  });
  await expect(trigger).toHaveText('43%');
  await expect(page.locator('.react-flow__controls button')).toHaveCount(1);
  await expect(page.locator('.react-flow__controls')).toHaveCSS(
    'width',
    '72px',
  );
  await expect(page.locator('.react-flow__controls')).toHaveCSS(
    'height',
    '34px',
  );
  expect(
    await page.locator('.react-flow__controls').evaluate((el) => {
      const color = getComputedStyle(el).backgroundColor;
      return color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
    }),
  ).toBe(true);
  const originalWidth = await trigger.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  await trigger.press('ArrowUp');
  const dialog = page.getByRole('dialog', { name: 'Canvas zoom', exact: true });
  const input = page.getByRole('textbox', { name: 'Zoom level' });
  await expect(input).toBeFocused();
  const dialogBounds = await dialog.evaluate((el) =>
    el.getBoundingClientRect().toJSON(),
  );
  expect(dialogBounds.y + dialogBounds.height).toBeLessThan(
    await trigger.evaluate((el) => el.getBoundingClientRect().y),
  );
  await page.screenshot({
    path: test.info().outputPath('canvas-zoom-menu.png'),
  });

  for (const value of ['', 'abc', '0', '501', 'Infinity']) {
    await input.fill(value);
    await input.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(
      'Enter a percentage between 1% and 500%.',
    );
    await expect(page.locator('[data-zoom-value]')).toHaveText('0.43');
  }
  await input.fill('42.5%');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('[data-zoom-value]')).toHaveText('0.425');
  await trigger.click();
  await input.fill('500');
  await input.press('Enter');
  await expect(trigger).toHaveText('500%');
  expect(await trigger.evaluate((el) => el.getBoundingClientRect().width)).toBe(
    originalWidth,
  );
  await trigger.click();
  await expect(
    page.getByRole('menuitem', { name: /^Zoom in / }),
  ).toBeDisabled();
  await input.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: /^Zoom out / }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await input.fill('1');
  await input.press('Enter');
  await trigger.click();
  await expect(
    page.getByRole('menuitem', { name: /^Zoom out / }),
  ).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Reset zoom to 100%' }).click();
  await expect(trigger).toHaveText('100%');
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Zoom in / }).click();
  await expect(trigger).toHaveText('120%');
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Zoom out / }).click();
  await expect(trigger).toHaveText('100%');
  await trigger.click();
  await input.press('Shift+Tab');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('fits offscreen nodes and disables unavailable actions', async ({
  page,
}) => {
  const trigger = page.getByRole('button', {
    name: /Canvas zoom .*Open zoom menu/,
  });
  const open = async () => {
    await trigger.click();
    await expect(
      page.getByRole('textbox', { name: 'Zoom level' }),
    ).toBeFocused();
  };
  await open();
  await page.getByRole('menuitem', { name: /^Fit selection / }).click();
  await expect(
    page.getByText('Selected offscreen node', { exact: true }),
  ).toBeInViewport();
  await open();
  await page.getByRole('menuitem', { name: 'Fit all content' }).click();
  await expect(page.getByText('Near node', { exact: true })).toBeInViewport();
  await expect(
    page.getByText('Selected offscreen node', { exact: true }),
  ).toBeInViewport();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await open();
  await expect(
    page.getByRole('menuitem', { name: 'Fit selection' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Clear canvas' }).click();
  await expect(page.getByRole('dialog', { name: 'Canvas zoom' })).toHaveCount(
    0,
  );
  await open();
  await expect(
    page.getByRole('menuitem', { name: 'Fit all content' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('menuitem', { name: 'Fit selection' }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 600 });
  const bounds = await page
    .getByRole('dialog', { name: 'Canvas zoom' })
    .boundingBox();
  if (!bounds) throw new Error('Zoom dialog has no bounding box');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
});

test('viewport shortcuts work and every menu action shows its catalog hint', async ({
  page,
}) => {
  const zoom = page.locator('[data-zoom-value]');
  await expect(zoom).toHaveText('0.43');
  await page.keyboard.press('Shift+2');
  await expect(
    page.getByText('Selected offscreen node', { exact: true }),
  ).toBeInViewport();
  await expect(zoom).not.toHaveText('0.43');
  await page.keyboard.press('Shift+1');
  await expect(page.getByText('Near node', { exact: true })).toBeInViewport();
  await expect(
    page.getByText('Selected offscreen node', { exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Control+0');
  await expect(zoom).toHaveText('1');
  await page.keyboard.press('ControlOrMeta+=');
  await expect(zoom).toHaveText('1.2');
  await page.keyboard.press('ControlOrMeta+-');
  await expect(zoom).toHaveText('1');
  await page.keyboard.press('Shift+1');
  await expect(zoom).not.toHaveText('1');
  await page.keyboard.press('Meta+0');
  await expect(zoom).toHaveText('1');

  const trigger = page.getByRole('button', {
    name: /Canvas zoom .*Open zoom menu/,
  });
  await trigger.click();
  const hints = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { formatShortcutById } = await load('/src/config/shortcuts.ts');
    return [
      'view.zoomIn',
      'view.zoomOut',
      'view.resetZoom',
      'view.fitAll',
      'view.fitSelection',
    ].map((id) => formatShortcutById(id));
  });
  const actions = [
    'Zoom in',
    'Zoom out',
    'Reset zoom to 100%',
    'Fit all content',
    'Fit selection',
  ];
  for (const [index, action] of actions.entries()) {
    expect(hints[index]).not.toBe('');
    await expect(
      page.getByRole('menuitem', {
        name: `${action} ${hints[index]}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.keyboard.press('Shift+2');
  await expect(zoom).toHaveText('1');
  await page.getByRole('button', { name: 'Clear canvas' }).click();
  await page.keyboard.press('Shift+1');
  await expect(zoom).toHaveText('1');
});

test('new viewport shortcuts yield to editing and non-canvas surfaces', async ({
  page,
}) => {
  const prevented = await page.evaluate(() => {
    const results: boolean[] = [];
    const canvas = document.querySelector('[data-canvas-root]');
    if (!canvas) throw new Error('Missing canvas fixture root');
    for (const kind of [
      'input',
      'textarea',
      'contenteditable',
      'panel',
      'dialog',
      'menu',
      'listbox',
    ]) {
      const target = document.createElement(
        kind === 'input' || kind === 'textarea' ? kind : 'div',
      );
      if (kind === 'contenteditable') target.contentEditable = 'true';
      if (kind === 'panel') target.dataset.canvasPanel = 'right';
      if (['dialog', 'menu', 'listbox'].includes(kind))
        target.setAttribute('role', kind);
      canvas.append(target);
      for (const init of [
        { key: '0', code: 'Digit0', metaKey: true },
        { key: '!', code: 'Digit1', shiftKey: true },
        { key: '@', code: 'Digit2', shiftKey: true },
      ]) {
        const event = new KeyboardEvent('keydown', {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        results.push(event.defaultPrevented);
      }
      target.remove();
    }
    for (const init of [
      { key: '0', code: 'Digit0', metaKey: true, isComposing: true },
      { key: '!', code: 'Digit1', shiftKey: true, isComposing: true },
      { key: '@', code: 'Digit2', shiftKey: true, altKey: true },
      { key: '1', code: 'Digit1' },
      { key: '2', code: 'Digit2' },
    ]) {
      const event = new KeyboardEvent('keydown', {
        ...init,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(event);
      results.push(event.defaultPrevented);
    }
    return results;
  });
  expect(prevented.every((value) => !value)).toBe(true);
  await expect(page.locator('[data-zoom-value]')).toHaveText('0.43');
});
