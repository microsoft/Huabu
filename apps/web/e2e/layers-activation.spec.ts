// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { getAbsolutePosition } from '@huabu/shared/canvas-engine';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  scaleOf,
  translateOf,
  oneFingerDrag,
  touchTap,
} from './helpers';

import type {
  CanvasCommand,
  CanvasNodeCreateInput,
  CanvasNodeId,
  GetCanvasResponse,
  PutCanvasRequest,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

test('mounts Layers on demand and restores filtered scrolling and focus', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: Array.from({ length: 50 }, (_, index) => ({
            nodeType: index === 0 ? 'text' : 'note',
            data: { label: `Layer ${index}`, content: `Body ${index}` },
            position: { x: 3000 + index * 450, y: 3000 },
            size: { width: 400, height: 200 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-layers-lifecycle' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const tree = page.getByRole('tree', { name: 'Layers' });
  await expect(tree).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(50);
  await expect(
    tree.getByRole('treeitem').first().locator('svg.lucide[width="14"]'),
  ).toHaveCSS('stroke-width', '2px');
  await page
    .getByRole('button', { name: 'Filter by Note', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  const focusedRow = tree.getByRole('treeitem').nth(12);
  await focusedRow.focus();
  const lockAction = focusedRow.getByRole('button', {
    name: 'Lock',
    exact: true,
  });
  await expect(lockAction).toHaveCSS('opacity', '1');
  await lockAction.focus();
  await expect(lockAction).toHaveCSS('opacity', '1');
  await focusedRow.focus();
  const focusedId = await focusedRow.getAttribute('data-layer-id');
  const scrollHost = tree.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]',
  );
  await scrollHost.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(300);
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(tree).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  await expect(
    page.getByRole('button', { name: 'Stop filtering by Note', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(300);
  await expect(tree.locator(`[data-layer-id="${focusedId}"]`)).toHaveAttribute(
    'tabindex',
    '0',
  );
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(49);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reopenedRow = tree.locator(`[data-layer-id="${focusedId}"]`);
  await reopenedRow.click({ position: { x: 50, y: 18 } });
  await expect(reopenedRow).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^Body 37/ })).toBeVisible();
  expect(
    await reopenedRow.evaluate((row) => {
      const surface = row.querySelector<HTMLElement>(':scope > .group');
      if (!surface) throw new Error('Missing directory row surface');
      const bounds = row.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      return {
        rowHeight: bounds.height,
        surfaceHeight: surfaceBounds.height,
        horizontalInset: bounds.width - surfaceBounds.width,
        cornerRadius: getComputedStyle(surface).borderRadius,
      };
    }),
  ).toEqual({
    rowHeight: 34,
    surfaceHeight: 32,
    horizontalInset: 16,
    cornerRadius: '6px',
  });
  const hoverSession = await page.context().newCDPSession(page);
  await hoverSession.send('DOM.enable');
  await hoverSession.send('CSS.enable');
  const forceHover = async (selector: string) => {
    const { root } = await hoverSession.send('DOM.getDocument');
    const { nodeId } = await hoverSession.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    await hoverSession.send('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['hover'],
    });
  };
  const selectedSurface = reopenedRow.locator(':scope > .group');
  const selectedBackground = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--info-bg)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(selectedSurface).toHaveCSS(
    'background-color',
    selectedBackground,
  );
  await forceHover(`[data-layer-id="${focusedId}"] > .group`);
  await expect(selectedSurface).toHaveCSS(
    'background-color',
    selectedBackground,
  );
  await page.screenshot({ path: testInfo.outputPath('sidebar-directory.png') });
  const searchInput = page.locator('[data-canvas-search-input]');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Body');
  const searchResults = page.locator('[data-canvas-search-results]');
  await expect(searchResults.getByRole('button').first()).toBeVisible();
  await expect(
    searchResults
      .locator('button[aria-expanded]')
      .first()
      .locator('svg.lucide[width="14"]'),
  ).toHaveCSS('stroke-width', '2px');
  await expect(page.getByLabel('Searching', { exact: true })).toHaveCount(0);
  const searchHeader = searchResults.locator('button[aria-expanded]').first();
  await expect(searchHeader).toHaveCSS('border-radius', '6px');
  await expect(searchHeader).toHaveCSS('border-bottom-width', '0px');
  await expect(searchHeader).toHaveCSS('height', '28px');
  await expect(searchHeader.locator('..').getByRole('separator')).toHaveCount(
    0,
  );
  const secondHeader = searchResults.locator('button[aria-expanded]').nth(1);
  const groupSeparator = secondHeader.locator('..').getByRole('separator');
  await expect(groupSeparator).toHaveCSS('border-top-width', '1px');
  await expect(groupSeparator).toHaveCSS('margin-top', '2px');
  await expect(groupSeparator).toHaveCSS('margin-bottom', '2px');
  const firstMatch = searchResults
    .locator('button:not([aria-expanded])')
    .first();
  await expect(firstMatch).toHaveCSS('height', '40px');
  await expect(firstMatch).toHaveCSS('padding-top', '4px');
  await expect(firstMatch).toHaveCSS('padding-bottom', '4px');
  expect(
    await firstMatch.evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(
    await searchHeader.evaluate(
      (element) => element.getBoundingClientRect().bottom,
    ),
  );
  await expect(firstMatch).toHaveCSS('row-gap', '0px');
  const titleLeft = await searchHeader
    .locator('span.truncate')
    .evaluate((element) => element.getBoundingClientRect().left);
  expect(
    await firstMatch
      .locator('.uppercase')
      .evaluate((element) => element.getBoundingClientRect().left),
  ).toBe(titleLeft);
  expect(
    await firstMatch
      .locator('div.truncate')
      .evaluate((element) => element.getBoundingClientRect().left),
  ).toBe(titleLeft);
  await expect(searchHeader).toHaveCSS('background-color', selectedBackground);
  await forceHover('[data-canvas-search-results] button[aria-expanded]');
  await expect(searchHeader).toHaveCSS('background-color', selectedBackground);
  const icon = searchHeader.locator('svg.lucide[width="14"]');
  expect(
    await icon.evaluate((element) => getComputedStyle(element).color),
  ).toBe(
    await searchHeader
      .locator('span.truncate')
      .evaluate((element) => getComputedStyle(element).color),
  );
  await hoverSession.detach();
  await searchInput.focus();
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press('ArrowDown');
  }
  const searchScroller = searchResults.locator('[data-virtuoso-scroller]');
  await expect
    .poll(() => searchScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const searchScrollTop = await searchScroller.evaluate(
    (element) => element.scrollTop,
  );
  const activeResult = searchResults.locator('button.bg-info-bg');
  const activeText = await activeResult.textContent();
  const selectedNode = await page
    .locator('.react-flow__node.selected')
    .getAttribute('data-id');
  await searchResults.evaluate((element) => {
    element.setAttribute('data-lifecycle-probe', 'retained');
  });
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await page.waitForTimeout(350);
  await expect(searchResults).toHaveAttribute(
    'data-lifecycle-probe',
    'retained',
  );
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(searchInput).toHaveValue('Body');
  await expect(activeResult).toHaveText(activeText ?? '');
  await expect
    .poll(() => searchScroller.evaluate((element) => element.scrollTop))
    .toBe(searchScrollTop);
  await expect(page.locator('.react-flow__node.selected')).toHaveAttribute(
    'data-id',
    selectedNode ?? '',
  );
  await searchInput.press('Escape');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveValue('');
  await expect(page.locator('[data-canvas-root]')).toBeFocused();
  await page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .click();
  await expect(tree).toHaveCount(0);
  await openNewCanvas(page);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(0);
  await expect
    .poll(() => scrollHost.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test('keeps search visible without stealing focus and focuses it only on Find', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const expand = page.getByRole('button', {
    name: 'Show layers panel',
    exact: true,
  });
  await expand.click();
  const input = page.locator('[data-canvas-search-input]');
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  expect(
    await input.evaluate((element) => {
      const placeholder = getComputedStyle(element, '::placeholder');
      return {
        inputSize: getComputedStyle(element).fontSize,
        placeholderSize: placeholder.fontSize,
        placeholderWeight: placeholder.fontWeight,
      };
    }),
  ).toMatchObject({
    inputSize: '14px',
    placeholderSize: '12px',
    placeholderWeight: '400',
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect
      .poll(() =>
        input.evaluate((element) => {
          const icon = element.previousElementSibling;
          if (!icon) throw new Error('Missing search icon');
          return (
            getComputedStyle(element, '::placeholder').color ===
            getComputedStyle(icon).color
          );
        }),
      )
      .toBe(true);
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await expect(
    page.getByRole('button', { name: /^Search this Space/ }),
  ).toHaveCount(0);

  const collapse = page.getByRole('button', {
    name: 'Collapse layers panel',
    exact: true,
  });
  await collapse.click();
  await expect(input).toBeHidden();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator('[data-canvas-panel="left"]')
        .evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(0);

  await input.fill('example');
  await page.keyboard.press('ControlOrMeta+f');
  await expect(input).toHaveValue('example');
  expect(
    await input.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, 7]);

  await input.press('Escape');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(page.locator('[data-canvas-root]')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('sidebar-search.png') });
});

test('uses the Canvas typography hierarchy for Layers and search results', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              data: {
                label: 'Typography needle node',
                content:
                  '# Typography needle node\n\nTypography needle summary.',
              },
              position: { x: 1000, y: 1000 },
              size: { width: 400, height: 200 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-canvas-typography' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  const label = page
    .getByRole('tree', { name: 'Layers' })
    .getByRole('treeitem')
    .locator('span.truncate');
  await expect(label).toHaveText('Typography needle node');
  await expect(label).toHaveCSS('font-size', '14px');
  await expect(label).toHaveCSS('font-weight', '400');

  const input = page.locator('[data-canvas-search-input]');
  await expect(input).toHaveCSS('font-size', '14px');
  await expect(input).toHaveCSS('font-weight', '400');
  await input.fill('needle');
  const results = page.locator('[data-canvas-search-results]');
  const group = results.locator('button[aria-expanded]').first();
  await expect(group).toBeVisible();
  await expect(group.locator('span.truncate')).toHaveCSS('font-size', '14px');
  await expect(group.locator('span.truncate')).toHaveCSS('font-weight', '400');
  await expect(group.locator('span.tabular-nums')).toHaveCSS(
    'font-size',
    '12px',
  );
  await expect(group.locator('span.tabular-nums')).toHaveCSS(
    'font-weight',
    '400',
  );

  const count = input.locator('..').locator('span.tabular-nums');
  await expect(count).toBeVisible();
  await expect(count).toHaveCSS('font-size', '12px');
  await expect(count).toHaveCSS('font-weight', '400');
  const summary = results.locator('button[tabindex="-1"] div.truncate').first();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveCSS('font-size', '12px');
  await expect(summary).toHaveCSS('font-weight', '400');
});

for (const platform of ['MacIntel', 'Win32']) {
  test(`spaces the search shortcut tokens only on ${platform}`, async ({
    page,
  }) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, 'platform', {
        value: platform,
        configurable: true,
      });
    }, platform);
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Show layers panel', exact: true })
      .click();
    const hint = page
      .locator('[data-canvas-search-input]')
      .locator('..')
      .locator('kbd');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(platform === 'MacIntel' ? '⌘F' : 'Ctrl+F');
    await expect(hint).toHaveCSS('column-gap', '2px');
    await expect(hint).toHaveCSS('font-size', '12px');
    await expect(hint).toHaveCSS('font-weight', '400');
    await expect(hint).toHaveCSS('padding-left', '4px');
    await expect(hint).toHaveCSS('padding-right', '4px');
    await expect(hint.locator('span')).toHaveCount(
      platform === 'MacIntel' ? 2 : 0,
    );
    if (platform === 'MacIntel') {
      expect(
        await hint.evaluate((element) => {
          const tokens = element.querySelectorAll('span');
          return (
            tokens[1].getBoundingClientRect().left -
            tokens[0].getBoundingClientRect().right
          );
        }),
      ).toBe(2);
    }
  });
}

test('activates a Layers node without repeated viewport takeover', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const center = await paneCenter(page);
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);

  const collapsePreviews = page.getByRole('button', {
    name: 'Collapse previews',
  });
  if (await collapsePreviews.isVisible()) await collapsePreviews.click();
  await page.getByRole('button', { name: 'Show layers panel' }).click();

  const tree = page.getByRole('tree', { name: 'Layers' });
  const layer = tree.getByRole('treeitem').first();
  await layer.click();
  await expect(layer).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();
  const surface = layer.locator(':scope > div');
  await expect(surface).toHaveCSS('box-shadow', 'none');
  await expect(layer).toHaveCSS('box-shadow', 'none');

  await page.waitForTimeout(500);
  const settled = await readViewportTransform(page);
  await layer.click();
  await page.waitForTimeout(500);
  const repeated = await readViewportTransform(page);
  expect(scaleOf(repeated)).toBe(scaleOf(settled));
  expect(translateOf(repeated).x).toBeCloseTo(translateOf(settled).x, 0);
  expect(translateOf(repeated).y).toBeCloseTo(translateOf(settled).y, 0);

  await collapsePreviews.click();
  await layer.focus();
  await layer.press('Home');
  await expect
    .poll(() => layer.evaluate((element) => element.matches(':focus-visible')))
    .toBe(true);
  await expect(surface).toHaveCSS('border-radius', '6px');
  await expect(surface).not.toHaveCSS('box-shadow', 'none');
  await expect(layer).toHaveCSS('box-shadow', 'none');
  await layer.press('Enter');
  await expect(page.getByRole('tab', { name: /note/i })).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  test(`renames a Layers item with normal text and subtle icons in ${theme} mode`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.keyboard.press('Escape');
    const center = await paneCenter(page);
    await page
      .locator('[data-canvas-main-toolbar]')
      .getByRole('button', { name: /^Note/ })
      .click();
    await page.mouse.click(center.x, center.y);
    await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Show layers panel', exact: true })
      .click();
    const row = page
      .getByRole('tree', { name: 'Layers' })
      .getByRole('treeitem')
      .first();
    await row.click();
    const label = row.locator('span.truncate');
    const originalName = await label.innerText();
    const labelStyle = await label.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        centerY: bounds.top + bounds.height / 2,
        fontSize: getComputedStyle(element).fontSize,
      };
    });
    await label.dblclick();
    const editor = row.getByRole('textbox', {
      name: originalName,
      exact: true,
    });
    const colors = await page.evaluate(() => {
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const resolveColor = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const colors = {
        foreground: resolveColor('--fg-default'),
        surface: resolveColor('--bg-surface'),
        subtle: resolveColor('--fg-subtle'),
        info: resolveColor('--info'),
      };
      probe.remove();
      return colors;
    });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveCSS('font-size', labelStyle.fontSize);
    await expect(editor).toHaveCSS('font-size', '14px');
    await expect(editor).toHaveCSS('font-weight', '400');
    await expect(editor).toHaveCSS('color', colors.foreground);
    await expect(editor).toHaveCSS('background-color', colors.surface);
    await expect(editor).toHaveCSS('padding-left', '4px');
    await expect(editor).toHaveCSS('border-left-width', '1px');
    await expect(editor).toHaveCSS('border-left-color', colors.info);
    await expect(editor).toHaveCSS('border-radius', '6px');
    await expect(editor).toHaveCSS('height', '24px');
    await expect(editor).not.toHaveCSS('box-shadow', 'none');
    const icon = row.locator('span.pointer-events-none svg').first();
    await expect(icon).toHaveCSS('color', colors.subtle);
    expect(
      await editor.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, centerY: bounds.top + bounds.height / 2 };
      }),
    ).toEqual({ left: labelStyle.left, centerY: labelStyle.centerY });
    await expect(row).not.toHaveAttribute('data-layer-dragging');

    await editor.fill('Inline renamed layer');
    await editor.press('Enter');
    await expect(row.getByRole('textbox')).toHaveCount(0);
    await expect(label).toHaveText('Inline renamed layer');
    await expect(icon).toHaveCSS('color', colors.info);
    await label.dblclick();
    const renamedEditor = row.getByRole('textbox', {
      name: 'Inline renamed layer',
      exact: true,
    });
    await renamedEditor.fill('Canceled layer name');
    await renamedEditor.press('Escape');
    await expect(label).toHaveText('Inline renamed layer');
    await label.dblclick();
    await row.getByRole('textbox').fill('Blur committed layer');
    await page
      .getByRole('textbox', { name: 'Space title', exact: true })
      .click();
    await expect(label).toHaveText('Blur committed layer');
  });
}

test('reorders Layers rows by dragging the label or row whitespace without activation', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const center = await paneCenter(page);
  const toolbar = page.locator('[data-canvas-main-toolbar]');
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x - 250, center.y);
  await toolbar.getByRole('button', { name: /^Note/ }).click();
  await page.mouse.click(center.x + 250, center.y);
  await page.getByRole('button', { name: 'Show layers panel' }).click();
  await expect
    .poll(() =>
      page
        .locator('[data-canvas-panel="left"]')
        .evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(0);

  const rows = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
  const tabs = page.getByRole('tab');
  const initialTabs = await tabs.count();
  const initialOrder = await rows.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-layer-id')),
  );
  const cancelSource = await rows
    .first()
    .locator('span.truncate')
    .boundingBox();
  const cancelTarget = await rows.nth(1).boundingBox();
  if (!cancelSource || !cancelTarget)
    throw new Error('Missing cancel row bounds');
  const cancelX = cancelSource.x + cancelSource.width / 2;
  await page.mouse.move(cancelX, cancelSource.y + cancelSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelX, cancelTarget.y + cancelTarget.height - 2, {
    steps: 10,
  });
  await expect(rows.first()).toHaveAttribute('data-layer-dragging', 'true');
  await expect(rows.first()).toHaveCSS('opacity', '1');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(rows.first()).not.toHaveAttribute('data-layer-dragging');
  expect(
    await rows.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-layer-id')),
    ),
  ).toEqual(initialOrder);
  await expect(tabs).toHaveCount(initialTabs);
  for (const source of ['label', 'whitespace']) {
    const before = await rows.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-layer-id')),
    );
    const first = rows.first();
    const start = await (
      source === 'label' ? first.locator('span.truncate') : first
    ).boundingBox();
    const target = await rows.nth(1).boundingBox();
    if (!start || !target) throw new Error('Missing reorder row bounds');
    const x = start.x + (source === 'label' ? start.width / 2 : 4);
    await page.mouse.move(x, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, target.y + target.height - 2, { steps: 10 });
    await expect(first).toHaveAttribute('data-layer-dragging', 'true');
    await expect(first).toHaveCSS('opacity', '1');
    await expect(first).toHaveCSS('cursor', 'grabbing');
    await page.mouse.up();
    await expect
      .poll(() =>
        rows.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-layer-id')),
        ),
      )
      .toEqual([...before].reverse());
    await expect(tabs).toHaveCount(initialTabs);
  }
});

for (const input of ['mouse', 'touch'] as const) {
  test(`reorders selected sibling Layers as one ${input} drag with one undo step`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: Array.from({ length: 5 }, (_, index) => ({
                nodeType: 'note',
                data: { label: `Group layer ${index}`, content: '' },
                position: { x: 3000 + index * 450, y: 3000 },
                size: { width: 400, height: 200 },
              })),
            },
          ],
          originator: {
            source: 'agent',
            threadId: `e2e-layers-multi-${input}`,
          },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    await page
      .getByRole('button', { name: 'Show layers panel', exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator('[data-canvas-panel="left"]')
          .evaluate((element) => element.getBoundingClientRect().left),
      )
      .toBe(0);
    const tree = page.getByRole('tree', { name: 'Layers' });
    const rows = tree.getByRole('treeitem');
    await expect(rows).toHaveCount(5);
    const readOrder = () =>
      rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-layer-id')),
      );
    const before = await readOrder();
    await rows.nth(0).click();
    await expect(page.getByRole('tab', { name: /Group layer/ })).toBeVisible();
    await rows.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect(tree.locator('[aria-selected="true"]')).toHaveCount(2);
    for (const source of [rows.nth(0), rows.nth(2)]) {
      await expect(source.locator('.bg-info-bg')).toHaveCount(1);
      await expect(source.locator(':scope > div')).toHaveCSS(
        'box-shadow',
        'none',
      );
    }
    const tabs = page.getByRole('tab');
    const tabCount = await tabs.count();
    const selected = [rows.nth(0), rows.nth(2)];
    const start = await selected[1].locator('span.truncate').boundingBox();
    const target = await rows.nth(4).boundingBox();
    if (!start || !target) throw new Error('Missing multi-row drag bounds');
    const point = {
      x: start.x + start.width / 2,
      y: start.y + start.height / 2,
    };
    const destination = { x: point.x, y: target.y + target.height - 2 };
    const client =
      input === 'touch' ? await page.context().newCDPSession(page) : null;
    try {
      if (client) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        });
        await expect(selected[1]).toHaveAttribute(
          'data-layer-dragging',
          'true',
        );
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [destination],
        });
      } else {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(destination.x, destination.y, { steps: 10 });
      }
      await expect(tree.locator('[data-layer-dragging]')).toHaveCount(2);
      for (const source of selected) {
        await expect(source).toHaveAttribute('aria-selected', 'true');
        await expect(source).toHaveCSS('opacity', '1');
        await expect(source).toHaveCSS('cursor', 'grabbing');
        await expect(source.locator('.bg-info-bg')).toHaveCount(1);
      }
      if (client) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      } else {
        await page.mouse.up();
      }
      const expected = [before[1], before[3], before[4], before[0], before[2]];
      await expect.poll(readOrder).toEqual(expected);
      await expect(tree.locator('[data-layer-dragging]')).toHaveCount(0);
      await expect(tree.locator('[aria-selected="true"]')).toHaveCount(2);
      await expect(tabs).toHaveCount(tabCount);
      await page.locator('[data-canvas-root]').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(readOrder).toEqual(before);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(readOrder).toEqual(expected);
    } finally {
      await client?.detach();
    }
  });
}

for (const count of [1, 2]) {
  for (const input of count === 1
    ? (['mouse'] as const)
    : (['mouse', 'touch'] as const)) {
    test.describe(`cross-Frame Layers drag (${count} sources, ${input})`, () => {
      test.use({ hasTouch: input === 'touch' });
      for (const collapsed of [false, true]) {
        test(`moves into and out of a ${collapsed ? 'collapsed' : 'expanded'} Frame with Layers-focused undo and redo`, async ({
          page,
        }) => {
          test.setTimeout(60_000);
          await openNewCanvas(page);
          await page.keyboard.press('Escape');
          const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
          const persisted = async () => {
            const response = await page.request.get(`/api/canvas/${canvasId}`);
            expect(response.ok(), await response.text()).toBe(true);
            const record = (await response.json()) as GetCanvasResponse;
            return (record.state as { nodes: Node[] }).nodes;
          };
          const execute = async (commands: CanvasCommand[]) => {
            const response = await page.request.post(
              `/api/canvas/${canvasId}/execute`,
              {
                data: {
                  commands,
                  originator: {
                    source: 'agent',
                    threadId: `e2e-group-frame-${count}-${input}`,
                  },
                },
              },
            );
            expect(response.ok(), await response.text()).toBe(true);
          };
          const labels = [
            'Source frame',
            'Move A',
            'Move B',
            'Destination frame',
            'Existing child',
            'Hover node',
          ];
          await execute([
            {
              type: 'CREATE_NODES',
              nodes: labels.map<CanvasNodeCreateInput>((label, index) => ({
                nodeType: label.endsWith('frame') ? 'frame' : 'note',
                data: {
                  label,
                  sizing: 'manual',
                  layoutMode: 'free',
                  heightMode: 'fixed',
                  content: '',
                },
                position: { x: 3000 + index * 450, y: 3000 },
                size: {
                  width: label.endsWith('frame') ? 1200 : 400,
                  height: label.endsWith('frame') ? 600 : 200,
                },
              })),
            },
          ]);
          const created = await persisted();
          const id = (label: string) => {
            const found = created.find((node) => node.data.label === label);
            if (!found) throw new Error(`Missing fixture ${label}`);
            return found.id as CanvasNodeId;
          };
          await execute([
            {
              type: 'SET_NODE_PARENT',
              nodeIds: [id('Move A'), id('Move B')],
              parentId: id('Source frame'),
            },
            {
              type: 'SET_NODE_PARENT',
              nodeIds: [id('Existing child')],
              parentId: id('Destination frame'),
            },
          ]);
          await page
            .getByRole('button', { name: 'Show layers panel', exact: true })
            .click();
          const panel = page.locator('[data-canvas-panel="left"]');
          await expect
            .poll(() =>
              panel.evaluate((element) => element.getBoundingClientRect().left),
            )
            .toBe(0);
          const tree = page.getByRole('tree', { name: 'Layers' });
          const row = (label: string) =>
            tree.locator(`[data-layer-id="${id(label)}"]`);
          const target = row('Destination frame');
          const targetSurface = target.locator(':scope > div.group');
          await expect(tree.getByRole('treeitem')).toHaveCount(6);
          if (collapsed)
            await target
              .getByRole('button', { name: 'Collapse', exact: true })
              .click();
          await row('Move A').click();
          if (count === 2)
            await row('Move B').click({ modifiers: ['ControlOrMeta'] });
          await expect(tree.locator('[aria-selected="true"]')).toHaveCount(
            count,
          );
          const before = await persisted();
          const tabs = await page.getByRole('tab').count();
          const sources = count === 1 ? ['Move A'] : ['Move A', 'Move B'];
          const source = row(count === 1 ? 'Move A' : 'Move B');
          const start = await source.locator('span.truncate').boundingBox();
          const targetBounds = await target.boundingBox();
          const hoverBounds = await row('Hover node').boundingBox();
          if (!start || !targetBounds || !hoverBounds)
            throw new Error('Missing cross-Frame drag bounds');
          const point = {
            x: start.x + start.width / 2,
            y: start.y + start.height / 2,
          };
          const destination = {
            x: point.x,
            y: targetBounds.y + targetBounds.height / 2,
          };
          const client =
            input === 'touch' ? await page.context().newCDPSession(page) : null;
          try {
            if (client) {
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [point],
              });
              await expect(source).toHaveAttribute(
                'data-layer-dragging',
                'true',
              );
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [destination],
              });
            } else {
              await page.mouse.move(point.x, point.y);
              await page.mouse.down();
              await page.mouse.move(
                point.x,
                hoverBounds.y + hoverBounds.height / 2,
                { steps: 8 },
              );
              await expect(tree.locator('[data-layer-dragging]')).toHaveCount(
                count,
              );
              await expect(
                row('Hover node').locator(':scope > div.group'),
              ).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
              await page.mouse.move(destination.x, destination.y, { steps: 8 });
            }
            await expect(tree.locator('[data-layer-dragging]')).toHaveCount(
              count,
            );
            await expect(targetSurface).toHaveCSS(
              'background-color',
              'rgba(0, 0, 0, 0)',
            );
            if (collapsed) {
              await expect(targetSurface).toHaveCSS('outline-style', 'solid');
              await expect(targetSurface).toHaveCSS('outline-width', '1px');
              // Hover beyond the former expansion delay without changing disclosure.
              await page.waitForTimeout(1000);
              await expect(target).toHaveAttribute('aria-expanded', 'false');
              await expect(targetSurface).toHaveCSS('outline-style', 'solid');
              await expect(target.locator('span.right-2')).toHaveCount(0);
            } else {
              await expect(targetSurface).toHaveCSS('outline-style', 'none');
              await expect(target.locator('span.right-2')).toHaveCount(1);
            }
            if (client)
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
              });
            else await page.mouse.up();
            await expect(tree.locator('[data-layer-dragging]')).toHaveCount(0);
            await expect
              .poll(async () =>
                (await persisted())
                  .filter((node) => sources.includes(String(node.data.label)))
                  .map((node) => node.parentId),
              )
              .toEqual(sources.map(() => id('Destination frame')));
            const after = await persisted();
            for (const label of sources) {
              expect(getAbsolutePosition(after, id(label))).toEqual(
                getAbsolutePosition(before, id(label)),
              );
            }
            const destinationLabels = (nodes: Node[]) =>
              nodes
                .filter((node) => node.parentId === id('Destination frame'))
                .map((node) => node.data.label);
            expect(destinationLabels(after)).toEqual([
              'Existing child',
              ...sources,
            ]);
            expect(
              after
                .filter((node) => node.selected)
                .map((node) => node.id)
                .sort(),
            ).toEqual(sources.map(id).sort());
            await expect(tree.locator('[aria-selected="true"]')).toHaveCount(
              collapsed ? 0 : count,
            );
            await expect(target).toHaveAttribute(
              'aria-expanded',
              String(!collapsed),
            );
            await expect(page.getByRole('tab')).toHaveCount(tabs);
            const waitForParentsSave = (parentId: string | undefined) =>
              page.waitForResponse((response) => {
                if (
                  response.request().method() !== 'PUT' ||
                  !response.url().endsWith(`/api/canvas/${canvasId}`)
                )
                  return false;
                const body = response
                  .request()
                  .postDataJSON() as PutCanvasRequest;
                const sourceIds = new Set<string>(sources.map(id));
                const moved = body.state.nodes.filter((node) =>
                  sourceIds.has(node.id),
                );
                return (
                  response.ok() &&
                  moved.length === sources.length &&
                  moved.every(
                    (node) => (node.parentId ?? null) === (parentId ?? null),
                  )
                );
              });
            const undoSaved = waitForParentsSave(id('Source frame'));
            await target.focus();
            await expect(target).toBeFocused();
            await page.keyboard.press('ControlOrMeta+z');
            await undoSaved;
            await expect
              .poll(async () =>
                (await persisted())
                  .filter((node) => sources.includes(String(node.data.label)))
                  .map((node) => node.parentId),
              )
              .toEqual(sources.map(() => id('Source frame')));
            const redoSaved = waitForParentsSave(id('Destination frame'));
            await page.keyboard.press('ControlOrMeta+Shift+z');
            await redoSaved;
            await expect
              .poll(async () => destinationLabels(await persisted()))
              .toEqual(['Existing child', ...sources]);
            await expect(target).toHaveAttribute(
              'aria-expanded',
              String(!collapsed),
            );
            if (input === 'mouse') {
              await row('Hover node').hover();
              await expect(
                row('Hover node').locator(':scope > div.group'),
              ).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            }
            if (collapsed)
              await target
                .getByRole('button', { name: 'Expand', exact: true })
                .click();
            const beforeExit = await persisted();
            const exitStart = await source
              .locator('span.truncate')
              .boundingBox();
            const rootBounds = await row('Hover node').boundingBox();
            if (!exitStart || !rootBounds)
              throw new Error('Missing Frame exit drag bounds');
            const exitPoint = {
              x: exitStart.x + exitStart.width / 2,
              y: exitStart.y + exitStart.height / 2,
            };
            const rootPoint = {
              x: exitPoint.x,
              y: rootBounds.y + 2,
            };
            if (client) {
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [exitPoint],
              });
              await expect(source).toHaveAttribute(
                'data-layer-dragging',
                'true',
              );
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [rootPoint],
              });
            } else {
              await page.mouse.move(exitPoint.x, exitPoint.y);
              await page.mouse.down();
              await page.mouse.move(rootPoint.x, rootPoint.y, { steps: 8 });
            }
            await expect(tree.locator('[data-layer-dragging]')).toHaveCount(
              count,
            );
            await expect(row('Hover node').locator('span.right-2')).toHaveCount(
              1,
            );
            const exitSaved = waitForParentsSave(undefined);
            if (client)
              await client.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
              });
            else await page.mouse.up();
            await exitSaved;
            const exited = await persisted();
            for (const label of sources) {
              expect(
                exited.find((node) => node.id === id(label))?.parentId ?? null,
              ).toBeNull();
              expect(getAbsolutePosition(exited, id(label))).toEqual(
                getAbsolutePosition(beforeExit, id(label)),
              );
            }
            const rootLabels = exited
              .filter((node) => !node.parentId)
              .map((node) => node.data.label);
            expect(
              rootLabels.slice(
                rootLabels.indexOf('Hover node') + 1,
                rootLabels.indexOf('Hover node') + 1 + count,
              ),
            ).toEqual(sources);
            await expect(tree.locator('[aria-selected="true"]')).toHaveCount(
              count,
            );
            await source.focus();
            const exitUndoSaved = waitForParentsSave(id('Destination frame'));
            await page.keyboard.press('ControlOrMeta+z');
            await exitUndoSaved;
            await expect
              .poll(async () => destinationLabels(await persisted()))
              .toEqual(['Existing child', ...sources]);
            const exitRedoSaved = waitForParentsSave(undefined);
            await page.keyboard.press('ControlOrMeta+Shift+z');
            await exitRedoSaved;
            await expect
              .poll(async () =>
                (await persisted())
                  .filter((node) => sources.includes(String(node.data.label)))
                  .map((node) => node.parentId ?? null),
              )
              .toEqual(sources.map(() => null));
          } finally {
            await client?.detach();
          }
        });
      }
    });
  }
}

test('taps Layers to activate, long-presses to reorder, and swipes to scroll without reordering', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: Array.from({ length: 40 }, (_, index) => ({
            nodeType: 'note',
            data: { label: `Touch layer ${index}`, content: '' },
            position: { x: 3000 + index * 450, y: 3000 },
            size: { width: 400, height: 200 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-layers-touch' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator('[data-canvas-panel="left"]')
        .evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(0);
  const tree = page.getByRole('tree', { name: 'Layers' });
  const rows = tree.getByRole('treeitem');
  await expect(rows).toHaveCount(40);
  const scrollHost = tree.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]',
  );
  const readOrder = () =>
    rows.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-layer-id')),
    );
  const before = await readOrder();
  const client = await page.context().newCDPSession(page);
  try {
    const first = rows.first();
    const label = await first.locator('span.truncate').innerText();
    const start = await first.locator('span.truncate').boundingBox();
    if (!start) throw new Error('Missing touch activation bounds');
    const point = {
      x: start.x + start.width / 2,
      y: start.y + start.height / 2,
    };
    await touchTap(client, point);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('tab', { name: new RegExp(label) }),
    ).toBeVisible();
    expect(await readOrder()).toEqual(before);
    const tabs = page.getByRole('tab');
    const tabCount = await tabs.count();

    const destination = await rows.nth(1).boundingBox();
    if (!destination) throw new Error('Missing touch reorder destination');
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    });
    await page.waitForTimeout(100);
    await expect(first).toHaveCSS('opacity', '1');
    await expect(first).not.toHaveAttribute('data-layer-dragging');
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x + 3, y: point.y }],
    });
    await expect(first).toHaveAttribute('data-layer-dragging', 'true');
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: destination.y + destination.height - 2 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    const reordered = [before[1], before[0], ...before.slice(2)];
    await expect.poll(readOrder).toEqual(reordered);
    await expect(tabs).toHaveCount(tabCount);
    await expect(scrollHost).toHaveJSProperty('scrollTop', 0);

    const swipeRow = await rows.nth(6).locator('span.truncate').boundingBox();
    if (!swipeRow) throw new Error('Missing touch scroll bounds');
    await oneFingerDrag(
      client,
      {
        x: swipeRow.x + swipeRow.width / 2,
        y: swipeRow.y + swipeRow.height / 2,
      },
      0,
      -160,
    );
    await expect
      .poll(() => scrollHost.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(50);
    await page.waitForTimeout(300);
    expect(await readOrder()).toEqual(reordered);
    await expect(tree.locator('[data-layer-dragging]')).toHaveCount(0);
    await expect(tabs).toHaveCount(tabCount);
  } finally {
    await client.detach();
  }
});

test('keeps type filters on one line and preserves overflow selections during resize', async ({
  page,
}, testInfo) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            'note',
            'text',
            'image',
            'pdf',
            'video',
            'web',
            'frame',
            'question',
          ].map((nodeType, index) => ({
            nodeType,
            data: { label: `Filter ${nodeType}`, content: '' },
            position: { x: 2000 + index * 500, y: 2000 },
            size: { width: 400, height: 200 },
          })),
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-layer-filter-overflow' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  const panel = page.locator('[data-canvas-panel="left"]');
  await expect
    .poll(() =>
      panel.evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(0);
  const handle = panel.getByRole('separator');
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error('Missing sidebar resize handle');
  await page.mouse.move(handleBounds.x + 2, handleBounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x - 100, handleBounds.y + 120, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(() => panel.evaluate((element) => element.clientWidth))
    .toBe(200);

  const bar = panel.locator('[data-layer-filter-bar]');
  const chips = bar.locator('[data-layer-filter-key]');
  const more = bar.getByRole('button', { name: /^More filters/ });
  await expect(more).toBeVisible();
  await expect(chips).toHaveCount(4);
  const chipLayout = await bar.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('[data-layer-filter-chips]');
    if (!row) throw new Error('Missing filter chip row');
    return {
      height: element.getBoundingClientRect().height,
      fits: row.scrollWidth <= row.clientWidth,
      tops: [...row.querySelectorAll('button')].map(
        (button) => button.getBoundingClientRect().top,
      ),
    };
  });
  expect(chipLayout).toMatchObject({ height: 32, fits: true });
  expect(new Set(chipLayout.tops).size).toBe(1);
  await expect(
    bar.getByRole('button', { name: 'Collapse all frames' }),
  ).toBeVisible();

  const alignment = await panel.evaluate((element) => {
    const header = element.querySelector('header');
    const logo = header?.querySelector('button');
    const logoImage = logo?.querySelector('img');
    const headerButtons = header?.querySelectorAll('button');
    const headerToggle = headerButtons?.[headerButtons.length - 1];
    const search = element.querySelector(
      '[data-canvas-search-input]',
    )?.parentElement;
    const filterBar = element.querySelector('[data-layer-filter-bar]');
    const filters = filterBar?.querySelectorAll('button');
    const firstIcon = filters?.[0]?.querySelector('svg');
    const lastIcon = filters?.[filters.length - 1]?.querySelector('svg');
    const toggleIcon = headerToggle?.querySelector('svg');
    if (
      !header ||
      !logo ||
      !logoImage ||
      !headerToggle ||
      !search ||
      !firstIcon ||
      !lastIcon ||
      !toggleIcon
    )
      throw new Error('Missing sidebar alignment controls');
    const centerX = (control: Element) => {
      const bounds = control.getBoundingClientRect();
      return bounds.left + bounds.width / 2;
    };
    return {
      paddingLeft: getComputedStyle(header).paddingLeft,
      paddingRight: getComputedStyle(header).paddingRight,
      logoWidth: logo.getBoundingClientRect().width,
      logoImageWidth: logoImage.getBoundingClientRect().width,
      logoImageHeight: logoImage.getBoundingClientRect().height,
      offsets: [
        centerX(logoImage) - centerX(firstIcon),
        centerX(toggleIcon) - centerX(lastIcon),
        logo.getBoundingClientRect().left - search.getBoundingClientRect().left,
        headerToggle.getBoundingClientRect().right -
          search.getBoundingClientRect().right,
      ],
    };
  });
  expect(alignment).toMatchObject({
    paddingLeft: '12px',
    paddingRight: '12px',
    logoWidth: 24,
    logoImageWidth: 20,
    logoImageHeight: 20,
  });
  for (const offset of alignment.offsets) expect(offset).toBeCloseTo(0, 3);

  const spacing = await panel.evaluate((element) => {
    const tree = element.querySelector('[role="tree"]');
    const rows = tree?.querySelectorAll('[role="treeitem"]');
    const first = rows?.[0];
    const second = rows?.[1];
    const firstSurface = first?.querySelector('.group');
    const secondSurface = second?.querySelector('.group');
    const filterButton = element.querySelector(
      '[data-layer-filter-bar] button',
    );
    if (
      !tree ||
      !first ||
      !second ||
      !firstSurface ||
      !secondSurface ||
      !filterButton
    )
      throw new Error('Missing sidebar spacing controls');
    const firstBounds = firstSurface.getBoundingClientRect();
    const secondBounds = secondSurface.getBoundingClientRect();
    return {
      rowHeights: [
        first.getBoundingClientRect().height,
        second.getBoundingClientRect().height,
      ],
      surfaceHeights: [firstBounds.height, secondBounds.height],
      rowGap: secondBounds.top - firstBounds.bottom,
      filterToFirstSurface:
        firstBounds.top - filterButton.getBoundingClientRect().bottom,
      treePaddingTop: getComputedStyle(tree).paddingTop,
      treePaddingBottom: getComputedStyle(tree).paddingBottom,
    };
  });
  expect(spacing).toEqual({
    rowHeights: [34, 34],
    surfaceHeights: [32, 32],
    rowGap: 2,
    filterToFirstSurface: 9,
    treePaddingTop: '0px',
    treePaddingBottom: '0px',
  });

  const filterIcons = bar.locator('svg');
  const themeColor = (token: '--fg-subtle' | '--info') =>
    page.evaluate((token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);
  for (const icon of await filterIcons.all()) {
    await expect(icon).toHaveCSS('width', '14px');
    await expect(icon).toHaveCSS('height', '14px');
    await expect(icon).toHaveCSS('stroke-width', '2px');
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    const subtleColor = await themeColor('--fg-subtle');
    for (const icon of await filterIcons.all()) {
      await expect(icon).toHaveCSS('color', subtleColor);
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  for (const button of await bar.locator('button').all()) {
    await expect(button).toHaveCSS('width', '24px');
    await expect(button).toHaveCSS('height', '24px');
  }

  await more.click();
  const filter = page.getByRole('menuitem', { name: /^Filter by / }).first();
  const overflowIcon = filter.locator('svg').first();
  await expect(overflowIcon).toHaveCSS('width', '14px');
  await expect(overflowIcon).toHaveCSS('height', '14px');
  await expect(overflowIcon).toHaveCSS('stroke-width', '2px');
  await expect(overflowIcon).toHaveCSS('color', 'rgb(118, 118, 118)');
  const filterName = (await filter.getAttribute('aria-label'))?.replace(
    'Filter by ',
    '',
  );
  if (!filterName) throw new Error('Missing overflow filter label');
  await filter.click();
  await expect(more).toHaveAccessibleName('More filters (1 active)');
  await expect(
    page.getByRole('menuitem', {
      name: `Stop filtering by ${filterName}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('sidebar-filter-overflow.png'),
  });

  const narrowHandleBounds = await handle.boundingBox();
  if (!narrowHandleBounds) throw new Error('Missing sidebar resize handle');
  await page.mouse.move(narrowHandleBounds.x + 2, narrowHandleBounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(
    narrowHandleBounds.x + 180,
    narrowHandleBounds.y + 120,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(chips).toHaveCount(8);
  await expect(more).toHaveCount(0);
  await expect(
    bar.getByRole('button', {
      name: `Stop filtering by ${filterName}`,
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  const infoColor = await themeColor('--info');
  await expect(
    bar
      .getByRole('button', {
        name: `Stop filtering by ${filterName}`,
        exact: true,
      })
      .locator('svg'),
  ).toHaveCSS('color', infoColor);
});

test('matches header icon color, size and stroke in both panel states and themes', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');

  for (const collapsed of [true, false]) {
    if (!collapsed) {
      await page
        .getByRole('button', { name: 'Show layers panel', exact: true })
        .click();
    }
    await page.mouse.move(700, 500);
    const icons = [
      page
        .getByRole('button', { name: 'Space menu', exact: true })
        .locator('svg'),
      page
        .getByRole('button', {
          name: collapsed ? 'Show layers panel' : 'Collapse layers panel',
          exact: true,
        })
        .locator('svg'),
    ];
    for (const icon of icons) {
      expect(
        await icon.evaluate((element) => ({
          color: getComputedStyle(element).color,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          strokeWidth: getComputedStyle(element).strokeWidth,
        })),
      ).toEqual({
        color: 'rgb(118, 118, 118)',
        width: 16,
        height: 16,
        strokeWidth: '2px',
      });
    }
  }

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  const menu = page
    .getByRole('button', { name: 'Space menu', exact: true })
    .locator('svg');
  const collapse = page
    .getByRole('button', { name: 'Collapse layers panel', exact: true })
    .locator('svg');
  const subtleColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--fg-subtle')
      .trim(),
  );
  await expect(menu).toHaveCSS('color', subtleColor);
  await expect(collapse).toHaveCSS('color', subtleColor);
});

test.describe('mouse header controls', () => {
  test.use({ hasTouch: false });

  test('joins the Space title and menu arrow without changing rename or menu behavior', async ({
    page,
  }, testInfo) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(() => matchMedia('(hover: hover)').matches),
    ).toBe(true);
    const title = page.getByRole('textbox', {
      name: 'Space title',
      exact: true,
    });
    const menu = page.getByRole('button', {
      name: 'Space menu',
      exact: true,
    });
    const group = page.getByRole('group', {
      name: 'Space title',
      exact: true,
    });
    const divider = group.locator(':scope > div');
    await page.mouse.move(700, 500);
    await expect(group).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(divider).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
    const geometry = await group.evaluate((element) => {
      const field = element.querySelector('input');
      const trigger = element.querySelector('button');
      const sizer = element.querySelector('span[aria-hidden]');
      const arrow = trigger?.querySelector('svg');
      if (!field || !trigger || !sizer || !arrow)
        throw new Error('Missing segmented title controls');
      const bounds = element.getBoundingClientRect();
      const fieldBounds = field.getBoundingClientRect();
      const triggerBounds = trigger.getBoundingClientRect();
      const fieldStyle = getComputedStyle(field);
      const sizerStyle = getComputedStyle(sizer);
      return {
        height: bounds.height,
        fieldHeight: fieldBounds.height,
        triggerHeight: triggerBounds.height,
        triggerWidth: triggerBounds.width,
        arrowLeftInset: arrow.getBoundingClientRect().left - triggerBounds.left,
        fieldPadding: [
          fieldStyle.paddingTop,
          fieldStyle.paddingRight,
          fieldStyle.paddingBottom,
          fieldStyle.paddingLeft,
        ],
        sizerPadding: [sizerStyle.paddingRight, sizerStyle.paddingLeft],
        fontSizes: [fieldStyle.fontSize, sizerStyle.fontSize],
        lineHeights: [fieldStyle.lineHeight, sizerStyle.lineHeight],
        fontWeights: [fieldStyle.fontWeight, sizerStyle.fontWeight],
        dividerWidth: triggerBounds.left - fieldBounds.right,
        radius: getComputedStyle(element).borderRadius,
        background: getComputedStyle(element).backgroundColor,
      };
    });
    expect(geometry).toMatchObject({
      height: 28,
      fieldHeight: 28,
      triggerHeight: 28,
      triggerWidth: 24,
      arrowLeftInset: 2,
      fieldPadding: ['2px', '2px', '2px', '6px'],
      sizerPadding: ['2px', '6px'],
      fontSizes: ['15px', '15px'],
      lineHeights: ['24px', '24px'],
      fontWeights: ['500', '500'],
      dividerWidth: 1,
      radius: '6px',
    });
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    await title.hover();
    await expect(group).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(divider).not.toHaveCSS(
      'border-left-color',
      'rgba(0, 0, 0, 0)',
    );

    await title.fill('Segmented title');
    await title.press('Enter');
    await expect(title).toHaveValue('Segmented title');
    await menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Export Space' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await page.mouse.move(700, 500);
    await expect(group).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(divider).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');

    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);
      await title.hover();
      await expect(group).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await group.screenshot({
        path: testInfo.outputPath(`space-title-${theme}.png`),
      });
      await page.mouse.move(700, 500);
      await expect(group).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }

    await title.fill(
      'A very long Space title that must never hide the menu arrow',
    );
    await title.press('Enter');
    await expect(menu).toBeVisible();
    expect(
      await group.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const headerSlot = element.parentElement?.getBoundingClientRect();
        const trigger = element
          .querySelector('button')
          ?.getBoundingClientRect();
        return {
          groupFits: !!headerSlot && bounds.right <= headerSlot.right,
          arrowFits: !!trigger && trigger.right <= bounds.right,
        };
      }),
    ).toEqual({ groupFits: true, arrowFits: true });

    for (const collapsed of [true, false]) {
      if (!collapsed) {
        await page
          .getByRole('button', { name: 'Show layers panel', exact: true })
          .click();
      }
      await expect(title).toHaveCSS('font-size', '15px');
      await expect(title).toHaveCSS('font-weight', '500');
      await expect(title).toHaveCSS('line-height', '24px');
      const toggle = page.getByRole('button', {
        name: collapsed ? 'Show layers panel' : 'Collapse layers panel',
        exact: true,
      });
      expect(
        await toggle.evaluate((button) => {
          const header = button.closest('header');
          const titleGroup = header?.querySelector('[role="group"]');
          const logo = header?.querySelector('button');
          const logoImage = logo?.querySelector('img');
          if (!header || !titleGroup || !logo || !logoImage)
            throw new Error('Missing horizontal header controls');
          const headerStyle = getComputedStyle(header);
          return {
            height: header.getBoundingClientRect().height,
            paddingLeft: headerStyle.paddingLeft,
            paddingRight: headerStyle.paddingRight,
            paddingTop: headerStyle.paddingTop,
            paddingBottom: headerStyle.paddingBottom,
            titleTopInset:
              titleGroup.getBoundingClientRect().top -
              header.getBoundingClientRect().top,
            gap: headerStyle.columnGap,
            logoWidth: logo.getBoundingClientRect().width,
            logoHeight: logo.getBoundingClientRect().height,
            logoImageWidth: logoImage.getBoundingClientRect().width,
            logoImageHeight: logoImage.getBoundingClientRect().height,
            logoCenterOffset:
              logoImage.getBoundingClientRect().left +
              logoImage.getBoundingClientRect().width / 2 -
              (logo.getBoundingClientRect().left +
                logo.getBoundingClientRect().width / 2),
            logoToTitle:
              titleGroup.getBoundingClientRect().left -
              logo.getBoundingClientRect().right,
            logoImageToTitle:
              titleGroup.getBoundingClientRect().left -
              logoImage.getBoundingClientRect().right,
            logoVerticalCenterOffset:
              logoImage.getBoundingClientRect().top +
              logoImage.getBoundingClientRect().height / 2 -
              (titleGroup.getBoundingClientRect().top +
                titleGroup.getBoundingClientRect().height / 2),
            titleToToggle:
              button.getBoundingClientRect().left -
              titleGroup.getBoundingClientRect().right,
          };
        }),
      ).toEqual({
        height: collapsed ? 40 : 44,
        paddingLeft: collapsed ? '8px' : '12px',
        paddingRight: collapsed ? '8px' : '12px',
        paddingTop: '0px',
        paddingBottom: '0px',
        titleTopInset: collapsed ? 6 : 8,
        gap: '2px',
        logoWidth: 24,
        logoHeight: 24,
        logoImageWidth: 20,
        logoImageHeight: 20,
        logoCenterOffset: 0,
        logoToTitle: 2,
        logoImageToTitle: 4,
        logoVerticalCenterOffset: 0,
        titleToToggle: 12,
      });
      await toggle.locator('xpath=ancestor::header').screenshot({
        path: testInfo.outputPath(
          `canvas-header-${collapsed ? 'collapsed' : 'expanded'}.png`,
        ),
      });
    }
  });
});
