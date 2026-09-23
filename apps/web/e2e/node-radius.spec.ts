// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

const cardTypes = [
  'image',
  'video',
  'audio',
  'office',
  'spacePreview',
  'note',
  'pdf',
  'web',
] as const;

for (const [size, radius] of [
  [400, 12],
  [600, 18],
  [900, 24],
]) {
  test(`media shells share the ${radius}px radius at ${size}px without changing border insets`, async ({
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
              nodes: cardTypes.map((nodeType, index) => ({
                nodeType,
                data: {
                  label: `Radius ${nodeType}`,
                  style: { accent: 'teal' },
                },
                // Keep every shell in view; offscreen nodes are virtualized.
                position: { x: 100 + index * 20, y: 100 },
                size: { width: size, height: size },
              })),
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-node-radius' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const noteShell = page.locator('.react-flow__node-note .semantic-lod-node');
    await expect(noteShell).toBeVisible();
    const noteBorderColor = await noteShell.evaluate(
      (element) => getComputedStyle(element).borderTopColor,
    );
    expect(noteBorderColor).toMatch(/(?:0\.3|30%)[ )]/);
    for (const type of cardTypes) {
      const shell = page.locator(
        `.react-flow__node-${type} .semantic-lod-node`,
      );
      await expect(shell).toHaveCSS('border-top-left-radius', `${radius}px`);
      await expect(shell).toHaveCSS('border-top-color', noteBorderColor);
      const inset = type === 'image' || type === 'video' ? 0 : 3;
      const content = shell.locator(':scope > .semantic-lod-content');
      await expect(content).toHaveCSS(
        'border-top-left-radius',
        `${radius - inset}px`,
      );
      await expect(content).toHaveCSS('overflow', 'hidden');
      await expect(shell).toHaveCSS('border-left-width', `${inset}px`);
      if (type === 'image' || type === 'video') {
        const border = shell.locator('[data-node-media-border]');
        await expect(border).toHaveCSS('border-top-color', noteBorderColor);
        await expect(border).toHaveCSS('border-top-left-radius', `${radius}px`);
        await expect(border).toHaveCSS('border-left-width', '3px');
        const geometry = await shell.evaluate((element) => {
          const content = element.querySelector('.semantic-lod-content');
          if (!content) throw new Error('Missing content clip');
          const outer = element.getBoundingClientRect();
          const inner = content.getBoundingClientRect();
          return {
            width: outer.width - inner.width,
            height: outer.height - inner.height,
          };
        });
        expect(geometry.width).toBeCloseTo(0, 3);
        expect(geometry.height).toBeCloseTo(0, 3);
      }
    }
  });
}

test('image loading and loaded pixels use the same shared rounded clip', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  let releaseImage!: () => void;
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route('**/radius-image.svg', async (route) => {
    await imageReady;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="teal"/></svg>',
    });
  });
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'image',
              data: {
                label: 'Image clip',
                src: 'https://example.test/radius-image.svg',
              },
              position: { x: 100, y: 100 },
              size: { width: 600, height: 600 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-image-radius' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const shell = page.locator('.react-flow__node-image .semantic-lod-node');
  const clip = shell.locator('.semantic-lod-content');
  const image = clip.locator('img');
  try {
    await expect(clip).toHaveCSS('border-radius', '18px');
    await expect(image).toHaveCSS('visibility', 'hidden');
    await expect(clip.locator('div[aria-hidden]')).toBeVisible();
  } finally {
    releaseImage();
  }
  await expect(image).toBeVisible();
  await expect(clip.locator('div[aria-hidden]')).toHaveCount(0);
  await expect(clip).toHaveCSS('border-radius', '18px');
  const geometry = await shell.evaluate((element) => {
    const image = element.querySelector('img');
    const content = element.querySelector('.semantic-lod-content');
    if (!image || !content) throw new Error('Missing image content');
    const shellRect = element.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const scale = shellRect.width / (element as HTMLElement).offsetWidth;
    const cornerHit = document.elementFromPoint(
      shellRect.left + scale,
      shellRect.top + scale,
    );
    return {
      width: shellRect.width - imageRect.width,
      height: shellRect.height - imageRect.height,
      cornerInClip: content.contains(cornerHit),
    };
  });
  expect(geometry.width).toBeCloseTo(0, 3);
  expect(geometry.height).toBeCloseTo(0, 3);
  expect(geometry.cornerInClip).toBe(false);
});
