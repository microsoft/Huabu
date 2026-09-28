// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

for (const nodeType of ['note', 'text'] as const) {
  test(`${nodeType} toolbar inputs preserve selection, shortcuts and draft cancellation`, async ({
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
                  id: 'node-input-test',
                  nodeType,
                  data: { content: 'Toolbar input test' },
                  position: { x: 350, y: 300 },
                  size: { width: 320, height: 200 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-toolbar-inputs' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const node = page.locator('.react-flow__node[data-id="node-input-test"]');
    await node.click();
    const toolbar = page.locator('.node-floating-toolbar');
    await expect(toolbar).toBeVisible();

    const replaceByDoubleClick = async (name: string, value: string) => {
      const input = page.locator(`input[name="${name}"]`);
      await input.dblclick();
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect(toolbar).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(0);
      for (const modifier of ['Control', 'Meta']) {
        await page.keyboard.down(modifier);
        await page.keyboard.down('Shift');
        await expect(input).toBeFocused();
        await expect(toolbar).toBeVisible();
        await page.keyboard.up('Shift');
        await page.keyboard.up(modifier);
      }
      // Replacing the selection proves the whole numeric value was selected.
      await page.keyboard.insertText(value);
      await expect(input).toHaveValue(value);
      await input.press('Enter');
      await expect(input).toHaveValue(value);
    };

    if (nodeType === 'text') {
      await replaceByDoubleClick('font-size', '32');
    }
    const size = toolbar.getByRole('button', { name: 'Size', exact: true });
    await size.click();
    await replaceByDoubleClick('node-width', '417');
    if (nodeType === 'note') {
      await replaceByDoubleClick('node-height', '263');
    }
    const width = page.locator('input[name="node-width"]');
    await width.fill('499');
    await width.press('ControlOrMeta+a');
    await page.keyboard.insertText('599');
    await expect(width).toHaveValue('599');
    await width.press('Escape');
    await expect(page.locator('input[name="node-width"]')).toHaveCount(0);
    await expect(size).toBeFocused();
    await size.press('Enter');
    await expect(width).toHaveValue('417');
    await width.focus();
    await page.keyboard.press('Escape');
    await expect(size).toBeFocused();
    await size.click();
    await width.fill('450');
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 50, y: 650 } });
    await expect(width).toHaveCount(0);
    await expect(node).toHaveCSS('width', '450px');
    await node.dblclick();
    if (nodeType === 'note') {
      await expect(
        page.getByRole('tab', { name: /Toolbar input test \(note\)/ }),
      ).toBeVisible();
    } else {
      await expect(node.locator('textarea')).toBeFocused();
    }
  });
}
