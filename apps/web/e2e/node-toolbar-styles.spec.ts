// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const toolbarCss = readFileSync(
  new URL(
    '../src/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css',
    import.meta.url,
  ),
  'utf8',
);

for (const toolbarClass of [
  'node-floating-toolbar',
  'canvas-context-toolbar',
]) {
  test(`${toolbarClass} preserves hover, expanded and pressed backgrounds`, async ({
    page,
  }) => {
    await page.setContent(`
      <style>
        :root {
          --bg-hover: rgb(242, 242, 242);
          --info-bg: rgb(242, 248, 255);
          --info: rgb(46, 144, 255);
        }
        @layer utilities {
          .bg-transparent { background-color: transparent; }
        }
        ${toolbarCss}
      </style>
      <div class="${toolbarClass}">
        <button id="action" class="bg-transparent">Action</button>
        <button id="expanded" class="bg-transparent" aria-expanded="true">Expanded</button>
        <button id="pressed" class="bg-transparent" aria-pressed="true">Pressed</button>
        <button class="bg-transparent node-toolbar-color">Color</button>
        <button class="bg-transparent node-toolbar-text-format" aria-pressed="true">Bold</button>
      </div>
    `);

    const action = page.locator('#action');
    await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(action).toHaveCSS('width', '32px');
    await expect(action).toHaveCSS('height', '32px');
    await expect(action).toHaveCSS('padding', '7px');
    await expect(page.locator('#expanded')).toHaveCSS(
      'background-color',
      'rgb(242, 242, 242)',
    );
    const pressed = page.locator('#pressed');
    await expect(pressed).toHaveCSS('background-color', 'rgb(242, 248, 255)');
    await expect(pressed).toHaveCSS('color', 'rgb(46, 144, 255)');
    await expect(page.locator('.node-toolbar-color')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    if (toolbarClass === 'node-floating-toolbar') {
      await expect(page.locator('.node-toolbar-text-format')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
    }

    // Force the real pseudo-class so host pointer movement cannot affect the test.
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    for (const selector of ['#action', '#pressed']) {
      const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      });
      await session.send('CSS.forcePseudoState', {
        nodeId,
        forcedPseudoClasses: ['hover'],
      });
    }
    await expect(action).toHaveCSS('background-color', 'rgb(242, 242, 242)');
    await expect(pressed).toHaveCSS('background-color', 'rgb(242, 248, 255)');
    await session.detach();
  });
}
