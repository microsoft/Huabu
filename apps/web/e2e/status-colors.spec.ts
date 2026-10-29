// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ hasTouch: false });

const tones = ['success', 'warning', 'danger'] as const;

async function reference(page: Page, token: string) {
  return page.evaluate((token) => {
    const element = document.createElement('span');
    element.style.color = `var(--${token})`;
    document.body.append(element);
    const color = getComputedStyle(element).color;
    element.remove();
    return color;
  }, token);
}

async function expectReadable(element: Locator) {
  const ratio = await element.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Missing canvas context');
    const color = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const over = (fg: number[], bg: number[]) =>
      fg
        .slice(0, 3)
        .map((c, i) => (c * fg[3]) / 255 + bg[i] * (1 - fg[3] / 255));
    const luminance = (rgb: number[]) =>
      rgb
        .slice(0, 3)
        .map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const backgrounds = [];
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      backgrounds.push(color(getComputedStyle(current).backgroundColor));
    }
    const background = backgrounds
      .reverse()
      .reduce((bg, fg) => over(fg, bg), [255, 255, 255]);
    const foreground = over(color(getComputedStyle(element).color), background);
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test('status buttons and real Agent/Space badges use readable opaque roles in both themes', async ({
  page,
}) => {
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountStatusColorsFixture } = await load(
      '/e2e/fixtures/status-colors.tsx',
    );
    mountStatusColorsFixture();
  });
  const fixture = page.locator('[data-status-fixture]');
  await expect(fixture).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle('dark', dark),
      dark,
    );
    const inverse = await reference(page, 'fg-inverse');
    const hover = await reference(page, 'bg-hover');
    for (const tone of tones) {
      const foreground = await reference(page, `${tone}-fg`);
      const background = await reference(page, `${tone}-bg`);
      const solid = fixture.getByRole('button', {
        name: `${tone} solid`,
        exact: true,
      });
      await expect(solid).toHaveCSS('color', inverse);
      await expect(solid).toHaveCSS('background-color', foreground);
      await expectReadable(solid);
      const bounds = await solid.boundingBox();
      await solid.hover();
      await expect
        .poll(() => solid.evaluate((el) => getComputedStyle(el).boxShadow))
        .toContain('1px inset');
      await expect(solid).toHaveCSS('background-color', foreground);
      await expectReadable(solid);
      expect(await solid.boundingBox()).toEqual(bounds);
      for (const variant of ['outline', 'ghost']) {
        const button = fixture.getByRole('button', {
          name: `${tone} ${variant}`,
          exact: true,
        });
        await expect(button).toHaveCSS('color', foreground);
        await expectReadable(button);
        await button.hover();
        await expect(button).toHaveCSS(
          'background-color',
          variant === 'outline' ? background : hover,
        );
        await expectReadable(button);
      }
      await expect(
        fixture.getByRole('button', { name: `${tone} disabled` }),
      ).toBeDisabled();
      const sample = fixture.locator(`[data-status-tone="${tone}"]`);
      const question = sample.locator('.question-conversation-status');
      const space = sample.locator('button[data-space-agent-badge]');
      for (const badge of [question, space]) {
        await expect(badge).toHaveCSS('color', foreground);
        await expect(badge).toHaveCSS('background-color', background);
        await expectReadable(badge);
      }
      await space.hover();
      await expect(space).toHaveCSS('background-color', hover);
      await expectReadable(space);
    }
    await expectReadable(
      fixture.getByText('Could not save changes.', { exact: true }),
    );
    const secondary = fixture.locator('[data-secondary-copy]');
    const countdown = secondary.locator('p').last();
    const referenceLabel = secondary.getByRole('button', {
      name: 'Readable reference',
    });
    for (const element of [countdown, referenceLabel]) {
      await expect(element).toHaveCSS(
        'color',
        await reference(page, 'fg-muted'),
      );
      await expectReadable(element);
    }
    await referenceLabel.hover();
    await expectReadable(referenceLabel);
    const neutralQuestion = secondary.locator('.question-conversation-status');
    await expect(neutralQuestion).toHaveCSS(
      'color',
      await reference(page, 'fg-muted'),
    );
    await expectReadable(neutralQuestion);
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 820, height: 1000 });
    await secondary.screenshot({
      path: test.info().outputPath(`secondary-${dark ? 'dark' : 'light'}.png`),
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await fixture.evaluate((el) => {
        el.scrollTop = 0;
      });
      expect(
        await fixture.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`status-${dark ? 'dark' : 'light'}-${width}.png`),
      });
      if (width === 390) {
        await fixture.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await page.screenshot({
          path: test
            .info()
            .outputPath(
              `status-${dark ? 'dark' : 'light'}-${width}-details.png`,
            ),
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

test('status tokens align perceptual levels and preserve Diff and overlay contracts including nested dark', async ({
  page,
}) => {
  await page.goto('/playground/components');
  const results = await page.evaluate(() => {
    const host = document.createElement('div');
    const probe = document.createElement('span');
    host.append(probe);
    document.body.append(host);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Missing canvas context');
    const rgba = (value: string) => {
      probe.style.color = value;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(probe).color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const lum = (c: number[]) =>
      c
        .slice(0, 3)
        .map((c) => {
          c /= 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a: number[], b: number[]) =>
      (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const results = [];
    for (const mode of ['light', 'dark', 'nested-dark']) {
      const dark = mode !== 'light';
      document.documentElement.classList.toggle('dark', mode === 'dark');
      host.classList.toggle('dark', mode === 'nested-dark');
      const expected = dark
        ? {
            info: ['#6aaaf4', '#b2d3fa', '#4776ad', '#1b304b'],
            success: ['#64bf7d', '#acdeb7', '#50825c', '#223426'],
            warning: ['#d9a440', '#efcd97', '#957335', '#3a2e1b'],
            danger: ['#f08476', '#f8c0b7', '#a75c52', '#412724'],
          }
        : {
            info: ['#2e90ff', '#236dc2', '#8ac2ff', '#f2f8ff'],
            success: ['#42a863', '#087f3d', '#98cda4', '#f1faf2'],
            warning: ['#df7d2d', '#b0540e', '#e9b082', '#fef5ee'],
            danger: ['#ea5b4c', '#bd4236', '#f2a89c', '#fff5f3'],
          };
      const palette = Object.entries(expected).flatMap(([tone, values]) =>
        ['', '-fg', '-light', '-bg'].map((suffix, i) => ({
          actual: rgba(`var(--${tone}${suffix})`),
          expected: rgba(values[i]),
        })),
      );
      const overlays = [
        [
          'ink-reference-bg',
          'color-mix(in srgb, var(--success-bg) 70%, transparent)',
        ],
        [
          'ink-broken-reference-bg',
          'color-mix(in srgb, var(--warning-bg) 70%, transparent)',
        ],
        [
          'pdf-highlight-bg',
          'color-mix(in srgb, var(--warning-light) 45%, transparent)',
        ],
        [
          'pdf-text-selection-bg',
          'color-mix(in srgb, var(--warning-light) 20.25%, transparent)',
        ],
      ].map(([token, expected]) => ({
        actual: rgba(`var(--${token})`),
        expected: rgba(expected),
      }));
      const lightness = (rgb: number[]) => {
        const [r, g, b] = rgb.slice(0, 3).map((c) => {
          c /= 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        const l = Math.cbrt(
          0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
        );
        const m = Math.cbrt(
          0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
        );
        const s = Math.cbrt(
          0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
        );
        return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
      };
      const levels = ['', '-fg', '-light', '-bg'].map((role) => {
        const values = Object.keys(expected).map((tone) =>
          lightness(rgba(`var(--${tone}${role})`)),
        );
        return { role, spread: Math.max(...values) - Math.min(...values) };
      });
      const pairs = Object.keys(expected).flatMap((tone) => {
        const fg = rgba(`var(--${tone}-fg)`);
        return [
          'bg-surface',
          'bg-default',
          'bg-hover',
          `${tone}-bg`,
          ...[
            'white',
            'grey',
            'teal',
            'blue',
            'green',
            'amber',
            'orange',
            'red',
            'purple',
          ].map((accent) => `accent-${accent}-soft-bg`),
        ].map((bg) => ({
          name: `${tone} on ${bg}`,
          ratio: contrast(fg, rgba(`var(--${bg})`)),
        }));
      });
      for (const kind of ['added', 'removed']) {
        pairs.push({
          name: `diff-${kind}`,
          ratio: contrast(
            rgba(`var(--diff-${kind}-text)`),
            rgba(`var(--diff-${kind}-bg)`),
          ),
        });
      }
      for (const background of [
        'bg-surface',
        'bg-default',
        'bg-hover',
        ...[
          'white',
          'grey',
          'teal',
          'blue',
          'green',
          'amber',
          'orange',
          'red',
          'purple',
        ].map((accent) => `accent-${accent}-soft-bg`),
      ]) {
        pairs.push({
          name: `readable secondary copy on ${background}`,
          ratio: contrast(
            rgba('var(--fg-muted)'),
            rgba(`var(--${background})`),
          ),
        });
      }
      const diff = Object.entries({
        'added-bg': 'var(--success-bg)',
        'added-text': 'var(--success-fg)',
        'removed-bg': 'var(--danger-bg)',
        'removed-text': 'var(--danger-fg)',
      }).map(([role, value]) => ({
        actual: rgba(`var(--diff-${role})`),
        expected: rgba(value),
      }));
      results.push({ mode, palette, overlays, pairs, levels, diff });
    }
    host.remove();
    return results;
  });
  for (const { mode, palette, overlays, pairs, levels, diff } of results) {
    for (const pair of [...palette, ...overlays, ...diff])
      expect(pair.actual, mode).toEqual(pair.expected);
    for (const { role, spread } of levels)
      expect(
        spread,
        `${mode}: ${role || 'main'} lightness spread`,
      ).toBeLessThanOrEqual(
        role === '-bg' ? 0.008 : role === '-light' ? 0.025 : 0.04,
      );
    for (const pair of pairs)
      expect(pair.ratio, `${mode}: ${pair.name}`).toBeGreaterThanOrEqual(4.5);
  }
});
