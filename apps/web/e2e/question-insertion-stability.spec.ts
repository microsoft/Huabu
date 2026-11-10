// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as StoreModule from '../src/store/canvasStore';

for (const { nodeType, peerHeight } of (
  ['question', 'text', 'note'] as const
).flatMap((nodeType) =>
  [80, 500].map((peerHeight) => ({ nodeType, peerHeight })),
)) {
  test(`a ${nodeType} created beside a ${peerHeight}px Grid peer does not jump`, async ({
    page,
  }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = new URL(page.url()).pathname.split('/canvas/')[1];
    const seeded = await page.request.post(`/api/canvas/${canvasId}/execute`, {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-stability-frame',
                nodeType: 'frame',
                position: { x: 0, y: 0 },
                data: { layoutMode: 'grid', gridCount: 2, sizing: 'hug' },
              },
              {
                id: 'node-stability-peer',
                nodeType: 'note',
                parentId: 'node-stability-frame',
                position: { x: 20, y: 80 },
                size: { width: 200, height: peerHeight },
                data: { frameColumn: 0, frameRow: 1, content: 'Stable peer' },
              },
              {
                id: 'node-stability-header',
                nodeType: 'note',
                parentId: 'node-stability-frame',
                position: { x: 240, y: 300 },
                size: { width: 200, height: 80 },
                data: { frameColumn: 1, frameRow: 0, content: 'Second column' },
              },
              {
                id: 'node-stability-footer',
                nodeType: 'note',
                parentId: 'node-stability-frame',
                position: { x: 20, y: 520 },
                size: { width: 200, height: 80 },
                data: { frameColumn: 0, frameRow: 2, content: 'Third row' },
              },
            ],
          },
        ],
        originator: { source: 'ui' },
      },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    await page.reload();
    await expect(
      page.locator('.react-flow__node[data-id="node-stability-peer"]'),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const { samples, cells } = await page.evaluate(
      async ({ nodeType, peerHeight }) => {
        const { default: store } = (await import(
          /* @vite-ignore */ '/src/store/canvasStore.ts'
        )) as typeof StoreModule;
        const state = store.getState();
        const header = state.nodes.find(
          (node) => node.id === 'node-stability-header',
        );
        const peer = state.nodes.find(
          (node) => node.id === 'node-stability-peer',
        );
        if (!header || !peer) throw new Error('Missing Grid fixture');
        const samples: {
          x: number;
          y: number;
          width: number;
          height: number;
          centerOffset: number;
        }[] = [];
        const sample = () => {
          const element = document.querySelector<HTMLElement>(
            '.react-flow__node[data-id="node-stability-agent"]',
          );
          if (!element || getComputedStyle(element).visibility === 'hidden')
            return;
          const frame = document.querySelector<HTMLElement>(
            '.react-flow__node[data-id="node-stability-frame"]',
          );
          if (!frame) throw new Error('Missing Frame element');
          const peerElement = document.querySelector<HTMLElement>(
            '.react-flow__node[data-id="node-stability-peer"]',
          );
          if (!peerElement) throw new Error('Missing peer element');
          const peerRect = peerElement.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          const origin = frame.getBoundingClientRect();
          samples.push({
            x: rect.x - origin.x,
            y: rect.y - origin.y,
            width: rect.width,
            height: rect.height,
            centerOffset:
              rect.y + rect.height / 2 - peerRect.y - peerRect.height / 2,
          });
        };
        // Animation-frame sampling alone misses visible commits between frames.
        const observer = new MutationObserver(sample);
        const viewport = document.querySelector('.react-flow__viewport');
        if (!viewport) throw new Error('Missing viewport');
        observer.observe(viewport, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style'],
        });
        state.addNode({
          id: 'node-stability-agent',
          nodeType,
          parentId: 'node-stability-frame',
          size: { width: 200, ...(nodeType === 'note' ? { height: 60 } : {}) },
          placementPoint: {
            x: header.position.x + 10,
            y: peer.position.y + peerHeight - 1,
          },
          data: { label: 'New Agent', content: '' },
        });
        for (let index = 0; index < 45; index++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          sample();
        }
        observer.disconnect();
        return {
          samples,
          cells: store
            .getState()
            .nodes.filter((node) => node.parentId === 'node-stability-frame')
            .map((node) => ({
              id: node.id,
              column: node.data.frameColumn,
              row: node.data.frameRow,
            })),
        };
      },
      { nodeType, peerHeight },
    );
    await testInfo.attach('insertion-samples', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('insertion.png') });
    expect(cells).toEqual(
      expect.arrayContaining([
        { id: 'node-stability-agent', column: 1, row: 1 },
        { id: 'node-stability-peer', column: 0, row: 1 },
        { id: 'node-stability-footer', column: 0, row: 2 },
      ]),
    );
    expect(samples.length).toBeGreaterThan(10);
    expect(
      Math.max(...samples.map((sample) => Math.abs(sample.centerOffset))),
    ).toBeLessThanOrEqual(1);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const values = samples.map((sample) => sample[key]);
      expect(
        Math.max(...values) - Math.min(...values),
        key,
      ).toBeLessThanOrEqual(1);
    }
  });
}
