// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as GesturePreviewModule from '../src/store/gesturePreviewStore';

test.use({ hasTouch: false });

const palettes = {
  light: {
    main: 'rgb(46, 144, 255)',
    foreground: 'rgb(35, 109, 194)',
    light: 'rgb(138, 194, 255)',
    background: 'rgb(242, 248, 255)',
    inverse: 'rgb(255, 255, 255)',
  },
  dark: {
    main: 'rgb(106, 170, 244)',
    foreground: 'rgb(178, 211, 250)',
    light: 'rgb(71, 118, 173)',
    background: 'rgb(27, 48, 75)',
    inverse: 'rgb(25, 25, 25)',
  },
};

function translucent(rgb: string, alpha: number) {
  const channels = rgb.match(/\d+/g);
  if (!channels || channels.length !== 3)
    throw new Error(`Invalid RGB: ${rgb}`);
  return `color(srgb ${channels
    .map((channel) => Number((Number(channel) / 255).toPrecision(6)))
    .join(' ')} / ${alpha})`;
}

async function expectReadable(element: Locator) {
  const ratio = await element.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length !== 3) {
        throw new Error(`Expected opaque RGB color, received ${color}`);
      }
      return channels
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (sum, channel, index) =>
            sum + channel * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    };
    const fg = luminance(style.color);
    const bg = luminance(style.backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test('production buttons and text fields use the four blue roles in both themes', async ({
  page,
}) => {
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.goto('/playground/components');
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    const solid = page.locator('button.bg-info-fg').first();
    await expect(solid).toHaveCSS('background-color', palette.foreground);
    await expect(solid).toHaveCSS('color', palette.inverse);
    await expectReadable(solid);
    const idleBounds = await solid.boundingBox();
    const idleShadow = await solid.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    await solid.hover();
    await expect(solid).toHaveCSS('background-color', palette.foreground);
    await expectReadable(solid);
    await expect
      .poll(() =>
        solid.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toContain(`${palette.inverse} 0px 0px 0px 1px inset`);
    await expect(solid).not.toHaveCSS('box-shadow', idleShadow);
    expect(await solid.boundingBox()).toEqual(idleBounds);
    await solid.screenshot({
      path: test.info().outputPath(`solid-hover-${theme}.png`),
    });

    const outline = page.locator('button.border-info').first();
    await expect(outline).toHaveCSS('color', palette.foreground);
    await outline.hover();
    await expect(outline).toHaveCSS('background-color', palette.background);
    await expectReadable(outline);
    await expect(
      page.getByRole('button', { name: 'Disabled outline' }),
    ).toBeDisabled();
    await outline.screenshot({
      path: test.info().outputPath(`outline-${theme}.png`),
    });

    await page.goto('/playground/settings-components');
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    const input = page.locator('input[class~="focus:ring-info"]').first();
    await input.focus();
    await expect(input).toBeFocused();
    await expect
      .poll(() =>
        input.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toContain(palette.main);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await input.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`fields-${theme}-${width}.png`),
      });
    }
  }
});

test('a real Note preserves drop feedback and distinguishes editor selection matches', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  expect(canvasId).toBeTruthy();
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-blue-drop',
              nodeType: 'note',
              data: {
                content:
                  '# Blue migration\n\nA real Note retains its content.\n\nBlue migration.',
                style: { accent: 'blue' },
              },
              position: { x: 150, y: 150 },
              size: { width: 400, height: 250 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-system-blue' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const shell = page.locator('[data-id="node-blue-drop"] .huabu-note-surface');
  const content = shell.locator('.ProseMirror');
  await expect(content).toContainText('A real Note retains its content.');
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData('application/x-huabu-dnd', '{}');
    return data;
  });
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    const original =
      theme === 'dark' ? 'rgb(30, 39, 52)' : 'rgb(245, 248, 252)';
    await expect(shell).toHaveCSS('background-color', original);
    await content.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(shell).toHaveCSS('background-color', palette.background);
    await expect
      .poll(() =>
        shell.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toContain(palette.main);
    await expect(shell).toHaveCSS(
      '--note-surface-background',
      theme === 'dark' ? '#1b304b' : '#f2f8ff',
    );
    await page.screenshot({
      path: test.info().outputPath(`note-drop-${theme}.png`),
    });
    await content.dispatchEvent('dragleave', { dataTransfer: transfer });
    await expect(shell).toHaveCSS('background-color', original);
  }
  await transfer.dispose();
  await expect(content).toContainText('A real Note retains its content.');
  await shell.click();
  const port = page.locator('[data-connection-port-dot]').first();
  await expect(port).toHaveCSS('border-top-width', '0px');
  await expect(port).toHaveCSS('background-color', palettes.dark.light);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openPreviewNode } = await load(
      '/src/store/previewWorkspace/actions.ts',
    );
    openPreviewNode('node-blue-drop', { transient: false });
  });
  await page
    .getByRole('button', { name: 'Switch to raw markdown editor' })
    .click();
  const editor = page.locator('.cm-editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Shift+ArrowRight');
  }
  const match = editor.locator('.cm-selectionMatch').first();
  await expect(match).toHaveText('Blue');
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(editor.locator('.cm-selectionBackground').first()).toHaveCSS(
      'background-color',
      palette.background,
    );
    await expect(match).not.toHaveCSS('background-color', palette.background);
    await expect(match).toHaveCSS('text-decoration-line', 'underline');
    await expect(match).toHaveCSS('text-decoration-color', palette.main);
    await expect(shell).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(30, 39, 52)' : 'rgb(245, 248, 252)',
    );
    await page.screenshot({
      path: test.info().outputPath(`editor-selection-${theme}.png`),
    });
  }
});

test('composer and panel drag feedback reuse opaque system blues without changing geometry', async ({
  page,
}) => {
  await page.goto('/playground/chat-performance?messages=0');
  const composer = page.locator('[data-chat-input-surface]').first();
  const input = composer.locator('textarea');
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await input.focus();
    await expect(input).toBeFocused();
    await expect(composer).toHaveCSS('border-top-width', '1px');
    await expect(composer).toHaveCSS('border-top-color', palette.main);
    await expect
      .poll(() =>
        composer.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toContain(`${palette.background} 0px 0px 0px 2px`);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({
        path: test.info().outputPath(`composer-focus-${theme}-${width}.png`),
      });
    }
  }

  await page.setViewportSize({ width: 1280, height: 844 });
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Show layers panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'New conversation', exact: true })
    .first()
    .click();
  const handles = page.locator(
    '[role="separator"][aria-orientation="vertical"]:visible',
  );
  await expect(handles).toHaveCount(2);
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    for (const [index, handle] of (await handles.all()).entries()) {
      await handle.hover();
      await expect(handle).toHaveCSS('background-color', palette.light);
      const bounds = await handle.boundingBox();
      if (!bounds) throw new Error('Missing panel drag handle');
      await page.mouse.down();
      await page.mouse.move(
        bounds.x + bounds.width / 2 + 16,
        bounds.y + bounds.height / 2,
      );
      await expect(handle).toHaveCSS('background-color', palette.light);
      await page.screenshot({
        path: test.info().outputPath(`panel-drag-${theme}-${index}.png`),
      });
      await page.mouse.up();
      await page.mouse.move(640, 400);
      await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
  }
});

test('real Canvas overlays use shared transparent fills in both themes', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  expect(canvasId).toBeTruthy();
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-blue-ink',
              nodeType: 'sketch',
              position: { x: 100, y: 150 },
              size: { width: 200, height: 100 },
              data: {
                initialSize: { width: 200, height: 100 },
                strokes: [20, 60].map((y, index) => ({
                  id: `blue-stroke-${index}`,
                  points: [
                    [20, y, 0.5],
                    [170, y, 0.5],
                  ],
                  color: 'black',
                  size: 8,
                  createdAt: 1,
                })),
              },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-blue-overlays' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('[data-id="node-blue-ink"]')).toBeVisible();
  await page.keyboard.press('l');
  await page.mouse.move(250, 250);
  await page.mouse.down();
  await page.mouse.move(550, 250, { steps: 5 });
  await page.mouse.move(550, 500, { steps: 5 });
  await page.mouse.move(250, 500, { steps: 5 });
  const live = page.locator('path[fill="var(--canvas-overlay-selection)"]');
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(live).toHaveCSS('fill', translucent(palette.main, 0.14));
  }
  await page.mouse.up();

  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { useGesturePreviewStore } = (await load(
      '/src/store/gesturePreviewStore.ts',
    )) as typeof GesturePreviewModule;
    const preview = useGesturePreviewStore.getState();
    preview.setSketchStrokeSelection({ 'node-blue-ink': ['blue-stroke-0'] });
    preview.setSketchStrokeHighlight({ 'node-blue-ink': ['blue-stroke-1'] });
    preview.setSketchSelectionPolygon([
      { x: 100, y: 150 },
      { x: 300, y: 150 },
      { x: 300, y: 350 },
      { x: 100, y: 350 },
    ]);
    preview.setStructuredDropPreview({
      nodeId: 'node-blue-ink',
      frameId: 'blue-overlay-test',
      kind: 'insert-new',
      x: 400,
      y: 150,
      width: 150,
      height: 150,
      context: {
        axis: 'column',
        tracks: [
          { x: 400, y: 150, width: 150, height: 250 },
          { x: 580, y: 150, width: 150, height: 250 },
        ],
        activeTrack: 0,
        rows: [],
        activeRow: -1,
      },
    });
  });
  const retained = page.locator('[data-stroke-selection-region] polygon');
  const drops = page.locator('.bg-canvas-overlay-drop');
  await expect(drops).toHaveCount(1);
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(retained).toHaveCSS('fill', translucent(palette.main, 0.06));
    await expect(retained).toHaveCSS('fill-opacity', '1');
    await expect(
      page.locator('[data-sketch-stroke-emphasis="selected"]'),
    ).toHaveCSS('stroke-opacity', '0.7');
    await expect(
      page.locator('[data-sketch-stroke-emphasis="reference"]'),
    ).toHaveCSS('stroke-opacity', '0.45');
    for (const drop of await drops.all()) {
      await expect(drop).toHaveCSS(
        'background-color',
        translucent(palette.main, 0.1),
      );
    }
    await expect(drops.locator('svg')).toHaveCSS('color', palette.foreground);
    await page.screenshot({
      path: test.info().outputPath(`canvas-overlays-${theme}.png`),
    });
  }
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { useGesturePreviewStore } = (await load(
      '/src/store/gesturePreviewStore.ts',
    )) as typeof GesturePreviewModule;
    const { structuredDropPreview, setStructuredDropPreview } =
      useGesturePreviewStore.getState();
    if (!structuredDropPreview) throw new Error('Missing drop preview');
    setStructuredDropPreview({
      ...structuredDropPreview,
      masonry: {
        target: { kind: 'insert-new', slot: 0 },
        gap: { x: 400, y: 150, width: 150, height: 150, slot: 0 },
      },
    });
  });
  const label = page.locator('[data-track-insert-label]');
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle('dark', theme === 'dark'),
      theme,
    );
    await expect(label).toHaveCSS('color', palette.foreground);
    await expectReadable(label);
  }
});

test('pressed toolbar icons use main blue while shortcut hints retain foreground blue', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const select = page.getByRole('button', { name: 'Select (S)', exact: true });
  const note = page.getByRole('button', { name: 'Note (1)', exact: true });
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await expect(select.locator('svg')).toHaveCSS('color', palette.main);
    await expect(select.getByText('S', { exact: true })).toHaveCSS(
      'color',
      palette.foreground,
    );
    await expect(select).toHaveCSS('background-color', palette.background);
    await select.screenshot({
      path: test.info().outputPath(`selected-icon-${theme}.png`),
    });
    await note.click();
    await expect(note).toHaveAttribute('aria-pressed', 'true');
    await expect(note.locator('svg')).toHaveCSS('color', palette.main);
    await expect(note.getByText('1', { exact: true })).toHaveCSS(
      'color',
      palette.foreground,
    );
    await expect(select.locator('svg')).not.toHaveCSS('color', palette.main);
    await select.click();
  }

  await page.goto('/playground/node-toolbars');
  const pressed = page
    .getByRole('button', { name: '加粗', exact: true })
    .first();
  await pressed.click();
  await expect(pressed).toHaveAttribute('aria-pressed', 'true');
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(pressed.locator('svg')).toHaveCSS('color', palette.main);
    await expect(pressed).toHaveCSS('color', palette.foreground);
  }
});

test('running and approval badges use their semantic foreground roles', async ({
  page,
}) => {
  await page.goto('/playground/space-previews');
  // Expose both statuses instead of folding approval into the overflow menu.
  await page.addStyleTag({
    content: '[data-space-agent-activity] { min-width: 600px; }',
  });
  const running = page.locator('[data-space-agent-badge="running"]').first();
  for (const [theme, palette] of Object.entries(palettes)) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await expect(running).toHaveCSS('color', palette.foreground);
    await expect(running).toHaveCSS('background-color', palette.background);
    await expectReadable(running);
    const colors = await page.evaluate(() => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--warning-fg)';
      reference.style.backgroundColor = 'var(--warning-bg)';
      document.body.append(reference);
      const style = getComputedStyle(reference);
      const result = {
        foreground: style.color,
        background: style.backgroundColor,
      };
      reference.remove();
      return result;
    });
    const approval = page
      .locator('[data-space-agent-badge="approval"]')
      .first();
    await expect(approval).toHaveCSS('color', colors.foreground);
    await expect(approval).toHaveCSS('background-color', colors.background);
  }
});
