// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import type * as MessageListModule from '../src/components/Messages/MessageList';
import type * as SessionModule from '../src/hooks/useChatSession';
import type { AssistantSegment, ChatMessage } from '../src/store/chatTypes';
import type { GenericToolPart } from '@huabu/shared';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

declare global {
  interface Window {
    activityFixture: {
      render: (
        segments: AssistantSegment[],
        streaming: boolean,
        endStatus?: 'interrupted' | 'error',
      ) => void;
    };
  }
}

test.use({ hasTouch: false });

function tool(id: string, title = `Reading file ${id}`): GenericToolPart {
  return {
    kind: 'tool',
    variant: 'generic',
    toolCallId: id,
    title,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: `Full output for ${id}` },
      },
    ],
  };
}

const initial: AssistantSegment[] = [
  tool('a'),
  { kind: 'thinking', text: 'Checking references\n\nFull reasoning detail' },
  tool('b'),
  { kind: 'thinking', text: 'Comparing the findings' },
];
const prose: AssistantSegment = {
  kind: 'text',
  text: '## Final answer\n\nThe requested changes are ready.',
};

function fixture(page: Page) {
  return page.locator('#activity-fixture');
}

function activity(page: Page, index = 0) {
  return fixture(page).locator('[data-assistant-activity]').nth(index);
}

function header(page: Page, index = 0) {
  return activity(page, index).getByRole('button').first();
}

async function expectInlineDisclosure(button: Locator, prose: Locator) {
  const title = await button.locator(':scope > span').last().boundingBox();
  const arrow = await button.locator(':scope > svg').boundingBox();
  const body = await prose.boundingBox();
  const bounds = await button.boundingBox();
  if (!title || !arrow || !body || !bounds) {
    throw new Error('Missing visible disclosure or prose bounds');
  }
  expect(Math.abs(title.x - body.x)).toBeLessThanOrEqual(1);
  const gap = arrow.x - title.x - title.width;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
  expect(arrow.x + arrow.width).toBeLessThanOrEqual(
    bounds.x + bounds.width + 1,
  );
}

async function update(
  page: Page,
  segments: AssistantSegment[],
  streaming = true,
  endStatus?: 'interrupted' | 'error',
) {
  await page.evaluate(
    ({ segments, streaming, endStatus }) =>
      window.activityFixture.render(segments, streaming, endStatus),
    { segments, streaming, endStatus },
  );
}

async function mount(page: Page, historyCount = 0, segments = initial) {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  await page.goto('/playground/chat-performance?messages=2');
  await expect(page.locator('textarea[name="agent-message"]')).toBeVisible();
  await page.evaluate(
    async ({ initial, historyCount }) => {
      const loaded = (suffix: string) => {
        const entry = performance
          .getEntriesByType('resource')
          .find((resource) => new URL(resource.name).pathname.endsWith(suffix));
        if (!entry) throw new Error(`Missing loaded module: ${suffix}`);
        return entry.name;
      };
      const [
        { default: React },
        { default: ReactDOM },
        { MessageList },
        { ChatSessionProvider },
      ] = await Promise.all([
        import(loaded('/deps/react.js')) as Promise<{
          default: typeof ReactModule;
        }>,
        import(loaded('/deps/react-dom_client.js')) as Promise<{
          default: typeof ReactDOMModule;
        }>,
        import(loaded('/Messages/MessageList.tsx')) as Promise<
          typeof MessageListModule
        >,
        import(loaded('/useChatSession.ts')) as Promise<typeof SessionModule>,
      ]);
      const original = document.querySelector<HTMLElement>(
        '[data-chat-performance-fixture]',
      );
      if (!original) throw new Error('Missing original fixture');
      original.style.display = 'none';
      const host = document.createElement('main');
      host.id = 'activity-fixture';
      host.className = 'bg-bg-default flex flex-col';
      Object.assign(host.style, {
        position: 'fixed',
        top: '32px',
        left: '32px',
        width: '640px',
        height: '560px',
      });
      document.body.append(host);
      const root = ReactDOM.createRoot(host);
      const history: ChatMessage[] = Array.from(
        { length: historyCount },
        (_, index) => ({
          id: `history-${index}`,
          role: 'user',
          content: `Earlier question ${index}: retain my reading position while the agent continues inspecting the source files and prepares the next answer.`,
        }),
      );
      const session = {
        threadId: 'activity-test',
        canvasId: 'activity-canvas',
        ownerCanvasId: 'activity-canvas',
        conversationView: null,
      };
      window.activityFixture = {
        render(segments, streaming, endStatus) {
          const messages: ChatMessage[] = [
            ...history,
            { id: 'current-user', role: 'user', content: 'Inspect the files' },
            { id: 'current-assistant', role: 'assistant', segments },
          ];
          if (endStatus) {
            messages.push({
              id: 'current-status',
              role: 'status',
              status: endStatus,
            });
          }
          root.render(
            React.createElement(
              ChatSessionProvider,
              { value: session },
              React.createElement(MessageList, {
                messages,
                isLoading: streaming,
                viewKey: 'activity-test-view',
              }),
              React.createElement('textarea', {
                'aria-label': 'Fixture draft',
                defaultValue: 'Keep this draft',
              }),
            ),
          );
        },
      };
      window.activityFixture.render(initial, true);
    },
    { initial: segments, historyCount },
  );
  await expect(
    fixture(page).locator('[data-chat-message-id="current-assistant"]'),
  ).toBeVisible();
}

test('live operations form one visible block; prose closes it without losing calls', async ({
  page,
}) => {
  await mount(page);
  await expect(fixture(page).locator('[data-assistant-activity]')).toHaveCount(
    1,
  );
  await expect(header(page)).toHaveText('Working… · 4 steps');
  await expect(header(page).locator('svg')).toHaveCount(2);
  await expect(
    activity(page)
      .getByRole('button', { name: 'Reading file a' })
      .locator('svg'),
  ).toHaveCount(2);
  await expect(
    activity(page)
      .locator('[data-assistant-thinking]')
      .first()
      .locator('span[aria-hidden="true"]'),
  ).toHaveCount(1);
  await expect(
    activity(page).getByText('Reading file a', { exact: true }),
  ).toBeVisible();
  await expect(
    activity(page).getByText('Comparing the findings', { exact: true }),
  ).toBeVisible();
  await expect(
    activity(page).getByText('Full output for a', { exact: true }),
  ).toHaveCount(0);
  await update(page, [...initial, tool('c')]);
  await expect(
    activity(page).getByText('Reading file c', { exact: true }),
  ).toBeVisible();
  await update(page, [...initial, tool('c'), prose]);
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(header(page)).toHaveText('Completed 5 steps');
  await expect(header(page).locator('svg')).toHaveCount(1);
  await expect(header(page).locator(':scope > span').first()).toHaveText(
    'Completed 5 steps',
  );
  await expect(
    fixture(page).getByRole('heading', { name: 'Final answer' }),
  ).toBeVisible();
  await update(page, [...initial, tool('c'), prose], false);
  await header(page).click();
  for (const id of ['a', 'b', 'c']) {
    await activity(page)
      .getByRole('button', { name: `Reading file ${id}` })
      .click();
    await expect(
      activity(page).getByText(`Full output for ${id}`, { exact: true }),
    ).toBeVisible();
  }
});

const singletonCases: Array<{
  name: string;
  segments: AssistantSegment[];
  title: string;
}> = [
  { name: 'one tool', segments: [tool('a')], title: 'Reading file a' },
  {
    name: 'one thinking row',
    segments: [{ kind: 'thinking', text: '**Checking references**' }],
    title: 'Checking references',
  },
  {
    name: 'three reads already merged into one row',
    segments: Array.from({ length: 3 }, (_, index) => ({
      kind: 'tool',
      variant: 'agent_tool',
      toolName: 'read',
      toolCallId: `read-${index}`,
      title: 'Read',
      status: 'completed',
      data: {
        tool: 'read',
        status: 'success',
        data: { path: `file-${index}.ts` },
      },
    })),
    title: 'Read 3 files',
  },
];

for (const { name, segments, title } of singletonCases) {
  test(`${name} stays directly visible after completion without an outer group`, async ({
    page,
  }) => {
    await mount(page, 0, segments);
    await expect(
      fixture(page).locator('[data-assistant-activity]'),
    ).toHaveCount(0);
    await expect(fixture(page).getByText(title, { exact: true })).toBeVisible();
    await update(page, [...segments, prose], false);
    await expect(
      fixture(page).locator('[data-assistant-activity]'),
    ).toHaveCount(0);
    await expect(fixture(page).getByText(title, { exact: true })).toBeVisible();
    if (name === 'one thinking row') {
      const thinking = fixture(page).locator('[data-assistant-thinking]');
      await expect(thinking.getByRole('button')).toHaveCount(0);
      await expect(thinking.locator('span[aria-hidden]')).toHaveCount(0);
      await expect(thinking.locator('p')).toHaveCount(0);
      await expect(thinking).toHaveText(title);
      await expect(
        thinking.locator('.milkdown, [contenteditable], strong'),
      ).toHaveCount(0);
      await expect(thinking).not.toContainText('**');
      return;
    }
    const call = fixture(page).getByRole('button', {
      name: title,
      exact: true,
    });
    await expect(call.locator('svg')).toHaveCount(1);
    await expect(call.locator(':scope > span').first()).toHaveText(title);
    await expectInlineDisclosure(
      call,
      fixture(page).getByText('The requested changes are ready.', {
        exact: true,
      }),
    );
    if (name === 'three reads already merged into one row') {
      await update(
        page,
        [...segments, { kind: 'thinking', text: 'Checking the merged reads' }],
        false,
      );
      await header(page).click();
      await expect(call.locator('..').locator('svg')).toHaveCount(3);
    }
  });
}

test('activity and tool titles align with prose and keep arrows inline at narrow widths', async ({
  page,
}) => {
  await mount(page);
  const body = fixture(page).getByText('The requested changes are ready.', {
    exact: true,
  });
  const longTitle = 'Read an unusually long source path '.repeat(12);
  await update(page, [...initial, prose, tool('long', longTitle)], false);
  await expect(body).toBeVisible();
  await expectInlineDisclosure(header(page), body);
  const call = fixture(page).getByRole('button', {
    name: longTitle.trim(),
    exact: true,
  });
  await expectInlineDisclosure(call, body);
  await fixture(page).evaluate((element) => {
    element.style.width = '280px';
  });
  await expectInlineDisclosure(header(page), body);
  await expectInlineDisclosure(call, body);
  await update(
    page,
    [...initial, prose, { ...tool('failed'), status: 'failed' }],
    false,
  );
  await expectInlineDisclosure(
    fixture(page).getByRole('button', { name: 'Reading file failed' }),
    body,
  );
  await update(page, [prose, ...initial]);
  await expect(header(page)).toHaveText('Working… · 4 steps');
  await expectInlineDisclosure(header(page), body);
});

test('growing a singleton into a group preserves open tool details and focus', async ({
  page,
}) => {
  await mount(page, 0, [tool('a')]);
  const call = fixture(page).getByRole('button', { name: 'Reading file a' });
  await expect(call.locator('svg')).toHaveCount(1);
  await call.click();
  const bodyId = await call.getAttribute('aria-controls');
  await update(page, [tool('a'), tool('b')]);
  await expect(header(page)).toHaveText('Working… · 2 steps');
  await expect(call.locator('svg')).toHaveCount(2);
  await expect(call).toBeFocused();
  await expect(
    fixture(page).getByText('Full output for a', { exact: true }),
  ).toBeVisible();
  expect(await call.getAttribute('aria-controls')).toBe(bodyId);
  await update(page, [tool('a'), tool('b')], false);
  await expect(header(page)).toHaveText('Completed 2 steps');
  await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(call).toBeFocused();
});

test('long thinking inside an activity renders fully without its own disclosure or truncation', async ({
  page,
}) => {
  const paragraphs = Array.from(
    { length: 24 },
    (_, i) => `Reasoning paragraph ${i + 1}.`,
  );
  const segments: AssistantSegment[] = [
    {
      kind: 'thinking',
      text: `**Checking references**\n\n${paragraphs.join('\n\n')}`,
    },
    tool('a'),
  ];
  await mount(page, 0, [
    { kind: 'thinking', text: `**Checking references**\n\n${paragraphs[0]}` },
    tool('a'),
  ]);
  await expect(
    fixture(page).getByText(paragraphs[0], { exact: true }),
  ).toBeVisible();
  await update(page, segments);
  const thinking = fixture(page).locator('[data-assistant-thinking]');
  await expect(thinking.locator('p').first()).toHaveText('Checking references');
  await expect(
    thinking.locator('.milkdown, [contenteditable], strong'),
  ).toHaveCount(0);
  await expect(thinking.locator('p')).toHaveCount(25);
  await update(page, segments, false);
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
  await header(page).click();
  await expect(
    thinking.getByText(paragraphs[23], { exact: true }),
  ).toBeVisible();
  await expect(thinking.getByRole('button')).toHaveCount(0);
  const bounds = await thinking.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const paragraphs = [...element.querySelectorAll('p')].map((p) =>
      p.getBoundingClientRect(),
    );
    return {
      height: container.height,
      top: container.top,
      bottom: container.bottom,
      contentTop: Math.min(...paragraphs.map((p) => p.top)),
      contentBottom: Math.max(...paragraphs.map((p) => p.bottom)),
    };
  });
  expect(bounds.height).toBeGreaterThan(400);
  expect(bounds.contentTop).toBeGreaterThanOrEqual(bounds.top);
  expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.bottom + 1);
});

test('standalone thinking switches from a summary to full text when it joins an activity', async ({
  page,
}) => {
  const text: AssistantSegment = {
    kind: 'thinking',
    text: '**Checking references**\n\nAll details',
  };
  await mount(page, 0, [text]);
  const thinking = fixture(page).locator('[data-assistant-thinking]');
  await expect(
    thinking.getByRole('button', { name: 'Checking references' }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(thinking.getByText('All details', { exact: true })).toHaveCount(
    0,
  );
  await update(page, [text, tool('a')]);
  await expect(thinking.getByRole('button')).toHaveCount(0);
  await expect(
    thinking.getByText('All details', { exact: true }),
  ).toBeVisible();
});

test('inline thinking matches ordinary tool typography, row padding and alignment', async ({
  page,
}) => {
  const segments: AssistantSegment[] = [
    { kind: 'thinking', text: 'Checking references\n\nAll details' },
    tool('a'),
  ];
  await mount(page, 0, segments);
  const thinking = fixture(page).locator('[data-assistant-thinking]');
  const paragraph = thinking.locator('p').first();
  const call = fixture(page).getByRole('button', { name: 'Reading file a' });
  const typography = (element: Element) => {
    const style = getComputedStyle(element);
    return {
      size: style.fontSize,
      lineHeight: style.lineHeight,
      weight: style.fontWeight,
    };
  };
  const padding = (element: Element) => {
    const style = getComputedStyle(element);
    return {
      top: style.paddingTop,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    };
  };
  expect(await paragraph.evaluate(typography)).toEqual(
    await call.evaluate(typography),
  );
  expect(await paragraph.locator('..').locator('..').evaluate(padding)).toEqual(
    await call.locator('..').evaluate(padding),
  );
  expect(
    await paragraph
      .locator('..')
      .evaluate((element) => getComputedStyle(element).rowGap),
  ).toBe('4px');
  await expectInlineDisclosure(call, paragraph);
  await update(page, [
    { kind: 'thinking', text: 'Checking references' },
    tool('a'),
  ]);
  const thinkingRow = await paragraph.locator('..').locator('..').boundingBox();
  const toolRow = await call.locator('..').boundingBox();
  expect(thinkingRow?.height).toBe(toolRow?.height);
});

test('thinking keeps code identifiers and generics intact as streaming text becomes complete', async ({
  page,
}) => {
  await mount(page, 0, [
    { kind: 'thinking', text: 'Read `use_agent_stream.ts' },
    tool('a'),
  ]);
  await update(page, [
    {
      kind: 'thinking',
      text: 'Read `use_agent_stream.ts` as `Array<T>`\n\n`**literal**`',
    },
    tool('a'),
  ]);
  const thinking = fixture(page).locator('[data-assistant-thinking]');
  await expect(thinking.locator('p')).toHaveText([
    'Read use_agent_stream.ts as Array<T>',
    '**literal**',
  ]);
  await expect(thinking.locator('strong, code, t, .milkdown')).toHaveCount(0);
});

test('all built-in tool row branches share ordinary tool spacing and typography', async ({
  page,
}) => {
  const thinking: AssistantSegment = {
    kind: 'thinking',
    text: 'Checking references',
  };
  await mount(page, 0, [thinking, tool('a')]);
  const metrics = (element: Element) => {
    const row = element.closest('div.relative');
    if (!row) throw new Error('Missing tool row');
    const rowStyle = getComputedStyle(row);
    return {
      font: rowStyle.fontSize,
      lineHeight: rowStyle.lineHeight,
      padding: [
        rowStyle.paddingTop,
        rowStyle.paddingRight,
        rowStyle.paddingBottom,
        rowStyle.paddingLeft,
      ],
    };
  };
  const expected = await fixture(page)
    .getByText('Reading file a', { exact: true })
    .evaluate(metrics);
  const read = (id: string): AssistantSegment => ({
    kind: 'tool',
    variant: 'agent_tool',
    toolCallId: id,
    toolName: 'read',
    title: 'Read',
    status: 'completed',
    data: { tool: 'read', status: 'success', data: { path: `${id}.ts` } },
  });
  const cases: Array<{ parts: AssistantSegment[]; label: string }> = [
    { parts: [read('density')], label: 'density.ts' },
    { parts: [read('first'), read('second')], label: 'Read 2 files' },
    {
      parts: [
        {
          kind: 'tool',
          variant: 'agent_tool',
          toolCallId: 'outline',
          toolName: 'get_space_outline',
          title: 'Outline',
          status: 'completed',
        },
      ],
      label: 'Read Space outline',
    },
    {
      parts: [
        {
          kind: 'tool',
          variant: 'agent_tool',
          toolCallId: 'inspect',
          toolName: 'inspect_nodes',
          title: 'Inspect',
          status: 'completed',
          data: {
            tool: 'inspect_nodes',
            status: 'success',
            data: {
              count: 1,
              nodes: [{ id: 'density-node', label: 'Density node' }],
            },
          },
        },
      ],
      label: 'Density node',
    },
  ];
  for (const { parts, label } of cases) {
    await update(page, [thinking, ...parts]);
    const title = fixture(page).getByText(label, { exact: true });
    await expect(title).toBeVisible();
    expect(await title.evaluate(metrics)).toEqual(expected);
  }
});

test('thinking separates nested tool runs that close automatically without hiding explanations', async ({
  page,
}) => {
  const start: AssistantSegment[] = [
    {
      kind: 'thinking',
      text: '**First explanation**\n\nAll details remain readable.',
    },
    tool('a'),
    tool('b'),
  ];
  await mount(page, 0, start);
  const runs = fixture(page).locator('[data-assistant-tools]');
  await expect(runs).toHaveCount(1);
  await expect(runs.first().getByRole('button').first()).toHaveText(
    '2 tool calls',
  );
  await expect(runs.first().getByRole('button').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expectInlineDisclosure(
    runs.first().getByRole('button').first(),
    fixture(page).getByText('All details remain readable.', { exact: true }),
  );
  const next: AssistantSegment[] = [
    ...start,
    { kind: 'thinking', text: 'Second explanation' },
    tool('c'),
    tool('d'),
  ];
  await update(page, next);
  await expect(runs).toHaveCount(2);
  await expect(runs.first().getByRole('button').first()).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(runs.last().getByRole('button').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(
    fixture(page).getByText('All details remain readable.', { exact: true }),
  ).toBeVisible();
  await expect(
    fixture(page).getByRole('button', { name: 'Reading file a' }),
  ).toHaveCount(0);
  await update(page, next, false);
  await expect(header(page)).toHaveText('Completed 6 steps');
  await header(page).click();
  for (const run of await runs.all()) {
    await expect(run.getByRole('button').first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  }
  await expect(
    fixture(page).getByText('Second explanation', { exact: true }),
  ).toBeVisible();
});

for (const collapsed of [true, false]) {
  test(`nested tool run manual collapsed=${collapsed} survives completion`, async ({
    page,
  }) => {
    const segments: AssistantSegment[] = [
      { kind: 'thinking', text: 'Explanation' },
      tool('a'),
      tool('b'),
    ];
    await mount(page, 0, segments);
    const toggle = fixture(page)
      .locator('[data-assistant-tools]')
      .getByRole('button')
      .first();
    await toggle.focus();
    await toggle.press('Enter');
    if (!collapsed) await toggle.press('Space');
    await update(
      page,
      [...segments, { kind: 'thinking', text: 'Next explanation' }],
      false,
    );
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', String(!collapsed));
  });
}

test('nested singleton growth retains inspected output and focus', async ({
  page,
}) => {
  const thinking: AssistantSegment = { kind: 'thinking', text: 'Explanation' };
  await mount(page, 0, [thinking, tool('a')]);
  const call = fixture(page).getByRole('button', { name: 'Reading file a' });
  await call.click();
  const bodyId = await call.getAttribute('aria-controls');
  await update(page, [thinking, tool('a'), tool('b')]);
  const run = fixture(page).locator('[data-assistant-tools]');
  await expect(run.getByRole('button').first()).toHaveText('2 tool calls');
  await expect(call).toBeFocused();
  expect(await call.getAttribute('aria-controls')).toBe(bodyId);
  await update(page, [thinking, tool('a'), tool('b')], false);
  await expect(run.getByRole('button').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(call).toBeFocused();
  await expect(
    fixture(page).getByText('Full output for a', { exact: true }),
  ).toBeVisible();
});

test('completed edits summarize unique changed files with correct singular and plural labels', async ({
  page,
}) => {
  const edit = (id: string, path: string): GenericToolPart => ({
    ...tool(id),
    toolKind: 'edit',
    content: [{ type: 'diff', path, oldText: 'before', newText: 'after' }],
  });
  const edits = [edit('a', 'example.ts'), edit('b', 'example.ts')];
  await mount(page, 0, edits);
  await update(page, edits, false);
  await expect(header(page)).toHaveText('Changed 1 file · Completed 2 steps');
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
  await update(page, [...edits, edit('c', 'second.ts')], false);
  await expect(header(page)).toHaveText('Changed 2 files · Completed 3 steps');
});

test('normally ended activity completes despite failed, stale or missing tool statuses', async ({
  page,
}) => {
  const segments = (
    ['pending', 'in_progress', 'failed', undefined] as const
  ).map(
    (status, index): AssistantSegment => ({
      ...tool(String(index)),
      status,
    }),
  );
  await mount(page, 0, segments);
  await update(page, [...segments, prose]);
  await expect(header(page)).toHaveText('Completed 4 steps');
  await update(page, segments, false);
  await expect(header(page)).toHaveText('Completed 4 steps');
  await header(page).click();
  await expect(
    activity(page)
      .getByRole('button', { name: 'Reading file 2' })
      .locator('.text-danger-fg'),
  ).toBeVisible();
});

for (const status of ['interrupted', 'error'] as const) {
  test(`a terminal ${status} is not presented as completed`, async ({
    page,
  }) => {
    await mount(page);
    const label = status === 'interrupted' ? 'Interrupted' : 'Error';
    await update(page, initial, true, status);
    await expect(header(page)).toHaveText(`${label} · 4 steps`);
    await expect(activity(page)).toHaveAttribute(
      'data-activity-running',
      'false',
    );
    await expect(
      fixture(page).locator('[data-chat-message-id="current-status"]'),
    ).toBeVisible();
    await update(page, initial, false, status);
    await expect(header(page)).toHaveText(`${label} · 4 steps`);
  });
}
for (const collapsed of [true, false]) {
  test(`manual collapsed=${collapsed} survives keyboard toggles, updates and completion`, async ({
    page,
  }) => {
    await mount(page);
    await header(page).focus();
    await header(page).press('Enter');
    if (!collapsed) await header(page).press('Space');
    const bodyId = await header(page).getAttribute('aria-controls');
    await update(page, [...initial, tool('c')]);
    await expect(header(page)).toHaveAttribute(
      'aria-expanded',
      String(!collapsed),
    );
    await update(page, [...initial, tool('c'), prose], false);
    await expect(header(page)).toHaveAttribute(
      'aria-expanded',
      String(!collapsed),
    );
    await expect(header(page)).toBeFocused();
    expect(await header(page).getAttribute('aria-controls')).toBe(bodyId);
  });
}

test('inspecting a tool keeps its details and focus visible when the turn ends', async ({
  page,
}) => {
  await mount(page);
  const call = activity(page).getByRole('button', { name: 'Reading file a' });
  await call.click();
  await update(page, [...initial, prose], false);
  await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(call).toBeFocused();
  await expect(
    activity(page).getByText('Full output for a', { exact: true }),
  ).toBeVisible();
});

test('completion collapses untouched activity and keeps bottom-follow and composer focus', async ({
  page,
}) => {
  await mount(page);
  const scroll = fixture(page).locator('[data-chat-thread-root]');
  const draft = fixture(page).getByRole('textbox', { name: 'Fixture draft' });
  await draft.focus();
  await draft.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(2, 7),
  );
  const longActivity = Array.from({ length: 30 }, (_, index) =>
    tool(String(index)),
  );
  const bottomGap = () =>
    scroll.evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    );
  await update(page, longActivity);
  await expect(
    activity(page).getByText('Reading file 29', { exact: true }),
  ).toBeVisible();
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await update(page, longActivity, false);
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await expect(draft).toBeFocused();
  expect(
    await draft.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([2, 7]);
});

test('collapsing a completed activity below the viewport does not move a paused reader', async ({
  page,
}) => {
  await mount(page, 28);
  const scroll = fixture(page).locator('[data-chat-thread-root]');
  await scroll.evaluate(async (element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        deltaY: -100,
      }),
    );
    element.scrollTop = 120;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const before = await scroll.evaluate((element) => element.scrollTop);
  expect(before).toBe(120);
  await update(page, [...initial, tool('c'), prose], false);
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(before);
});
