// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Missing specimen geometry');
  return box;
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = await bounds(handle);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 },
  );
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/playground/design#selection-frame');
  await expect(page.locator('[data-selection-study]')).toBeVisible();
  await page
    .locator('#selection-frame')
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
});

test('image corners preserve ratio and the connector stays visible away from hover', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  const image = study.locator('[data-study-node="image"]');
  await expect(image.locator('[data-study-resize]')).toHaveCount(4);
  const before = await bounds(image);
  await drag(page, image.locator('[data-study-resize="br"]'), 70, 30);
  const after = await bounds(image);
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.width / after.height).toBeCloseTo(
    before.width / before.height,
    2,
  );
  const connector = study.getByRole('button', {
    name: 'Connect from Image right',
    exact: true,
  });
  const controlBefore = await bounds(connector);
  await page.mouse.move(5, 5);
  await expect(connector).toBeVisible();
  expect(await bounds(connector)).toEqual(controlBefore);
  const dot = await bounds(connector.locator('.selection-study__port-dot'));
  expect(dot.x + dot.width / 2 - after.x - after.width).toBeCloseTo(24, 1);
  const coarse = await page.evaluate(
    () => matchMedia('(pointer: coarse)').matches,
  );
  await connector.blur();
  await expect(connector.locator('.selection-study__port-dot')).toHaveCSS(
    'width',
    coarse ? '14px' : '8px',
  );
  await connector.hover();
  await expect(connector.locator('.selection-study__port-dot')).toHaveCSS(
    'width',
    coarse ? '22px' : '20px',
  );
  await expect(connector.locator('svg')).toHaveCSS('opacity', '1');
  expect(await bounds(connector)).toEqual(controlBefore);
  const hotDot = await bounds(connector.locator('.selection-study__port-dot'));
  expect(hotDot.x + hotDot.width / 2).toBeCloseTo(dot.x + dot.width / 2, 1);
  await page.mouse.move(5, 5);
  await expect(connector.locator('svg')).toHaveCSS('opacity', '0');
});

test('text changes wrapping without changing font and supports explicit font choice', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  await study.getByRole('button', { name: 'Free text', exact: true }).click();
  const text = study.locator('[data-study-node="text"]');
  const body = text.locator('[data-study-body]');
  await study
    .getByRole('textbox', { name: 'Text specimen content' })
    .fill(
      'A longer idea that wraps across several lines while its font size stays unchanged.',
    );
  await expect(text.locator('[data-study-resize]')).toHaveCount(2);
  const before = await bounds(text);
  await drag(page, text.locator('[data-study-resize="right"]'), -100, 0);
  await expect(body).toHaveCSS('font-size', '28px');
  await expect
    .poll(async () => (await bounds(text)).height)
    .toBeGreaterThan(before.height);
  expect((await bounds(text)).width).toBeCloseTo(before.width - 100, 0);
  await study
    .getByRole('button', { name: 'Text font size', exact: true })
    .click();
  await page.getByRole('option', { name: '20px', exact: true }).click();
  await expect(body).toHaveCSS('font-size', '20px');
});

test('connection drag reaches the node body and keyboard connection can cancel', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  const connector = study.getByRole('button', {
    name: 'Connect from Image right',
    exact: true,
  });
  const from = await bounds(connector);
  const to = await bounds(study.locator('[data-study-body="text"]'));
  await drag(
    page,
    connector,
    to.x + to.width / 2 - from.x - from.width / 2,
    to.y + to.height / 2 - from.y - from.height / 2,
  );
  await expect(study.locator('[data-study-link]')).toHaveCount(1);
  await connector.focus();
  await page.keyboard.press('Enter');
  await expect(connector).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(connector).toHaveAttribute('aria-pressed', 'false');
  await expect(study.locator('[data-study-link]')).toHaveCount(1);
});

test('controls retain screen sizes and resize tracks scaled pointer movement', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  const connector = study.getByRole('button', {
    name: 'Connect from Image right',
    exact: true,
  });
  const initial = await bounds(connector);
  await study.getByRole('button', { name: 'Study zoom', exact: true }).click();
  await page.getByRole('option', { name: '50%', exact: true }).click();
  expect((await bounds(connector)).width).toBeCloseTo(initial.width, 1);
  const image = await bounds(study.locator('[data-study-node="image"]'));
  const control = await bounds(connector.locator('.selection-study__port-dot'));
  expect(control.x + control.width / 2 - image.x - image.width).toBeCloseTo(
    24,
    1,
  );
  await study.getByRole('button', { name: 'Card', exact: true }).click();
  const card = study.locator('[data-study-node="card"]');
  const before = await bounds(card);
  await drag(page, card.locator('[data-study-resize="br"]'), 40, 10);
  const after = await bounds(card);
  expect(after.width - before.width).toBeCloseTo(40, 0);
  expect(after.height - before.height).toBeCloseTo(10, 0);
});

test('four selected ports sit 24px outside and text width handles do not overlap their hit areas', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  await study.getByRole('button', { name: 'Free text', exact: true }).click();
  for (const zoom of ['100%', '50%']) {
    await study
      .getByRole('button', { name: 'Study zoom', exact: true })
      .click();
    await page.getByRole('option', { name: zoom, exact: true }).click();
    await expect(study.locator('[data-study-port]')).toHaveCount(4);
    const node = study.locator('[data-selected="true"]');
    const box = await bounds(node);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const port = node.locator(`[data-study-port="${side}"]`);
      const dot = await bounds(port.locator('.selection-study__port-dot'));
      expect(dot.x + dot.width / 2).toBeCloseTo(
        side === 'left'
          ? box.x - 24
          : side === 'right'
            ? box.x + box.width + 24
            : box.x + box.width / 2,
        1,
      );
      expect(dot.y + dot.height / 2).toBeCloseTo(
        side === 'top'
          ? box.y - 24
          : side === 'bottom'
            ? box.y + box.height + 24
            : box.y + box.height / 2,
        1,
      );
      if (side === 'left' || side === 'right') {
        const handle = node.locator(`[data-study-resize="${side}"]`);
        await handle.hover();
        await expect(handle).toHaveCSS('cursor', 'ew-resize');
        const h = await bounds(handle);
        const p = await bounds(port);
        expect(
          side === 'right' ? p.x - h.x - h.width : h.x - p.x - p.width,
        ).toBeGreaterThan(0);
      }
    }
  }
});

test('resize hides ports until release or cancellation and keeps the width cursor', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  for (const label of ['Image', 'Free text', 'Card']) {
    await study.getByRole('button', { name: label, exact: true }).click();
    const handle = study.locator(
      `[data-selected="true"] [data-study-resize="${label === 'Free text' ? 'right' : 'br'}"]`,
    );
    for (const finish of ['release', 'escape', 'cancel', 'capture-loss']) {
      await handle.scrollIntoViewIfNeeded();
      const box = await bounds(handle);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await expect(
        study.locator('[data-study-port]'),
        `${label}: start ${finish}`,
      ).toHaveCount(0);
      await page.mouse.move(
        box.x + box.width / 2 + 12,
        box.y + box.height / 2 + 8,
      );
      await expect(study.locator('[data-study-port]')).toHaveCount(0);
      if (label === 'Free text')
        await expect(study.getByRole('application')).toHaveCSS(
          'cursor',
          'ew-resize',
        );
      if (finish === 'escape') await page.keyboard.press('Escape');
      if (finish === 'cancel')
        await handle.dispatchEvent('pointercancel', { pointerId: 1 });
      if (finish === 'capture-loss')
        await handle.evaluate((el) => {
          if (el.hasPointerCapture(1)) el.releasePointerCapture(1);
        });
      if (finish === 'capture-loss')
        await page.mouse.move(
          box.x + box.width / 2 + 13,
          box.y + box.height / 2 + 8,
        );
      if (finish !== 'release')
        await expect(
          study.locator('[data-study-port]'),
          `${label}: ${finish}`,
        ).toHaveCount(4);
      await page.mouse.up();
      await expect(study.locator('[data-study-port]')).toHaveCount(4);
    }
  }
});

test('resize hover and focus never paint the hit box or an extra grip frame', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  const handle = study.locator(
    '[data-study-node="image"] [data-study-resize="br"]',
  );
  await handle.scrollIntoViewIfNeeded();
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveCSS('outline-style', 'none');
  await expect(handle.locator('span')).toHaveCSS('outline-style', 'none');
  await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await handle.hover();
  await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const box = await bounds(handle);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(handle).toHaveCSS('outline-style', 'none');
  await expect(handle).toHaveCSS('box-shadow', 'none');
  await expect(handle.locator('span')).toHaveCSS('outline-style', 'none');
  await page.mouse.move(
    box.x + box.width / 2 + 20,
    box.y + box.height / 2 + 12,
  );
  await page.mouse.up();
  await expect(handle).toHaveCSS('outline-style', 'none');
  await expect(handle.locator('span')).toHaveCSS('outline-style', 'none');
  const port = study.locator(
    '[data-study-node="image"] [data-study-port="right"]',
  );
  await port.hover();
  await port.focus();
  await expect(port).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(port).toHaveCSS('outline-style', 'none');
});

test('selected body and external controls do not activate an overlapping lower node', async ({
  page,
}) => {
  const study = page.locator('[data-selection-study]');
  await study
    .getByRole('button', { name: 'Overlap test', exact: true })
    .click();
  const image = study.locator('[data-study-node="image"]');
  const card = study.locator('[data-study-node="card"]');
  const original = await bounds(card);
  await card.evaluate((el) => {
    el.setAttribute('data-events', '0');
    for (const name of ['pointerdown', 'click', 'dblclick'])
      el.addEventListener(name, () =>
        el.setAttribute(
          'data-events',
          String(Number(el.getAttribute('data-events')) + 1),
        ),
      );
  });
  const body = await bounds(image);
  await page.mouse.click(body.x + body.width - 30, body.y + 60);
  await expect(image).toHaveAttribute('data-selected', 'true');
  const port = image.locator('[data-study-port="right"]');
  await port.click();
  await expect(port).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await drag(page, image.locator('[data-study-resize="br"]'), 24, 16);
  await expect(image).toHaveAttribute('data-selected', 'true');
  await expect(card).toHaveAttribute('data-events', '0');
  expect(await bounds(card)).toEqual(original);
});
