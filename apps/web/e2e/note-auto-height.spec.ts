// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { test, expect, type Page } from '@playwright/test';

import { openNewCanvas, paneCenter } from './helpers';

/**
 * The auto-height invariant, asserted in a real browser.
 *
 * An auto-height note derives its box from a measurement, so content that
 * does not fit is not a cosmetic complaint — it means the measurement
 * disagrees with what the browser laid out. Every height defect found so
 * far reduced to exactly that, and every one was found by eye.
 *
 * Unit tests cannot cover this: the failures live in CSS layout (a
 * border narrowing the content box, a margin collapsing out of the
 * measured element), and jsdom / happy-dom compute no layout at all.
 * A real engine is the only thing that can tell us the number is wrong.
 *
 * Fixtures are chosen for the *shapes* that broke it, not for coverage:
 * a leading heading (whose top margin can escape the measured box), a
 * heading mid-document (whose margin cannot), content that wraps, and a
 * list.
 */

const FIXTURES: Record<string, string> = {
  'leading h1': '# 最后一块钱\n\n末班车驶过巷口，路灯下的面摊还亮着灯。',
  'leading h2': '## 一个小标题\n\n下面跟着一段普通的正文，用来占据一些高度。',
  'heading mid-document':
    '开头是一段普通的正文。\n\n## 中间的标题\n\n后面还有一段。',
  'plain paragraphs':
    '第一段文字。\n\n第二段文字，稍微长一点，用来触发换行。\n\n第三段。',
  'wrapping paragraph':
    '这是一段足够长的文字，长到一定会在笔记的默认宽度下折行，' +
    '这样就能验证测量用的排版宽度和实际渲染用的排版宽度是一致的，' +
    '否则换行位置不同，高度就会差出整整一行。',
  list: '- 第一项\n- 第二项\n- 第三项，稍微长一些让它有机会折行\n- 第四项',
};

/**
 * Create a note by pasting markdown onto the canvas — the same path a
 * user takes. Multi-line text becomes a note node.
 */
async function pasteNote(page: Page, markdown: string): Promise<void> {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, markdown);
}

/**
 * Create a note through the same headless endpoint used by agents.
 * The open tab receives the server-authored insertion through canvas sync;
 * no UI creation path runs locally before the note is measured.
 */
async function executeAgentCommands(
  page: Page,
  commands: unknown[],
): Promise<Record<string, unknown>> {
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  if (!canvasId) throw new Error('canvas id not found in URL');

  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands,
      originator: { source: 'agent', threadId: 'e2e-auto-height' },
    },
  });

  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

async function createAgentNote(
  page: Page,
  markdown: string,
  parentId?: string,
): Promise<void> {
  await executeAgentCommands(page, [
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          nodeType: 'note',
          data: { label: 'Agent long note', content: markdown },
          position: { x: 100, y: 100 },
          size: { width: 560, height: 'auto' },
          ...(parentId ? { parentId } : {}),
        },
      ],
    },
  ]);
}

/**
 * For every mounted note, how many pixels its content overflows the box
 * it was given. The reader mirrors `readNoteIntrinsicHeight`: measure
 * `.ProseMirror` (not the host, whose `scrollHeight` Crepe's absolutely
 * positioned block handle inflates) and add the host's own padding back.
 */
async function measureOverflows(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const results: number[] = [];
    const hosts = document.querySelectorAll(
      '.react-flow__node [data-note-content-host]',
    );
    for (const host of hosts) {
      if (!(host instanceof HTMLElement)) continue;
      const prose = host.querySelector('.ProseMirror');
      if (!(prose instanceof HTMLElement)) continue;
      const style = getComputedStyle(host);
      const padY =
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0);
      results.push(prose.scrollHeight + padY - host.clientHeight);
    }
    return results;
  });
}

/**
 * Paste every fixture, one at a time, waiting for each note to appear.
 *
 * Sequencing matters. Firing all the pastes and asserting the total
 * afterwards is racy — the count settled at 5 of 6 — and it also hides
 * *which* fixture failed to land. Waiting after each keeps the failure
 * pointed at the paste that caused it.
 *
 * Everything lands at one point. Overlapping notes measure exactly the
 * same as spread-out ones, and keeping them at the viewport centre means
 * virtualization cannot unmount one and turn a measurement assertion
 * into a missing-element error.
 */
async function pasteAllFixtures(page: Page): Promise<string[]> {
  const names = Object.keys(FIXTURES);
  const centre = await paneCenter(page);
  await page.mouse.move(centre.x, centre.y);

  for (const [index, name] of names.entries()) {
    await pasteNote(page, FIXTURES[name]);
    await expect(
      page.locator('.react-flow__node'),
      `fixture "${name}" did not create a note`,
    ).toHaveCount(index + 1);
  }

  // Editor mounts are deferred one per frame by the hydration scheduler.
  await expect(
    page.locator('[data-note-content-host] .ProseMirror'),
  ).toHaveCount(names.length);
  return names;
}

test.describe('note auto height', () => {
  test('an agent-created long note replaces its initial height hint', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const markdown = Array.from(
      { length: 12 },
      (_, index) =>
        `## Section ${index + 1}\n\nThis paragraph is long enough to wrap at the note width and must contribute to the measured height.`,
    ).join('\n\n');

    await createAgentNote(page, markdown);

    const note = page.locator('.react-flow__node').filter({
      has: page.locator('[data-note-content-host]'),
    });
    await expect(note).toHaveCount(1);
    await expect(note.locator('.ProseMirror')).toHaveCount(1);

    await expect
      .poll(async () => {
        const height = await note.evaluate((element) =>
          parseFloat((element as HTMLElement).style.height),
        );
        return height;
      })
      .toBeGreaterThan(200);

    const [overflow] = await measureOverflows(page);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('an agent-created long note grows inside a structured frame', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const frameResponse = await executeAgentCommands(page, [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'frame',
            data: { label: 'Agent frame' },
            position: { x: 50, y: 50 },
          },
        ],
      },
    ]);
    const results = frameResponse.results as Array<{
      nodes?: Array<{ nodeId: string }>;
    }>;
    const frameId = results[0]?.nodes?.[0]?.nodeId;
    expect(frameId).toBeTruthy();

    await executeAgentCommands(page, [
      {
        type: 'SET_FRAME_LAYOUT',
        frameId,
        mode: 'column',
        gridCount: 1,
        sizing: 'hug',
      },
    ]);

    const markdown = Array.from(
      { length: 12 },
      (_, index) =>
        `## Framed section ${index + 1}\n\nThis paragraph must expand both the auto-height note and its structured parent frame.`,
    ).join('\n\n');
    await createAgentNote(page, markdown, frameId);

    const note = page.locator('.react-flow__node-note');
    await expect(note.locator('.ProseMirror')).toHaveCount(1);
    await expect
      .poll(() =>
        note.evaluate((element) =>
          parseFloat((element as HTMLElement).style.height),
        ),
      )
      .toBeGreaterThan(200);

    const [overflow] = await measureOverflows(page);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('a manually pasted note grows after mounted editing', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const centre = await paneCenter(page);
    await page.mouse.move(centre.x, centre.y);
    await pasteNote(page, 'Short note\n\nInitial body.');

    const note = page.locator('.react-flow__node-note');
    await expect(note.locator('.ProseMirror')).toHaveCount(1);
    const initialHeight = await note.evaluate((element) =>
      parseFloat((element as HTMLElement).style.height),
    );

    const editor = page.locator(
      '[data-search-scope="node"] .ProseMirror[contenteditable="true"]',
    );
    await expect(editor).toHaveCount(1);

    const longContent = Array.from(
      { length: 12 },
      (_, index) =>
        `Section ${index + 1}. This manually edited paragraph is long enough to wrap and must expand the mounted note.`,
    ).join('\n\n');
    await editor.fill(longContent);
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await expect
      .poll(() =>
        note.evaluate((element) =>
          parseFloat((element as HTMLElement).style.height),
        ),
      )
      .toBeGreaterThan(initialHeight + 100);

    const [overflow] = await measureOverflows(page);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('every auto note fits the content it was measured from', async ({
    page,
  }) => {
    await openNewCanvas(page);
    const names = await pasteAllFixtures(page);

    // Measurement is asynchronous by design: propose, queue, commit.
    await page.waitForTimeout(1500);

    const overflows = await measureOverflows(page);
    expect(overflows).toHaveLength(names.length);

    // A positive overflow means the note is shorter than the content it
    // was sized from. Quantization can only ever make the box larger, so
    // the only tolerance needed is sub-pixel.
    for (const [index, overflow] of overflows.entries()) {
      expect(
        overflow,
        `note "${names[index]}" overflows its box by ${Math.round(overflow)}px`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('the running app reports no height-invariant violations', async ({
    page,
  }) => {
    // The dev build warns when an auto note still does not fit once the
    // commit queue has settled. Asserting on it here keeps the two
    // layers honest: whatever the invariant hook can see, this test
    // fails on.
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('[height] auto note')) {
        violations.push(message.text());
      }
    });

    await openNewCanvas(page);
    await pasteAllFixtures(page);
    await page.waitForTimeout(2000);

    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('a narrow note still fits its content', async ({ page }) => {
    // A note narrower than the reference width is the case a legibility
    // floor on the content scale used to break: once the floor engaged,
    // the content laid out narrower than the width its height had been
    // measured at, so the note rendered short. Nothing keeps a tiny note
    // readable except semantic zoom, which replaces the body outright.
    await openNewCanvas(page);
    const centre = await paneCenter(page);
    await page.mouse.move(centre.x, centre.y);
    await pasteNote(page, FIXTURES['wrapping paragraph']);
    await expect(
      page.locator('[data-note-content-host] .ProseMirror'),
    ).toHaveCount(1);

    // A pasted node arrives selected, so its toolbar is already up — and
    // clicking the node would be intercepted by the canvas overlay
    // anyway. Editing only the width must leave the note auto, which is
    // the second thing this asserts: the toolbar has to read ownership
    // rather than infer it from the presence of a number.
    const widthInput = page.getByLabel('Width', { exact: true });
    await widthInput.fill('155');
    await widthInput.press('Enter');
    await page.waitForTimeout(2000);

    await expect(
      page.getByRole('button', { name: 'Switch to fixed height' }),
      'a width-only edit must not pin the height',
    ).toBeVisible();

    const [overflow] = await measureOverflows(page);
    expect(
      overflow,
      `narrow note overflows its box by ${Math.round(overflow)}px`,
    ).toBeLessThanOrEqual(1);
  });
});
