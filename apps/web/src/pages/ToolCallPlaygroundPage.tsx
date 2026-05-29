/**
 * Playground for visualising every `ToolCallCard` permutation in one
 * scrollable page. Lets us eyeball icon/status/content combinations
 * without running a real agent turn.
 *
 * Route: `/playground/tool-calls`
 */

import { ToolCallCard } from '../components/Messages/AIMessage/Tool/ToolCallCard';

import type { AssistantToolPart } from '@sediment/shared';

interface Fixture {
  label: string;
  part: AssistantToolPart;
}

let idSeq = 0;
const nextId = () => `fake-${++idSeq}`;

// ─── Status × ToolKind matrix ─────────────────────────────────────────

const STATUSES: AssistantToolPart['status'][] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
];

const KIND_FIXTURES: Array<{
  toolKind: NonNullable<AssistantToolPart['toolKind']>;
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

const INTERNAL_FIXTURES: Array<{
  internalToolName: NonNullable<AssistantToolPart['internalToolName']>;
  title: string;
}> = [
  { internalToolName: 'read', title: 'read(app.ts)' },
  { internalToolName: 'grep', title: 'grep("AssistantToolPart")' },
  { internalToolName: 'find', title: 'find(**/*.tsx)' },
  { internalToolName: 'ls', title: 'ls(apps/web/src)' },
  { internalToolName: 'inspect_nodes', title: 'inspect_nodes(["n1","n2"])' },
  { internalToolName: 'inspect_edges', title: 'inspect_edges(["e1"])' },
  { internalToolName: 'get_canvas_outline', title: 'get_canvas_outline()' },
  { internalToolName: 'canvas_commands', title: 'canvas_commands(3 ops)' },
  { internalToolName: 'web_search', title: 'web_search("react 19")' },
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
        toolKind,
        status,
      },
    });
  }
}

// 2. Internal tools at completed status.
for (const { internalToolName, title } of INTERNAL_FIXTURES) {
  fixtures.push({
    label: `internalToolName=${internalToolName}`,
    part: {
      kind: 'tool',
      toolCallId: nextId(),
      title,
      status: 'completed',
      internalToolName,
    },
  });
}

// 3. Title-heuristic fallback (no toolKind, no internalToolName).
for (const { title } of TITLE_HEURISTIC_FIXTURES) {
  fixtures.push({
    label: `title-heuristic · "${title}"`,
    part: {
      kind: 'tool',
      toolCallId: nextId(),
      title,
      status: 'completed',
    },
  });
}

// 4. Rich content variants — exercise expand/collapse and content blocks.
fixtures.push({
  label: 'completed + text content + locations',
  part: {
    kind: 'tool',
    toolCallId: nextId(),
    title: 'Read app.ts',
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
            Fake fixtures covering every status × icon-mapping permutation.
            Click an expandable card to verify content blocks &amp; locations.
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
