// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Does a deployment on this storage profile actually work?
 *
 * Every other suite in the Phase 6 campaign asks a narrower question: does the
 * adapter honour the port, does the dispatcher route, does the event log
 * serialize. This one asks the only question a user would: I made a Space, I
 * asked an Agent for something, I attached a file — is it all still there
 * tomorrow, when the server is a different process?
 *
 * Two tests, split by what they need. The first needs only the profile, so it
 * runs anywhere. The second drives a **real** model turn and needs provider
 * credentials staged into the run's data dir; without them it skips, because a
 * stubbed turn would prove nothing here — a conversation recovered from the
 * backend is evidence only if something real produced it.
 *
 * The restart in the middle of each is the load-bearing step. A page reload
 * only proves the server still remembers; replacing the process is what makes
 * "durable" mean the backend.
 */

import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { restartBackend } from './storage-profile-server';

const NOTE_TEXT = 'Postgres and Azure profile proof.';
/**
 * A fact that exists only in the conversation.
 *
 * `NOTE_TEXT` is the wrong thing to ask a recovered Agent about: it is also on
 * the Space, in the Note the first turn created, so a model that lost its
 * history entirely could still answer by reading the canvas in front of it.
 * This codeword is never written anywhere the Agent can inspect — the test
 * asserts as much against the Space the server holds — so quoting it back
 * after a restart is only possible from recovered conversation history. Minted
 * per run, so a provider-side cache cannot supply it either.
 */
const CODEWORD = `huabu-${randomUUID().slice(0, 8)}`;
const PROFILE = process.env.E2E_STORAGE_PROFILE ?? 'unknown';

/** A PNG built in-process, so the bytes that come back can be compared to bytes that went out. */
function fixturePng(): Buffer {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = (x * 4) % 256;
      raw[offset + 1] = (y * 4) % 256;
      raw[offset + 2] = 128;
    }
  }
  // A Uint32Array rather than a plain array: the index is masked into range,
  // and a typed array says so in the type instead of needing an assertion.
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer)
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const body = await page.screenshot();
  await testInfo.attach(`${PROFILE} — ${name}`, {
    body,
    contentType: 'image/png',
  });
}

async function openNewSpace(page: Page): Promise<string> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /New Space|Create your first Space/i })
    .first()
    .click();
  await page.waitForURL(/\/canvas\//);
  await page.waitForSelector('.react-flow__viewport');
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  if (!canvasId) throw new Error('Space route carried no canvas id');
  return canvasId;
}

/** Every image node's decoded width, which is zero unless the bytes really arrived. */
async function decodedImageWidths(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node img')]
      .filter((img): img is HTMLImageElement => img instanceof HTMLImageElement)
      .map((img) => img.naturalWidth),
  );
}

/**
 * The Note carrying the proof text, **on the canvas**.
 *
 * Scoped deliberately. The prompt the Agent test sends quotes the same string,
 * so an unscoped text match would be satisfied by the user's own message and
 * the assertion would pass without the Agent having done anything.
 */
function noteOnCanvas(page: Page) {
  return page
    .locator('.react-flow__node-note')
    .filter({ hasText: NOTE_TEXT })
    .first();
}

/**
 * The Agent's own prose replies, which render as read-only editors inside the
 * preview region. User messages are plain nodes and the canvas is outside the
 * region, so this reaches what the model said and nothing else.
 */
function agentReplies(page: Page) {
  return page
    .getByRole('region', { name: 'Preview group' })
    .getByRole('textbox', { name: 'Read-only content' });
}

/**
 * Wait until the *server* holds what the browser shows.
 *
 * Both halves of a node reach the server on their own debounced schedule: the
 * Space's structure carries the node's existence, a separate request carries
 * its body. Restarting as soon as the canvas *looks* right races whichever of
 * the two has not left the page yet, and a write the server never received
 * says nothing about whether the backend is durable. That race belongs to the
 * test, not to the backend, so it is closed here rather than slept through.
 */
async function waitForServerToHold(
  page: Page,
  canvasId: string,
  expectations: { structure: readonly string[]; body?: [string, string] },
): Promise<void> {
  for (const fragment of expectations.structure) {
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/canvas/${canvasId}`);
          return response.ok() ? await response.text() : '';
        },
        { timeout: 30_000 },
      )
      .toContain(fragment);
  }
  if (!expectations.body) return;
  const [nodeId, text] = expectations.body;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/canvas/${canvasId}/nodes/${nodeId}/content`,
        );
        return response.ok() ? await response.text() : '';
      },
      { timeout: 30_000 },
    )
    .toContain(text);
}

/**
 * Assert the codeword reached no part of the Space the server holds.
 *
 * `/api/canvas/<id>` carries the structure; each node's text lives behind its
 * own content route, so the structure payload alone would not notice a
 * codeword written into the Note. Node ids are read straight out of the
 * structure text rather than through a schema, which keeps this from having an
 * opinion about the canvas wire format.
 */
async function expectCodewordOffTheSpace(
  page: Page,
  canvasId: string,
): Promise<void> {
  const structure = await page.request.get(`/api/canvas/${canvasId}`);
  // A failed read would make every assertion below vacuous, which is the same
  // false pass this helper exists to close.
  expect(structure.ok()).toBe(true);
  const structureText = await structure.text();
  expect(structureText).not.toContain(CODEWORD);
  const nodeIds = new Set(
    [...structureText.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  for (const nodeId of nodeIds) {
    const content = await page.request.get(
      `/api/canvas/${canvasId}/nodes/${encodeURIComponent(nodeId)}/content`,
    );
    if (content.ok()) expect(await content.text()).not.toContain(CODEWORD);
  }
}

/**
 * The thread the chat panel is working in, learned from its own traffic.
 *
 * The panel loads history over `/api/agent/history/<threadId>`, so watching
 * requests is enough; nothing in the DOM carries the id, and the test has no
 * business reading it out of the database.
 */
function watchThreadId(page: Page): () => string | undefined {
  let threadId: string | undefined;
  page.on('request', (request) => {
    const match = /\/api\/agent\/history\/([^/?]+)/.exec(request.url());
    if (match?.[1] && !threadId) threadId = decodeURIComponent(match[1]);
  });
  return () => threadId;
}

interface HistoryTurn {
  readonly messages?: ReadonlyArray<{ readonly content?: string }>;
}

/** The durable conversation as the product serves it to the panel. */
async function readHistoryTurns(
  page: Page,
  canvasId: string,
  threadId: () => string | undefined,
): Promise<HistoryTurn[] | null> {
  const id = threadId();
  if (!id) return null;
  const response = await page.request.get(
    `/api/agent/history/${encodeURIComponent(id)}/page?canvasId=${canvasId}&limit=20`,
  );
  if (!response.ok()) return null;
  return ((await response.json()) as { turns?: HistoryTurn[] }).turns ?? null;
}

/**
 * Wait until the conversation reports `count` turns.
 *
 * A caution the endpoint forces on the caller: asked for the newest page it
 * answers with `withTail: true`, so an **uncommitted** Tier-1 tail is
 * materialized into the list alongside committed turns, and nothing in the
 * response distinguishes them — `isIncomplete` never reaches the wire. So this
 * count alone is not evidence that anything folded. What discriminates is the
 * *final* state, once a later turn has folded: a turn that committed is still
 * there, and one that never committed is gone, because the read fence is the
 * last folded turn's `seqEnd`.
 */
async function waitForHistoryTurns(
  page: Page,
  canvasId: string,
  threadId: () => string | undefined,
  count: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await readHistoryTurns(page, canvasId, threadId))?.length ?? -1,
      { timeout: 150_000 },
    )
    .toBe(count);
}

async function attachFixtureImage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add Content' }).click();
  await page.getByRole('menuitem', { name: 'Upload Files' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Click to select files' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'storage-profile-proof.png',
    mimeType: 'image/png',
    buffer: fixturePng(),
  });
}

test.describe(`storage profile ${PROFILE}`, () => {
  test('keeps a Space, its nodes and its attached bytes across a server restart', async ({
    page,
  }, testInfo) => {
    const canvasId = await openNewSpace(page);
    const previewPanel = page.locator('[data-canvas-panel="right"]');
    await expect(previewPanel).toBeAttached();
    if ((await previewPanel.getAttribute('data-collapsed')) !== 'true') {
      await page.getByRole('button', { name: 'Collapse previews' }).click();
    }
    await expect(previewPanel).toBeHidden();

    const paneBox = await page.locator('.react-flow__pane').boundingBox();
    if (!paneBox) throw new Error('React Flow pane was not laid out');
    await expect(page.locator('[data-canvas-root]')).toHaveClass(
      /canvas-pending-note/,
    );
    await expect(page.locator('.react-flow__node-note')).toHaveCount(0);
    await page.mouse.click(
      paneBox.x + paneBox.width / 2,
      paneBox.y + paneBox.height / 2,
    );
    const note = page.locator('.react-flow__node-note');
    await expect(note).toHaveCount(1);
    await expect(note).toBeVisible();
    const noteId = await note.getAttribute('data-id');
    if (!noteId) throw new Error('The created Note exposed no stable id');
    // A Note renders read-only until it is opened, so the text goes in the
    // same way the rest of the e2e suite puts it there.
    await note.dblclick();
    const editor = page.locator(
      '[data-search-scope="node"] .ProseMirror[contenteditable="true"]',
    );
    await expect(editor).toBeVisible();
    await editor.fill(NOTE_TEXT);
    await page
      .getByRole('tab', { selected: true })
      .getByRole('button', { name: /^Close / })
      .click();

    await attachFixtureImage(page);
    await expect
      .poll(async () => (await decodedImageWidths(page)).filter(Boolean).length)
      .toBe(1);
    const imageId = await page
      .locator('.react-flow__node')
      .filter({ has: page.locator('img') })
      .first()
      .getAttribute('data-id');
    if (!imageId) throw new Error('The uploaded image node exposed no id');
    // The node ids must be in the Space the server holds, and the Note's body
    // must be there too, before the process is allowed to go away.
    await waitForServerToHold(page, canvasId, {
      structure: [noteId, imageId],
      body: [noteId, NOTE_TEXT],
    });
    await shot(page, testInfo, 'before restart');

    // Everything above has reached the server. Taking the process away is what
    // turns "the server received it" into "the backend holds it".
    await restartBackend();

    await page.goto(`/canvas/${canvasId}`);
    await page.waitForSelector('.react-flow__viewport');
    await expect(note).toHaveCount(1);
    await expect(note).toHaveAttribute('data-id', noteId);
    await expect(noteOnCanvas(page)).toBeVisible();
    // Non-zero decoded width is the byte-level claim: the blob backend served
    // the image again, from wherever this profile put it.
    await expect
      .poll(async () => (await decodedImageWidths(page)).filter(Boolean).length)
      .toBe(1);
    await shot(page, testInfo, 'after restart');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Spaces' })).toBeVisible();
    await expect(page.locator(`a[href*="${canvasId}"]`).first()).toBeVisible();
  });

  test('recovers an Agent conversation from the backend after a restart', async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.E2E_LLM_READY !== 'true',
      'No provider credentials were staged; a stubbed turn would not prove recovery',
    );

    const threadId = watchThreadId(page);
    const canvasId = await openNewSpace(page);
    const composer = page.getByRole('textbox', {
      name: /Describe the Space change/i,
    });
    await composer.fill(
      `Remember this codeword for later: ${CODEWORD}. Do not write the ` +
        `codeword on the Space or in the Note. Create a single Note on this ` +
        `Space whose text is exactly: ${NOTE_TEXT} Then stop.`,
    );
    await composer.press('Enter');

    // The Space changed — the Note the model was asked for, written through
    // this profile's structured backend.
    await expect(noteOnCanvas(page)).toBeVisible({ timeout: 150_000 });
    // …and the turn then ran to the end. The tool call lands mid-stream, so
    // the canvas changing is not the turn finishing: the model's own reply is
    // the last thing it emits, and the fold follows it. Restarting on the
    // canvas signal alone kills the process mid-turn.
    await expect(agentReplies(page).first()).toBeVisible({ timeout: 150_000 });
    await waitForHistoryTurns(page, canvasId, threadId, 1);
    // What makes the codeword evidence: the Space the server holds does not
    // contain it, so after the restart there is nowhere but recovered history
    // for the model to have read it from. Structure and node bodies are served
    // separately, and the body is where a model that ignored the instruction
    // would have put it, so both are checked. A failure here is the premise
    // collapsing rather than a recovery bug, and it should be loud either way.
    await expectCodewordOffTheSpace(page, canvasId);
    const repliesBeforeRestart = await agentReplies(page).count();
    await shot(page, testInfo, 'first turn');

    await restartBackend();

    await page.goto(`/canvas/${canvasId}`);
    await page.waitForSelector('.react-flow__viewport');
    // Tier 2 came back: the conversation reads as it did before the process
    // was replaced, prompt and replies alike.
    await expect(
      page.getByText(/Create a single Note on this Space/).first(),
    ).toBeVisible();
    await expect(agentReplies(page)).toHaveCount(repliesBeforeRestart);

    const second = page.getByRole('textbox', {
      name: /Describe the Space change/i,
    });
    await second.fill(
      'What codeword did I ask you to remember, and what exact text did you ' +
        'put in the Note you created earlier? Answer in one short sentence, ' +
        'and do not change the Space.',
    );
    await second.press('Enter');

    // The sharpest claim in the suite. A new process, a new handle, and a
    // driver whose only knowledge of the earlier turn is what the backend
    // handed back as recovery input. If history did not survive, the model
    // cannot answer this — and the assertion reads the *new* reply, not the
    // prompt that quotes the same string.
    const answer = agentReplies(page).nth(repliesBeforeRestart);
    await expect(answer).toBeVisible({ timeout: 150_000 });
    // The codeword first: it was asserted absent from the Space above, so the
    // only place it can have come from is the recovered conversation. The
    // Note's text is the weaker of the two — the Note is still on the canvas
    // — but it stays, because it is the claim the Space half of the profile
    // makes and a regression there should not hide behind the codeword.
    await expect(answer).toContainText(CODEWORD, { timeout: 150_000 });
    await expect(answer).toContainText(NOTE_TEXT, { timeout: 150_000 });
    // The discriminating assertion. Now that a later turn has folded, the read
    // fence sits at its `seqEnd`, so anything the first turn left uncommitted
    // is unreachable. Two turns here means the first one really did commit
    // before the process died; one turn means it never did and has now gone
    // silently, taking the prompt that created the Note with it.
    await waitForHistoryTurns(page, canvasId, threadId, 2);
    const turns = await readHistoryTurns(page, canvasId, threadId);
    expect(turns?.[0]?.messages?.[0]?.content).toContain(
      'Create a single Note on this Space',
    );
    await shot(page, testInfo, 'second turn after restart');
  });
});
