// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';
import { PanelLeft, PanelRight, Plus, Sparkles } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('shared Lucide strokes use the default without overriding exceptions or artwork', async ({
  page,
}) => {
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      { 'data-icon-styles': true },
      createElement(PanelLeft, { id: 'default-left' }),
      createElement(PanelRight, { id: 'default-right' }),
      createElement(Sparkles, { id: 'default-agent' }),
      createElement(Plus, { id: 'thin', strokeWidth: 1.5 }),
      createElement(Plus, { id: 'thick', strokeWidth: 3 }),
      createElement(Plus, { id: 'original', style: { strokeWidth: 2 } }),
      createElement(Plus, { id: 'utility', className: 'stroke-[3]' }),
      createElement('svg', { id: 'custom-svg', strokeWidth: 2 }),
      createElement('svg', { id: 'avatar-svg', strokeWidth: 4.2 }),
    ),
  );
  await page.evaluate((markup) => {
    document.body.insertAdjacentHTML('beforeend', markup);
  }, markup);
  const fixture = page.locator('[data-icon-styles]');

  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    for (const name of ['left', 'right', 'agent']) {
      await expect(fixture.locator(`#default-${name}`)).toHaveCSS(
        'stroke-width',
        '2px',
      );
    }
    for (const [id, width] of [
      ['thin', '1.5px'],
      ['thick', '3px'],
      ['original', '2px'],
      ['utility', '3px'],
      ['custom-svg', '2px'],
      ['avatar-svg', '4.2px'],
    ]) {
      await expect(fixture.locator(`#${id}`)).toHaveCSS('stroke-width', width);
    }
  }
});
