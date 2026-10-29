// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { openNewCanvas, readViewportTransform } from './helpers';

import type {
  CanvasCommand,
  CanvasNodeId,
  GetCanvasResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

const labels = ['source-peer', 'dragged', 'before', 'after', 'last'] as const;
type Label = (typeof labels)[number];
type Rect = { x: number; y: number; width: number; height: number };

function canvasId(page: Page) {
  return new URL(page.url()).pathname.split('/canvas/')[1];
}

async function savedNodes(page: Page) {
  const response = await page.request.get(`/api/canvas/${canvasId(page)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const record = (await response.json()) as GetCanvasResponse;
  return (record.state as { nodes: Node[] }).nodes;
}

async function execute(page: Page, commands: CanvasCommand[]) {
  const response = await page.request.post(
    `/api/canvas/${canvasId(page)}/execute`,
    {
      data: {
        commands,
        originator: { source: 'agent', threadId: 'e2e-structured-drop' },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function rect(locator: Locator): Promise<Rect> {
  const result = await locator.boundingBox();
  if (!result) throw new Error('Missing rendered rectangle');
  return result;
}

function expectRect(actual: Rect, expected: Rect) {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${key}: ${JSON.stringify({ actual, expected })}`,
    ).toBeLessThan(1.5);
  }
}

for (const axis of ['column', 'row'] as const) {
  for (const zoom of [0.5, 1]) {
    for (const { quickRelease, inputMode } of [false, true].flatMap(
      (quickRelease) =>
        (zoom === 1
          ? (['mouse', 'finger', 'pen'] as const)
          : (['mouse'] as const)
        ).map((inputMode) => ({ quickRelease, inputMode })),
    )) {
      test(`${axis} gap dwell at ${zoom * 100}% with ${inputMode} (quick release: ${quickRelease})`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript((inputMode) => {
          localStorage.setItem(
            'huabu-sketch-tools',
            JSON.stringify({
              state: { inputModePreference: inputMode },
              version: 0,
            }),
          );
        }, inputMode);
        await openNewCanvas(page);
        await page.keyboard.press('Escape');
        await execute(page, [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'frame',
                selectOnCreate: false,
                data: { label: 'Tracks', sizing: 'hug' },
                position: { x: 200, y: 150 },
                size: { width: 600, height: 500 },
              },
              ...Array.from({ length: 4 }, (_, index) => ({
                nodeType: 'note' as const,
                selectOnCreate: false,
                data: {
                  label: `item-${index}`,
                  content: `item-${index}`,
                  heightMode: 'fixed' as const,
                },
                position: { x: 250 + index * 100, y: 240 + index * 80 },
                size: { width: 180, height: 100 },
              })),
            ],
          },
        ]);
        const created = await savedNodes(page);
        const frame = created.find((node) => node.data.label === 'Tracks');
        if (!frame) throw new Error('Missing Frame');
        const children = created.filter((node) => node.type === 'note');
        const frameId = frame.id as CanvasNodeId;
        await execute(page, [
          {
            type: 'SET_NODE_PARENT',
            nodeIds: children.map((node) => node.id as CanvasNodeId),
            parentId: frameId,
          },
          {
            type: 'SET_FRAME_LAYOUT',
            frameId,
            mode: axis,
            gridCount: 2,
            cells: children.map((node, index) => ({
              nodeId: node.id as CanvasNodeId,
              ...(axis === 'column'
                ? { column: Math.floor(index / 2) }
                : { row: Math.floor(index / 2) }),
            })),
          },
        ]);
        const initial = await savedNodes(page);
        const laidOutFrame = initial.find((node) => node.id === frameId);
        if (!laidOutFrame) throw new Error('Missing laid out Frame');
        await page.addInitScript(
          ({ id, position, zoom }) => {
            localStorage.setItem(
              `huabu.viewport.${id}`,
              JSON.stringify({
                x: 300 - position.x * zoom,
                y: 180 - position.y * zoom,
                zoom,
              }),
            );
          },
          { id: canvasId(page), position: laidOutFrame.position, zoom },
        );
        await page.reload();
        await expect(page.locator('.react-flow__node')).toHaveCount(5);
        await expect
          .poll(() => readViewportTransform(page))
          .toContain(`scale(${zoom})`);
        await expect(page.locator('[data-frame-track-entry]')).toHaveCount(0);
        const dragged = page.locator(
          `.react-flow__node[data-id="${children[1].id}"]`,
        );
        const frameNode = page.locator(
          `.react-flow__node[data-id="${frameId}"]`,
        );
        const frameBefore = await rect(frameNode);
        const peer = (index: number) =>
          page.locator(`.react-flow__node[data-id="${children[index].id}"]`);
        const first = await rect(peer(0));
        const second = await rect(peer(2));
        const peers = await Promise.all(
          [0, 2, 3].map(async (index) => ({
            index,
            bounds: await rect(peer(index)),
          })),
        );
        const gap =
          axis === 'column'
            ? {
                x: (first.x + first.width + second.x) / 2,
                y: first.y + 30 * zoom,
              }
            : {
                x: first.x + 50 * zoom,
                y: (first.y + first.height + second.y) / 2,
              };
        const body = { x: first.x + 50 * zoom, y: first.y + 30 * zoom };
        const start = await rect(dragged);
        if (inputMode !== 'mouse') {
          const from = { x: start.x + start.width / 2, y: start.y + 8 * zoom };
          await page.touchscreen.tap(from.x, from.y);
          await expect(dragged).toHaveClass(/selected/);
          const client = await page.context().newCDPSession(page);
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [from],
          });
          for (let step = 1; step <= 8; step++) {
            await client.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [
                {
                  x: from.x + ((gap.x - from.x) * step) / 8,
                  y: from.y + ((gap.y - from.y) * step) / 8,
                },
              ],
            });
          }
          expect(await rect(dragged)).not.toEqual(start);
          const marker = page.locator('[data-structured-drop]');
          await expect(marker).toHaveAttribute('data-structured-gap', '1');
          await expect(marker).toHaveAttribute(
            'data-structured-drop',
            'into-existing',
          );
          if (!quickRelease) {
            await expect(marker).toHaveAttribute(
              'data-structured-drop',
              'insert-new',
            );
            await expect(page.locator('[data-track-insert-label]')).toHaveText(
              axis === 'column' ? 'New column' : 'New row',
            );
            expectRect(await rect(frameNode), frameBefore);
            for (const { index, bounds } of peers)
              expectRect(await rect(peer(index)), bounds);
          }
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
          });
          await expect(marker).toHaveCount(0);
          await expect(async () => {
            const nodes = await savedNodes(page);
            expect(
              nodes.find((node) => node.id === frameId)?.data.gridCount,
            ).toBe(quickRelease ? 2 : 3);
            if (!quickRelease) {
              expect(
                nodes.find((node) => node.id === children[1].id)?.data[
                  axis === 'column' ? 'frameColumn' : 'frameRow'
                ],
              ).toBe(1);
            }
          }).toPass();
          await page.reload();
          await expect(page.locator('[data-track-insert-label]')).toHaveCount(
            0,
          );
          expect(
            (await savedNodes(page)).find((node) => node.id === frameId)?.data
              .gridCount,
          ).toBe(quickRelease ? 2 : 3);
          return;
        }
        await page.mouse.move(start.x + start.width / 2, start.y + 8 * zoom);
        await page.mouse.down();
        await page.mouse.move(gap.x, gap.y, { steps: 8 });
        const marker = page.locator('[data-structured-drop]');
        const label = page.locator('[data-track-insert-label]');
        await expect(marker).toHaveAttribute('data-structured-gap', '1');
        await expect(marker).toHaveAttribute(
          'data-structured-drop',
          'into-existing',
        );
        await expect(label).toHaveCount(0);
        if (quickRelease) {
          await page.mouse.up();
          await expect(marker).toHaveCount(0);
          await expect(async () => {
            expect(
              (await savedNodes(page)).find((node) => node.id === frameId)?.data
                .gridCount,
            ).toBe(2);
          }).toPass();
          return;
        }
        const anchor = await rect(marker);
        // No pointer move is needed for the dwell to activate.
        await expect(marker).toHaveAttribute(
          'data-structured-drop',
          'insert-new',
        );
        await expect(label).toContainText(
          axis === 'column' ? 'New column' : 'New row',
        );
        await expect(label).toHaveText(
          axis === 'column' ? 'New column' : 'New row',
        );
        expect((await rect(label)).height).toBeCloseTo(28, 0);
        await expect(label).toHaveCSS('border-width', '1px');
        await expect(label).toHaveCSS('border-style', 'solid');
        await expect(label).toHaveCSS('border-radius', '8px');
        await expect(label).toHaveCSS('font-weight', '500');
        await expect(label).toHaveCSS('padding', '4px 8px');
        await expect(label).toHaveCSS('box-shadow', 'none');
        const tokenColors = await label.evaluate((element) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--info-fg)';
          probe.style.backgroundColor = 'var(--bg-surface)';
          element.append(probe);
          const style = getComputedStyle(probe);
          const colors = {
            text: style.color,
            background: style.backgroundColor,
          };
          probe.remove();
          return colors;
        });
        await expect(label).toHaveCSS('color', tokenColors.text);
        await expect(label).toHaveCSS(
          'background-color',
          tokenColors.background,
        );
        const labelBounds = await rect(label);
        const lineBounds = await rect(page.locator('[data-track-insert-line]'));
        const markerZ = await marker.evaluate((element) =>
          Number(getComputedStyle(element).zIndex),
        );
        const draggedZ = await dragged.evaluate((element) =>
          Number(getComputedStyle(element).zIndex),
        );
        expect(markerZ).toBe(draggedZ - 1);
        if (axis === 'column') {
          expect(labelBounds.y).toBeCloseTo(lineBounds.y, 1);
          expect(labelBounds.x).toBeLessThan(lineBounds.x);
          expect(labelBounds.x + labelBounds.width).toBeGreaterThan(
            lineBounds.x,
          );
        } else {
          expect(labelBounds.y).toBeLessThan(lineBounds.y);
          expect(labelBounds.y + labelBounds.height).toBeGreaterThan(
            lineBounds.y,
          );
        }
        const icon = await rect(label.locator('svg'));
        expect(icon.width).toBeCloseTo(14, 0);
        await expect(label).toHaveCSS('font-size', '14px');
        await page.mouse.move(gap.x + 1, gap.y + 1);
        await expect(marker).toHaveAttribute(
          'data-structured-drop',
          'insert-new',
        );
        expectRect(await rect(marker), anchor);
        expectRect(await rect(frameNode), frameBefore);
        for (const { index, bounds } of peers)
          expectRect(await rect(peer(index)), bounds);
        await page.mouse.move(body.x, body.y, { steps: 8 });
        await expect(marker).toHaveAttribute(
          'data-structured-drop',
          'into-existing',
        );
        const placeholderBorder = await marker.evaluate(
          (element) => getComputedStyle(element).borderTopColor,
        );
        await expect(label).toHaveCount(0);
        await page.mouse.move(gap.x, gap.y, { steps: 8 });
        await expect(label).toHaveCount(0);
        await expect(marker).toHaveAttribute(
          'data-structured-drop',
          'insert-new',
        );
        await page.keyboard.down('ControlOrMeta');
        await expect(marker).toHaveCount(0);
        await page.keyboard.up('ControlOrMeta');
        await page.mouse.move(gap.x + 1, gap.y + 1);
        await expect(label).toHaveCount(0);
        await expect(label).toBeVisible();
        await expect(page.locator('[data-track-insert-line]')).toHaveCSS(
          'background-color',
          placeholderBorder,
        );
        await expect(label).toHaveCSS('border-color', placeholderBorder);
        await page.locator('.react-flow__node').evaluateAll(async (nodes) => {
          await Promise.all(
            nodes.flatMap((node) =>
              node.getAnimations().map((animation) => animation.finished),
            ),
          );
        });
        await page.screenshot({
          path: testInfo.outputPath('gap-insertion.png'),
        });
        expectRect(await rect(frameNode), frameBefore);
        await page.mouse.up();
        await expect(marker).toHaveCount(0);
        await expect(async () => {
          const nodes = await savedNodes(page);
          expect(
            nodes.find((node) => node.id === frameId)?.data.gridCount,
          ).toBe(3);
          expect(
            nodes.find((node) => node.id === children[1].id)?.data[
              axis === 'column' ? 'frameColumn' : 'frameRow'
            ],
          ).toBe(1);
        }).toPass();
        await page.locator('.react-flow__node').evaluateAll(async (nodes) => {
          await Promise.all(
            nodes.flatMap((node) =>
              node.getAnimations().map((animation) => animation.finished),
            ),
          );
        });
        const committed = await rect(dragged);
        await page.reload();
        await expect(async () =>
          expectRect(await rect(dragged), committed),
        ).toPass();
      });
    }
  }
}

for (const { zoom, soleSource, draggedType } of [
  { zoom: 0.5, soleSource: false, draggedType: 'note' },
  { zoom: 1, soleSource: false, draggedType: 'note' },
  { zoom: 0.5, soleSource: true, draggedType: 'note' },
  { zoom: 1, soleSource: true, draggedType: 'note' },
  { zoom: 1, soleSource: false, draggedType: 'frame' },
] as const) {
  test(`cross-column ${draggedType} drop matches its preview at ${zoom * 100}% (sole source: ${soleSource})`, async ({
    page,
  }, testInfo) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    await execute(page, [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'frame',
            data: { label: 'List', sizing: 'hug' },
            position: { x: 200, y: 150 },
            size: { width: 500, height: 500 },
          },
          ...labels.map((label, index) => ({
            nodeType: label === 'dragged' ? draggedType : ('note' as const),
            data:
              label === 'dragged' && draggedType === 'frame'
                ? { label, sizing: 'manual' as const }
                : {
                    label,
                    content: label,
                    heightMode: 'fixed' as const,
                  },
            position: { x: 230 + (index < 2 ? 0 : 220), y: 230 + index * 100 },
            size: { width: 180, height: label === 'source-peer' ? 240 : 80 },
          })),
        ],
      },
    ]);
    const created = await savedNodes(page);
    const findId = (label: string) => {
      const found = created.find((node) => node.data.label === label);
      if (!found) throw new Error(`Missing fixture ${label}`);
      return found.id as CanvasNodeId;
    };
    const frameId = findId('List');
    const ids = Object.fromEntries(
      labels.map((label) => [label, findId(label)]),
    ) as Record<Label, CanvasNodeId>;
    await execute(page, [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: Object.values(ids),
        parentId: frameId,
      },
      {
        type: 'SET_FRAME_LAYOUT',
        frameId,
        mode: 'column',
        gridCount: 2,
        cells: labels.map((label, index) => ({
          nodeId: ids[label],
          column: index < 2 ? 0 : 1,
        })),
      },
    ]);
    if (soleSource) {
      await execute(page, [
        { type: 'DELETE_NODES', nodeIds: [ids['source-peer']] },
      ]);
    }
    const initial = await savedNodes(page);
    const frame = initial.find((node) => node.id === frameId);
    if (!frame) throw new Error('Missing fixture Frame');
    await page.addInitScript(
      ({ id, position, zoom }) => {
        localStorage.setItem(
          `huabu.viewport.${id}`,
          JSON.stringify({
            x: 300 - position.x * zoom,
            y: 180 - position.y * zoom,
            zoom,
          }),
        );
      },
      { id: canvasId(page), position: frame.position, zoom },
    );
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(
      soleSource ? 5 : 6,
    );
    await expect
      .poll(() => readViewportTransform(page))
      .toContain(`scale(${zoom})`);
    const node = (label: Label) =>
      page.locator(`.react-flow__node[data-id="${ids[label]}"]`);
    const frameNode = page.locator(`.react-flow__node[data-id="${frameId}"]`);
    const title = frameNode.locator('[data-frame-header] input');
    const titleInset = (await rect(title)).x - (await rect(frameNode)).x;
    const start = await rect(node('dragged'));
    const before = await rect(node('before'));
    const after = await rect(node('after'));
    const grabOffset = { x: start.width / 2, y: 8 * zoom };
    if (draggedType === 'frame') {
      await node('dragged').click({ position: grabOffset });
    }
    await page.mouse.move(start.x + grabOffset.x, start.y + grabOffset.y);
    await page.mouse.down();
    await page.mouse.move(
      before.x + grabOffset.x,
      (before.y + after.y) / 2 + grabOffset.y,
      { steps: 16 },
    );
    const marker = page.locator('[data-structured-drop]');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute(
      'data-structured-drop',
      'into-existing',
    );
    await expect(marker.locator('..').locator(':scope > *')).toHaveCount(1);
    await expect(marker.locator('..')).toHaveText('');
    await expect(marker).toHaveCSS('border-top-style', 'dashed');
    await expect(marker).toHaveCSS('border-top-width', '1px');
    await expect(marker).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const dragOutline = page.locator(
      `[data-node-selection-outline="${ids.dragged}"]`,
    );
    await expect(dragOutline).toHaveCSS('opacity', '0.35');
    const dragSurface = node('dragged').locator('[data-node-surface]');
    await expect(dragSurface).toHaveCSS('opacity', '1');
    await expect(dragSurface).toHaveClass(/shadow-sm/);
    await page.locator('.react-flow__node').evaluateAll(async (elements) => {
      await Promise.all(
        elements.flatMap((element) =>
          element.getAnimations().map((animation) => animation.finished),
        ),
      );
    });
    const preview = await rect(marker);
    expect
      .soft(
        Math.abs(
          (await rect(title)).x - (await rect(frameNode)).x - titleInset,
        ),
        'Frame title keeps its inset while its leftmost child moves',
      )
      .toBeLessThan(1);
    const radius = await node('dragged')
      .locator('[data-node-surface]')
      .evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    await expect.soft(marker).toHaveCSS('border-top-left-radius', radius);
    if (!soleSource) {
      const overlap = await marker.evaluate((element, draggedId) => {
        const dragged = document.querySelector(
          `.react-flow__node[data-id="${draggedId}"]`,
        );
        if (!dragged) throw new Error('Missing dragged node');
        const a = element.getBoundingClientRect();
        const b = dragged.getBoundingClientRect();
        const left = Math.max(a.left, b.left);
        const right = Math.min(a.right, b.right);
        const top = Math.max(a.top, b.top);
        const bottom = Math.min(a.bottom, b.bottom);
        if (left >= right || top >= bottom)
          throw new Error('Expected overlapping drag and placeholder');
        const previous = element.style.pointerEvents;
        element.style.pointerEvents = 'auto';
        try {
          const stack = document.elementsFromPoint(
            (left + right) / 2,
            (top + bottom) / 2,
          );
          const draggedIndex = stack.findIndex(
            (entry) => entry === dragged || dragged.contains(entry),
          );
          const placeholderIndex = stack.indexOf(element);
          return { draggedIndex, placeholderIndex };
        } finally {
          element.style.pointerEvents = previous;
        }
      }, ids.dragged);
      expect.soft(overlap.draggedIndex).toBeGreaterThanOrEqual(0);
      expect
        .soft(overlap.placeholderIndex)
        .toBeGreaterThan(overlap.draggedIndex);
    }
    await expect(async () => {
      expect((await rect(node('before'))).y).toBeLessThan(preview.y);
      expect((await rect(node('after'))).y).toBeGreaterThan(
        preview.y + preview.height,
      );
    }).toPass();
    const peers = await Promise.all(
      (['before', 'after', 'last'] as const).map(async (label) => ({
        label,
        rect: await rect(node(label)),
      })),
    );
    await page.screenshot({ path: testInfo.outputPath('drop-preview.png') });
    await page.mouse.up();
    await expect(marker).toHaveCount(0);
    await expect(dragOutline).toHaveCSS('opacity', '1');
    await expect(dragSurface).not.toHaveClass(/shadow-sm/);
    await expect(async () => {
      expectRect(await rect(node('dragged')), preview);
      for (const peer of peers) {
        expectRect(await rect(node(peer.label)), peer.rect);
      }
    }).toPass();
    await expect(async () => {
      const nodes = await savedNodes(page);
      const column = nodes
        .filter(
          (entry) =>
            entry.parentId === frameId &&
            entry.data.frameColumn === (soleSource ? 0 : 1),
        )
        .sort((a, b) => a.position.y - b.position.y);
      expect(column.map((entry) => entry.data.label)).toEqual([
        'before',
        'dragged',
        'after',
        'last',
      ]);
    }).toPass();
    await page.reload();
    await expect(async () =>
      expectRect(await rect(node('dragged')), preview),
    ).toPass();
  });
}
