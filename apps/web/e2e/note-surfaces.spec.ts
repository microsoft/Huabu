// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

test('Full and Minimal Notes share a weaker accent surface inside and outside Frames', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  const content =
    '# Neutral Note\n\n' + 'Readable document content.\n\n'.repeat(30);
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-surface-frame',
              nodeType: 'frame',
              data: { label: 'Tinted Frame', style: { accent: 'teal' } },
              position: { x: 100, y: 100 },
              size: { width: 520, height: 420 },
            },
            {
              id: 'node-surface-child',
              nodeType: 'note',
              parentId: 'node-surface-frame',
              data: {
                label: 'Accent Note',
                content,
                style: { accent: 'teal' },
              },
              position: { x: 40, y: 100 },
              size: { width: 360, height: 220 },
            },
            {
              id: 'node-surface-free',
              nodeType: 'note',
              data: {
                label: 'Unaccented Note',
                content,
                style: { accent: null },
              },
              position: { x: 680, y: 100 },
              size: { width: 360, height: 220 },
            },
            {
              id: 'node-surface-free-accent',
              nodeType: 'note',
              data: {
                label: 'Free accent Note',
                content,
                style: { accent: 'teal' },
              },
              position: { x: 680, y: 400 },
              size: { width: 360, height: 220 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-note-surfaces' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const notes = page.locator('.react-flow__node-note');
  await expect(notes.locator('.ProseMirror')).toHaveCount(3);
  await expect(notes.locator('[data-note-truncation-fade]')).toHaveCount(3);

  for (const lod of ['full', 'minimal']) {
    if (lod === 'minimal') {
      for (let step = 0; step < 7; step++) {
        const width = await notes
          .first()
          .evaluate((node) => node.getBoundingClientRect().width);
        await page.keyboard.press('ControlOrMeta+-');
        await expect
          .poll(() =>
            notes
              .first()
              .evaluate((node) => node.getBoundingClientRect().width),
          )
          .toBeLessThan(width * 0.85);
      }
    }
    await expect(notes.locator('.semantic-lod-node').first()).toHaveAttribute(
      'data-lod',
      lod,
    );
    for (const dark of [false, true]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value),
        dark,
      );
      // NodeWrapper transitions colors; wait for all shells to reach their tint.
      await expect
        .poll(() =>
          notes.evaluateAll((elements) =>
            elements.every((node) => {
              const shell =
                node.querySelector<HTMLElement>('.semantic-lod-node');
              const minimal = node.querySelector<HTMLElement>(
                '.semantic-lod-placeholder',
              );
              if (!shell || !minimal) return false;
              const probe = document.createElement('span');
              probe.style.backgroundColor = 'var(--note-surface-background)';
              shell.append(probe);
              const matches =
                getComputedStyle(shell).backgroundColor ===
                getComputedStyle(probe).backgroundColor;
              probe.remove();
              return matches;
            }),
          ),
        )
        .toBe(true);
      const results = await notes.evaluateAll((elements) =>
        elements.map((node) => {
          const shell = node.querySelector<HTMLElement>('.semantic-lod-node');
          const minimal = node.querySelector<HTMLElement>(
            '.semantic-lod-placeholder',
          );
          const host = node.querySelector<HTMLElement>(
            '[data-note-content-host]',
          );
          const fade = node.querySelector<HTMLElement>(
            '[data-note-truncation-fade]',
          );
          const minimalTitle = minimal?.querySelector('[data-study-title]');
          const frame = document.querySelector(
            '[data-id="node-surface-frame"] .semantic-lod-node',
          );
          if (!shell || !minimal || !minimalTitle || !host || !fade || !frame)
            throw new Error('Missing production Note surfaces');
          const style = getComputedStyle(shell);
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--note-surface-background)';
          probe.style.color = 'var(--fg-default)';
          shell.append(probe);
          const token = getComputedStyle(probe);
          const result = {
            id: node.getAttribute('data-id'),
            surface: style.backgroundColor,
            expectedSurface: token.backgroundColor,
            minimalBackground: getComputedStyle(minimal).backgroundColor,
            minimalColor: getComputedStyle(minimalTitle).color,
            expectedColor: token.color,
            hostBackground: getComputedStyle(host).backgroundColor,
            frameBackground: getComputedStyle(frame).backgroundColor,
            fade: getComputedStyle(fade).backgroundImage,
            borderColor: style.borderColor,
            borderWidth: style.borderWidth,
            width: shell.offsetWidth,
            height: shell.offsetHeight,
          };
          probe.remove();
          return result;
        }),
      );
      for (const result of results) {
        expect(result.surface).toBe(result.expectedSurface);
        expect(result.surface).not.toBe(result.frameBackground);
        expect(result.minimalBackground).toBe('rgba(0, 0, 0, 0)');
        expect(result.minimalColor).toBe(result.expectedColor);
        expect(result.hostBackground).toBe('rgba(0, 0, 0, 0)');
        expect(result.fade).toContain(result.surface);
        expect(result.borderWidth).toBe('3px');
        expect(result.width).toBe(360);
        expect(result.height).toBe(220);
      }
      const child = results.find(
        (result) => result.id === 'node-surface-child',
      );
      const neutral = results.find(
        (result) => result.id === 'node-surface-free',
      );
      const free = results.find(
        (result) => result.id === 'node-surface-free-accent',
      );
      if (!child || !neutral || !free) throw new Error('Missing Note fixtures');
      expect(child.surface).toBe(free.surface);
      expect(child.surface).not.toBe(neutral.surface);
      expect(child.borderColor).toBe(free.borderColor);
      expect(child.borderColor).not.toBe(neutral.borderColor);
    }
  }
});
