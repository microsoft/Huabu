// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import {
  openNewCanvas,
  paneCenter,
  readViewportTransform,
  touchTap,
} from './helpers';

async function savedTool(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('huabu-sketch-tools') ?? '{}').state
        ?.mouseToolPreference,
  );
}

async function expectTool(page: Page, tool: string) {
  await expect(
    page.getByRole('button', { name: new RegExp(`^${tool} \\(`) }).first(),
  ).toHaveAttribute('aria-pressed', 'true');
}

async function mouseCanvas(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('huabu-sketch-tools')) {
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({
          version: 4,
          state: {
            inputModePreference: 'mouse',
            mouseToolPreference: 'select',
          },
        }),
      );
    }
  });
  await openNewCanvas(page);
  await expect(page.locator('.canvas-pending-note')).toBeVisible();
}

function translation(transform: string) {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);
  if (!match) throw new Error(`Unexpected viewport transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

test('mouse preference survives Space switches, reload, and one-shot initial intent', async ({
  page,
}) => {
  await mouseCanvas(page);
  await page.keyboard.press('p');
  await expectTool(page, 'Pan');
  const first = page.url();
  await page.reload();
  await expectTool(page, 'Pan');
  await expect(page.locator('.canvas-pending-note')).toHaveCount(0);
  await openNewCanvas(page);
  await expect(page.locator('.canvas-pending-note')).toBeVisible();
  expect(await savedTool(page)).toBe('pan');
  await page.keyboard.press('Escape');
  await expectTool(page, 'Pan');
  await page.goto(first);
  await expectTool(page, 'Pan');
});

for (const preferred of ['Pan', 'Lasso']) {
  test(`${preferred} returns after placement, tool cancellation, and resource modal cancellation`, async ({
    page,
  }) => {
    await mouseCanvas(page);
    await page.keyboard.press(preferred === 'Pan' ? 'p' : 'l');
    for (const [name, pending] of [
      ['Note', 'note'],
      ['Text', 'text'],
      ['Frame', 'frame'],
    ] as const) {
      await page
        .getByRole('button', { name: new RegExp(`^${name} \\(`) })
        .click();
      await expect(page.locator(`.canvas-pending-${pending}`)).toBeVisible();
      expect(await savedTool(page)).toBe(preferred.toLowerCase());
      const center = await paneCenter(page);
      if (pending === 'frame') {
        await page.mouse.move(center.x - 100, center.y - 100);
        await page.mouse.down();
        await page.mouse.move(center.x + 100, center.y + 100, { steps: 8 });
        await page.mouse.up();
      } else {
        await page.mouse.click(center.x, center.y);
      }
      await expect(
        page.locator(`.react-flow__node-${pending}`).first(),
      ).toBeVisible();
      await expect(page.locator(`.canvas-pending-${pending}`)).toHaveCount(0);
      await expectTool(page, preferred);
      await page.locator('[data-canvas-root]').focus();
      await page.keyboard.press('Delete');
      await expect(page.locator('.react-flow__node')).toHaveCount(0);
    }
    for (const key of ['1', '2', '3', '5', 'a']) {
      await page.keyboard.press(key);
      await page.keyboard.press('Escape');
      await expectTool(page, preferred);
      expect(await savedTool(page)).toBe(preferred.toLowerCase());
    }
    await page.keyboard.press('1');
    await page.keyboard.press('1');
    await expectTool(page, preferred);
    await page
      .getByRole('button', { name: 'Add Content', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Add Links', exact: true })
      .click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expectTool(page, preferred);
  });
}

test('native left/middle and both Space release orders stop before neutral pointer motion', async ({
  page,
}) => {
  await mouseCanvas(page);
  await page.keyboard.press('p');
  for (const button of ['left', 'middle'] as const) {
    const center = await paneCenter(page);
    const before = translation(await readViewportTransform(page));
    await page.mouse.move(center.x, center.y);
    await page.mouse.down({ button });
    await page.mouse.move(center.x + 65, center.y + 40, { steps: 8 });
    await page.mouse.up({ button });
    await expect
      .poll(async () => translation(await readViewportTransform(page)))
      .toEqual({ x: before.x + 65, y: before.y + 40 });
    const released = await readViewportTransform(page);
    await page.mouse.move(center.x + 130, center.y + 85, { steps: 5 });
    expect(await readViewportTransform(page)).toBe(released);
    expect(await savedTool(page)).toBe('pan');
  }
  await page.keyboard.press('l');
  for (const spaceFirst of [true, false]) {
    const center = await paneCenter(page);
    await page.keyboard.down('Space');
    await expectTool(page, 'Pan');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 60, center.y + 30, { steps: 8 });
    if (spaceFirst) await page.keyboard.up('Space');
    await page.mouse.up();
    if (!spaceFirst) await page.keyboard.up('Space');
    await expectTool(page, 'Lasso');
    const released = await readViewportTransform(page);
    await page.mouse.move(center.x + 120, center.y + 70, { steps: 5 });
    expect(await readViewportTransform(page)).toBe(released);
    expect(await savedTool(page)).toBe('lasso');
  }
});

test('a saved mouse Pan is hidden for touch placement and restored on the next mouse contact', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('p');
  await expectTool(page, 'Pan');
  await page.keyboard.press('2');
  const client = await page.context().newCDPSession(page);
  await touchTap(client, await paneCenter(page));
  await expect(page.locator('.react-flow__node-text')).toHaveCount(1);
  await expect(page.locator('.canvas-pending-text')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Pan \(/ })).toHaveCount(0);
  expect(await savedTool(page)).toBe('pan');
  await page.mouse.click(
    (await paneCenter(page)).x + 250,
    (await paneCenter(page)).y + 180,
  );
  await expectTool(page, 'Pan');
});

test('Question and child-Space completion restore Pan without writing Select', async ({
  page,
}) => {
  await mouseCanvas(page);
  await page.keyboard.press('p');
  await page.getByRole('button', { name: /^Add Agent Node/ }).click();
  await page.mouse.click(
    (await paneCenter(page)).x,
    (await paneCenter(page)).y,
  );
  await expect(page.locator('.react-flow__node-question')).toHaveCount(1);
  await expectTool(page, 'Pan');
  await page
    .getByRole('button', { name: 'Collapse previews', exact: true })
    .click();
  await page.locator('[data-canvas-root]').focus();
  await page.keyboard.press('5');
  const center = await paneCenter(page);
  await page.mouse.click(center.x + 300, center.y + 180);
  await expect(page.locator('.react-flow__node-spacePreview')).toHaveCount(1);
  await expectTool(page, 'Pan');
  expect(await savedTool(page)).toBe('pan');
});

test('a saved Lasso claims the first mouse press after touch placement without auto-arming touch Lasso', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('l');
  await page.keyboard.press('2');
  const client = await page.context().newCDPSession(page);
  await touchTap(client, await paneCenter(page));
  const text = page.locator('.react-flow__node-text');
  await expect(text).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Lasso', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  expect(await savedTool(page)).toBe('lasso');
  const bounds = await text.boundingBox();
  if (!bounds) throw new Error('Placed Text has no bounds');
  await page.mouse.move(bounds.x - 20, bounds.y - 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y - 20, {
    steps: 4,
  });
  await page.mouse.move(
    bounds.x + bounds.width + 20,
    bounds.y + bounds.height + 20,
    { steps: 4 },
  );
  await page.mouse.move(bounds.x - 20, bounds.y + bounds.height + 20, {
    steps: 4,
  });
  await page.mouse.move(bounds.x - 20, bounds.y - 20, { steps: 4 });
  await page.mouse.up();
  await expect(text).toHaveClass(/selected/);
  await expectTool(page, 'Lasso');
});

test('browser sibling preference changes preserve placement and explicit Lasso sessions', async ({
  page,
  context,
}) => {
  await mouseCanvas(page);
  await page.keyboard.press('p');
  const sibling = await context.newPage();
  try {
    await sibling.goto(page.url());
    await sibling.waitForSelector('.react-flow__pane');
    await expectTool(sibling, 'Pan');
    await sibling.keyboard.press('1');
    await page.keyboard.press('l');
    await expect(sibling.locator('.canvas-pending-note')).toBeVisible();
    await sibling.keyboard.press('Escape');
    await expectTool(sibling, 'Lasso');
    await sibling.keyboard.press('l');
    await page.keyboard.press('p');
    await expect.poll(() => savedTool(sibling)).toBe('pan');
    await expectTool(sibling, 'Lasso');
    await sibling.keyboard.press('1');
    await sibling.keyboard.press('Escape');
    await expectTool(sibling, 'Pan');
  } finally {
    await sibling.close();
  }
});

test('a newer tool choice during Space Pan waits for native release without restoring stale Lasso', async ({
  page,
}) => {
  await mouseCanvas(page);
  await page.keyboard.press('l');
  const center = await paneCenter(page);
  await page.keyboard.down('Space');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 50, center.y + 30);
  await page.keyboard.press('s');
  await page.keyboard.up('Space');
  await expectTool(page, 'Pan');
  await page.mouse.up();
  await expectTool(page, 'Select');
  const released = await readViewportTransform(page);
  await page.mouse.move(center.x + 100, center.y + 80);
  expect(await readViewportTransform(page)).toBe(released);
  expect(await savedTool(page)).toBe('select');
});
