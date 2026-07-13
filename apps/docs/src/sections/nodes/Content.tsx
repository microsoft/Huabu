// TODO: fill in real handbook content for this section.
import {
  Callout,
  Code,
  CodeBlock,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'storage-model', label: 'Storage model' },
  { id: 'how-content-is-produced', label: 'How content is produced' },
  { id: 'markdown-format', label: 'Markdown format' },
  { id: 'how-the-ai-uses-it', label: 'How the AI uses it' },
  { id: 'semantic-edges', label: 'Implicit semantic edges' },
];

export default function Content() {
  return (
    <PageLayout
      title="Node Content"
      description="Huabu persists every node's ingested content (PDF body text, web article, Note prose, Text block) as a Markdown file with frontmatter. The AI reads these files as context during chat and intent."
      toc={toc}
    >
      <H2>Storage model</H2>
      <P>Every Space maps to one folder:</P>
      <CodeBlock language="text">{`<workspace>/<canvas-title>/
├── canvas.json              # topology (positions, edges, frames)
├── nodes/<node-title>.md    # ingested content + metadata per node
├── .artifacts/              # hidden: raw binaries (PDFs, images, videos)
├── .memory/canvas.md        # AI-written canvas memory
└── .history/                # hidden: chat / intent / event history`}</CodeBlock>
      <P>
        Node <strong>content</strong> and node{' '}
        <strong>position on the Space</strong> are kept as two separate pieces
        of state — the topology is in <Code>canvas.json</Code>, and each
        node&apos;s ingested body is a separate Markdown file under{' '}
        <Code>nodes/</Code>.
      </P>
      <Callout tone="info">
        Which nodes get a <Code>.md</Code>?{' '}
        <strong>Note · Text · Web · PDF · Image · Video · Frame</strong>. Image
        / Video / Frame files only carry frontmatter (they point at the
        artifact, or just label the frame). Sketch and Question nodes don&apos;t
        get one — their state lives entirely inside <Code>canvas.json</Code>.
      </Callout>

      <H2>How content is produced</H2>
      <P>
        The following actions automatically run the ingestion pipeline, which
        writes to <Code>nodes/&lt;nodeId&gt;.md</Code>:
      </P>
      <Table
        headers={['Node', 'Trigger', 'Ingested content']}
        rows={[
          [
            'PDF',
            'Upload / paste / add link',
            'Extracted text body + metadata.',
          ],
          [
            'Web',
            'Paste URL / link dialog',
            'Article body (ads / nav stripped).',
          ],
          ['Note', 'Save edits', 'Full Markdown body.'],
          ['Text', 'Save edits', 'Plain text.'],
        ]}
      />
      <P>
        Pipeline stages: parse input → extract text → resolve title → (optional)
        AI-generated summary / keywords / tags → write to{' '}
        <Code>nodes/&lt;nodeId&gt;.md</Code>. On failure the file is still
        written (as a placeholder with diagnostic info) so the node stays
        visible and you can retry.
      </P>

      <H2>Markdown format</H2>
      <CodeBlock language="markdown">{`---
id: <nodeId>
contentKind: pdf | web | note | text
title: Attention Is All You Need
summary: ...
keywords: [transformer, attention, ...]
---

<extracted body text>`}</CodeBlock>
      <P>
        Open the file in any Markdown editor and tweak the body. The{' '}
        <Code>id</Code> must stay in sync with the node identifier — don&apos;t
        hand-edit it.
      </P>

      <H2>How the AI uses it</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Auto-inject selected content.</strong> When you have a node
          selected before sending a chat message, that node&apos;s full body is
          included in the prompt (not truncated).
        </li>
        <li>
          <strong>Tool-driven reads.</strong> The AI can also call{' '}
          <Code>read(&quot;nodes/&lt;id&gt;.md&quot;)</Code> on demand for any
          node it&apos;s curious about.
        </li>
      </ol>
    </PageLayout>
  );
}
