/**
 * Playground for visualising every `ToolCallCard` permutation in one
 * scrollable page. Lets us eyeball icon/status/content combinations
 * without running a real agent turn.
 *
 * Scope: `ToolCallCard` renders only the `generic` variant of
 * `AssistantToolPart`. The other variants (`agent_tool`,
 * `canvas_commands`, `web_search`) have their own dedicated
 * renderers (`MergedAgentToolRow`, `CanvasCommandCard`,
 * `WebSearchToolDisplay`) and are not exercised here.
 *
 * Route: `/playground/tool-calls`
 */

import { ToolCallCard } from '../components/Messages/AIMessage/Tool/ToolCallCard';

import type { GenericToolPart } from '@sediment/shared';

interface Fixture {
  label: string;
  part: GenericToolPart;
}

let idSeq = 0;
const nextId = () => `fake-${++idSeq}`;

// ─── Status × ToolKind matrix ─────────────────────────────────────────

const STATUSES: GenericToolPart['status'][] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
];

const KIND_FIXTURES: Array<{
  toolKind: NonNullable<GenericToolPart['toolKind']>;
  title: string;
}> = [
  { toolKind: 'read', title: 'Read app.ts' },
  { toolKind: 'edit', title: 'Edit ToolCallCard.tsx' },
  { toolKind: 'delete', title: 'Delete tmp/scratch.md' },
  { toolKind: 'move', title: 'Move notes.md → docs/notes.md' },
  { toolKind: 'search', title: 'Search "AssistantToolPart"' },
  { toolKind: 'execute', title: 'Run pnpm test' },
  { toolKind: 'think', title: 'Plan refactor strategy' },
  { toolKind: 'fetch', title: 'Fetch https://example.com/data.json' },
  { toolKind: 'switch_mode', title: 'Switch mode → review' },
  { toolKind: 'other', title: 'Unknown tool' },
];

const TITLE_HEURISTIC_FIXTURES: Array<{ title: string }> = [
  { title: 'Read package.json' },
  { title: 'Edit README' },
  { title: 'Delete build artifact' },
  { title: 'Move folder' },
  { title: 'Search codebase' },
  { title: 'Run vitest' },
  { title: 'Think about architecture' },
  { title: 'Fetch remote schema' },
  { title: 'List directory' },
  { title: 'Mystery operation' }, // → Wrench fallback
];

const fixtures: Fixture[] = [];

// 1. Every (toolKind × status) combination — completed includes content/locations.
for (const { toolKind, title } of KIND_FIXTURES) {
  for (const status of STATUSES) {
    fixtures.push({
      label: `kind=${toolKind} · status=${status}`,
      part: {
        kind: 'tool',
        toolCallId: nextId(),
        title,
        variant: 'generic',
        toolKind,
        status,
      },
    });
  }
}

// 2. Title-heuristic fallback (no toolKind).
for (const { title } of TITLE_HEURISTIC_FIXTURES) {
  fixtures.push({
    label: `title-heuristic · "${title}"`,
    part: {
      kind: 'tool',
      toolCallId: nextId(),
      title,
      variant: 'generic',
      status: 'completed',
    },
  });
}

// 3. Rich content variants — exercise expand/collapse and content blocks.
fixtures.push({
  label: 'completed + text content + locations',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Read app.ts',
    variant: 'generic',
    toolKind: 'read',
    status: 'completed',
    locations: [
      { path: 'apps/web/src/App.tsx', line: 42 },
      { path: 'apps/web/src/main.tsx' },
    ],
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'export default function App() {\n  return <Routes />;\n}',
        },
      },
    ],
  },
});

fixtures.push({
  label: 'completed + diff + terminal blocks',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Edit ToolCallCard.tsx',
    variant: 'generic',
    toolKind: 'edit',
    status: 'completed',
    content: [
      {
        type: 'diff',
        path: 'apps/web/src/components/Messages/ToolCallCard.tsx',
        oldText: 'const a = 1;',
        newText: 'const a = 2;',
      },
      {
        type: 'terminal',
        terminalId: 'term-1',
      },
    ],
  },
});

fixtures.push({
  label: 'completed + resource_link block',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Fetch docs',
    variant: 'generic',
    toolKind: 'fetch',
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'resource_link',
          uri: 'https://example.com/spec.pdf',
          name: 'spec.pdf',
        },
      },
    ],
  },
});

fixtures.push({
  label: 'failed + error text',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Run pnpm build',
    variant: 'generic',
    toolKind: 'execute',
    status: 'failed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'error TS2322: Type "string" is not assignable to type "number".',
        },
      },
    ],
  },
});

fixtures.push({
  label: 'in_progress + streaming partial output',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Search workspace',
    variant: 'generic',
    toolKind: 'search',
    status: 'in_progress',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Scanned 412 / 1,200 files…',
        },
      },
    ],
  },
});

fixtures.push({
  label: 'long title truncation check',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title:
      'Read a really really really really really really really really really really long file path that should truncate gracefully in the UI',
    variant: 'generic',
    toolKind: 'read',
    status: 'completed',
  },
});

// ─── Page ─────────────────────────────────────────────────────────────

export default function ToolCallPlaygroundPage() {
  return (
    <div className="bg-bg-default h-screen overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-fg-default text-2xl font-semibold">
            ToolCallCard playground
          </h1>
          <p className="text-fg-muted mt-2 text-sm">
            Fake fixtures covering every status × icon-mapping permutation for
            the `generic` tool-part variant. Click an expandable card to verify
            content blocks &amp; locations.
          </p>
        </header>

        <div className="flex flex-col gap-3">
          {fixtures.map((f, i) => (
            <section
              key={i}
              className="border-edge-default rounded-md border p-3"
            >
              <div className="text-fg-subtle mb-2 font-mono text-[10px] tracking-wide uppercase">
                {f.label}
              </div>
              <ToolCallCard part={f.part} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
