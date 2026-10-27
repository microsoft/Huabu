// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import { oneFingerPath, openNewCanvas } from './helpers';

import type * as CanvasModule from '../src/store/canvasStore';
import type { CanvasCommand } from '@huabu/shared';

const note = {
  id: 'node-delete-note',
  nodeType: 'note' as const,
  data: { content: 'Keep deletion in the primary action group.' },
  position: { x: 380, y: 260 },
  size: { width: 260, height: 160 },
};
const ink = {
  id: 'node-delete-ink',
  nodeType: 'sketch' as const,
  position: { x: 400, y: 490 },
  size: { width: 180, height: 80 },
  data: {
    initialSize: { width: 180, height: 80 },
    strokes: [
      {
        id: 'stroke-delete',
        points: [
          [10, 10, 0.5],
          [60, 30, 0.5],
          [100, 10, 0.5],
        ],
        color: 'ink',
        size: 4,
        createdAt: 1,
      },
      {
        id: 'stroke-keep',
        points: [
          [10, 60, 0.5],
          [60, 75, 0.5],
          [100, 60, 0.5],
        ],
        color: 'ink',
        size: 4,
        createdAt: 2,
      },
    ],
  },
};

async function seed(page: Page, commands: CanvasCommand[]) {
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  const result = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands,
      originator: { source: 'ui', tabId: 'primary-delete-test' },
    },
  });
  expect(result.ok(), await result.text()).toBe(true);
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { default: store } = (await import(path)) as typeof CanvasModule;
    await store.getState().rfInstance?.setViewport({ x: 0, y: 0, zoom: 1 });
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await select(page, []);
}

async function select(page: Page, nodeIds: string[], edgeIds: string[] = []) {
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 30, y: 180 } });
  await page.evaluate(
    async ({ nodeIds, edgeIds }) => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasModule;
      const state = store.getState();
      state.selectNodes(nodeIds, false);
      state.onEdgesChange(
        state.edges.map((edge) => ({
          id: edge.id,
          type: 'select',
          selected: edgeIds.includes(edge.id),
        })),
      );
    },
    { nodeIds, edgeIds },
  );
}

async function flushSaves(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/store/canvasStore.ts';
    const { drainPendingSaves } = (await import(path)) as typeof CanvasModule;
    await drainPendingSaves();
  });
}

for (const mode of ['auto', 'finger', 'pen'] as const) {
  test(`Note has stable primary Delete before More in ${mode} mode`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({
          state: { inputModePreference: mode },
          version: 0,
        }),
      );
    }, mode);
    await openNewCanvas(page);
    await seed(page, [{ type: 'CREATE_NODES', nodes: [note] }]);
    const node = page.locator(`[data-id="${note.id}"]`);
    await expect(node).toBeVisible();
    const selectNote = async () => {
      if (mode === 'pen') {
        const box = await node.boundingBox();
        if (!box) throw new Error('Note is not visible');
        const client = await page.context().newCDPSession(page);
        const position = { x: box.x + 40, y: box.y + 10 };
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          pointerType: 'pen',
          button: 'left',
          buttons: 1,
          clickCount: 1,
          ...position,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          pointerType: 'pen',
          button: 'left',
          buttons: 0,
          clickCount: 1,
          ...position,
        });
        await client.detach();
      } else {
        await node.tap({ position: { x: 40, y: 10 } });
      }
    };
    await selectNote();
    const toolbar = page.locator('.node-floating-toolbar');
    const remove = toolbar.getByRole('button', { name: 'Delete', exact: true });
    const more = toolbar.getByRole('button', { name: 'More', exact: true });
    await expect(remove).toBeVisible();
    expect(
      await remove.evaluate((button) => {
        const wrapper = button.parentElement;
        return {
          previousIsDivider:
            wrapper?.previousElementSibling?.classList.contains(
              'bg-edge-default',
            ),
          nextIsDivider:
            wrapper?.nextElementSibling?.classList.contains('bg-edge-default'),
        };
      }),
    ).toEqual({ previousIsDivider: false, nextIsDivider: true });
    await more.click();
    await expect(remove).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Delete', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await remove.tap();
    await expect(node).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(node).toBeVisible();
    await flushSaves(page);
    await selectNote();
    await expect(node).toHaveClass(/selected/);
    await toolbar.getByRole('button', { name: 'Delete', exact: true }).tap();
    await expect(node).toHaveCount(0);
    await flushSaves(page);
    await page.reload();
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(node).toHaveCount(0);
  });
}

for (const kind of ['strokes', 'partial-strokes', 'nodes', 'mixed'] as const) {
  test(`Lasso ${kind} deletes directly and one Undo restores the selection contents`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({
          state: { inputModePreference: 'finger' },
          version: 0,
        }),
      ),
    );
    await openNewCanvas(page);
    const nodes =
      kind === 'nodes' ? [note] : kind === 'mixed' ? [note, ink] : [ink];
    await seed(page, [{ type: 'CREATE_NODES', nodes }]);
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes.length);
    await select(page, []);
    await page.keyboard.press('l');
    const boxes = await Promise.all(
      nodes.map((node) => page.locator(`[data-id="${node.id}"]`).boundingBox()),
    );
    if (boxes.some((box) => box === null))
      throw new Error('Lasso fixture is not visible');
    const bounds = boxes.filter((box) => box !== null);
    const left = Math.min(...bounds.map((box) => box.x)) - 20;
    const right = Math.max(...bounds.map((box) => box.x + box.width)) + 20;
    const top = Math.min(...bounds.map((box) => box.y)) - 20;
    const bottom =
      kind === 'partial-strokes'
        ? bounds[0].y + 45
        : Math.max(...bounds.map((box) => box.y + box.height)) + 20;
    const client = await page.context().newCDPSession(page);
    await oneFingerPath(client, [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
      { x: left, y: top },
    ]);
    const group = page.locator('.ink-edit-group');
    await expect(group).toBeVisible();
    await expect(group.locator('.lucide-ellipsis')).toHaveCount(0);
    await expect(group.getByRole('img')).toHaveCount(0);
    await expect(group.locator('.bg-edge-default')).toHaveCount(0);
    await group.getByRole('button', { name: 'Delete', exact: true }).tap();
    await expect(page.locator('.react-flow__node')).toHaveCount(
      kind === 'partial-strokes' ? 1 : 0,
    );
    if (kind === 'partial-strokes') {
      const strokeIds = await page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasModule;
        return store
          .getState()
          .nodes.find((node) => node.id === 'node-delete-ink')
          ?.data.strokes?.map((stroke) => stroke.id);
      });
      expect(strokeIds).toEqual(['stroke-keep']);
    }
    await expect(group).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes.length);
    if (kind !== 'nodes') {
      const strokes = await page.evaluate(async () => {
        const path = '/src/store/canvasStore.ts';
        const { default: store } = (await import(path)) as typeof CanvasModule;
        return store
          .getState()
          .nodes.find((node) => node.id === 'node-delete-ink')?.data.strokes;
      });
      expect(strokes).toEqual(ink.data.strokes);
    }
    await client.detach();
  });
}

test('single and multiple edge-only selections have direct Delete without deleting endpoints', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({
        state: { inputModePreference: 'finger' },
        version: 0,
      }),
    ),
  );
  await openNewCanvas(page);
  await seed(page, [
    {
      type: 'CREATE_NODES',
      nodes: ['a', 'b', 'c'].map((key, index) => ({
        ...note,
        id: `node-${key}`,
        position: { x: 100 + 330 * index, y: 350 },
      })),
    },
    {
      type: 'CONNECT_NODES',
      edges: [
        { id: 'edge-ab', source: 'node-a', target: 'node-b' },
        { id: 'edge-bc', source: 'node-b', target: 'node-c' },
      ],
    },
  ]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await select(page, [], ['edge-ab']);
  await page
    .locator('.edge-context-toolbar')
    .getByRole('button', { name: 'Delete Edge', exact: true })
    .tap();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).tap();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await select(page, [], ['edge-ab', 'edge-bc']);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(2);
  const toolbar = page.locator('.edge-context-toolbar');
  await expect(toolbar.getByRole('button')).toHaveCount(1);
  await toolbar
    .getByRole('button', { name: 'Delete selected', exact: true })
    .tap();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
});

for (const kind of ['frame', 'multiple-nodes'] as const) {
  test(`${kind} primary Delete removes only the selection and its descendants`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'huabu-sketch-tools',
        JSON.stringify({
          state: { inputModePreference: 'finger' },
          version: 0,
        }),
      ),
    );
    await openNewCanvas(page);
    const nodes = [
      { ...note, id: 'node-first', position: { x: 350, y: 320 } },
      { ...note, id: 'node-second', position: { x: 650, y: 320 } },
      { ...note, id: 'node-unselected', position: { x: 950, y: 320 } },
    ];
    const commands: CanvasCommand[] = [{ type: 'CREATE_NODES', nodes }];
    if (kind === 'frame') {
      commands.push(
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-frame',
              nodeType: 'frame',
              data: {
                label: 'Delete this Frame',
                sizing: 'manual',
                layoutMode: 'free',
              },
              position: { x: 300, y: 240 },
              size: { width: 640, height: 340 },
            },
          ],
        },
        {
          type: 'SET_NODE_PARENT',
          nodeIds: ['node-first', 'node-second'],
          parentId: 'node-frame',
        },
      );
    }
    await seed(page, commands);
    await expect(page.locator('[data-id="node-first"]')).toBeVisible();
    await select(
      page,
      kind === 'frame' ? ['node-frame'] : ['node-first', 'node-second'],
    );
    const toolbar = page.locator(
      kind === 'frame' ? '.node-floating-toolbar' : '.canvas-context-toolbar',
    );
    await toolbar
      .getByRole('button', {
        name: kind === 'frame' ? 'Delete' : 'Delete selected',
        exact: true,
      })
      .tap();
    await expect(page.locator('[data-id="node-first"]')).toHaveCount(0);
    await expect(page.locator('[data-id="node-second"]')).toHaveCount(0);
    await expect(page.locator('[data-id="node-frame"]')).toHaveCount(0);
    await expect(page.locator('[data-id="node-unselected"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(page.locator('[data-id="node-first"]')).toHaveCount(1);
    await expect(page.locator('[data-id="node-second"]')).toHaveCount(1);
    if (kind === 'frame') {
      await expect(page.locator('[data-id="node-frame"]')).toHaveCount(1);
    }
  });
}

test('explicit Mouse mode keeps Note Delete in More even on a touch device', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    ),
  );
  await openNewCanvas(page);
  await seed(page, [{ type: 'CREATE_NODES', nodes: [note] }]);
  await page
    .locator(`[data-id="${note.id}"]`)
    .click({ position: { x: 40, y: 10 } });
  const toolbar = page.locator('.node-floating-toolbar');
  await expect(
    toolbar.getByRole('button', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(page.locator(`[data-id="${note.id}"]`)).toHaveCount(0);
});

test('Agent deletion and Undo preserve its thread and content without a save conflict', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'finger' }, version: 0 }),
    ),
  );
  const conflicts: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 409 && response.url().includes('/api/canvas/')) {
      conflicts.push(response.url());
    }
  });
  await openNewCanvas(page);
  await seed(page, [
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'node-delete-agent',
          nodeType: 'question',
          position: { x: 350, y: 300 },
          data: {
            content: 'Preserve this Agent prompt',
            agentBinding: { kind: 'internal' },
          },
        },
      ],
    },
  ]);
  const node = page.locator('[data-id="node-delete-agent"]');
  await expect(node).toBeVisible();
  const readData = () =>
    page.evaluate(async () => {
      const path = '/src/store/canvasStore.ts';
      const { default: store } = (await import(path)) as typeof CanvasModule;
      return store
        .getState()
        .nodes.find((node) => node.id === 'node-delete-agent')?.data;
    });
  const original = await readData();
  expect(original?.threadId).toEqual(expect.any(String));
  for (let iteration = 0; iteration < 2; iteration++) {
    await select(page, ['node-delete-agent']);
    await page
      .locator('.node-floating-toolbar')
      .getByRole('button', { name: 'Delete', exact: true })
      .tap();
    await expect(node).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(node).toBeVisible();
    await flushSaves(page);
    expect(await readData()).toMatchObject({
      threadId: original?.threadId,
      content: 'Preserve this Agent prompt',
    });
    expect(conflicts).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'Load latest', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(node).toBeVisible();
    expect(await readData()).toMatchObject({
      threadId: original?.threadId,
      content: 'Preserve this Agent prompt',
    });
  }
});
