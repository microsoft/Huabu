import {
  Callout,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'mental-model', label: 'Shared cognitive space' },
  { id: 'surfaces', label: 'Five surfaces of AI on the canvas' },
  { id: 'context', label: 'What the AI actually sees' },
  { id: 'where-next', label: 'Where to go next' },
];

export default function AgenticCanvas() {
  return (
    <PageLayout
      title="Agentic Canvas"
      description="Huabu's AI lives on the same canvas you do. It can read every node, follow every edge, write back into the surface, and pick up where you left off — across five distinct collaboration surfaces."
      toc={toc}
    >
      <H2>Shared cognitive space</H2>
      <P>
        Most AI products are a sidebar chat that only sees the last message you
        typed. Huabu inverts that: the canvas is shared memory, and the AI is a
        participant on the same surface. Selecting a node is a way of pointing;
        dragging two nodes near each other is a way of suggesting relevance;
        drawing a sketch is a way of asking a half-formed question.
      </P>

      <H2>Five surfaces of AI on the canvas</H2>
      <Table
        headers={['Surface', 'When to reach for it', 'Reference']}
        rows={[
          [
            <strong>Chat — Ask mode</strong>,
            'Open conversation, explanation, light synthesis. The AI streams replies into the chat panel.',
            <DocLink href="/docs/ai/overview">Chat with AI</DocLink>,
          ],
          [
            <strong>Chat — Operate mode</strong>,
            'Batched canvas edits. You describe an outcome; the AI emits a reviewable change list.',
            <DocLink href="/docs/ai/overview">Chat with AI</DocLink>,
          ],
          [
            <strong>Question nodes</strong>,
            'Ask a question right where the source material is. The answer lands on the canvas, not in chat.',
            <DocLink href="/docs/nodes/question">Question Nodes</DocLink>,
          ],
          [
            <strong>Intent</strong>,
            <>
              Tap <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd> to get
              context-aware &quot;what next&quot; suggestions you can run with
              one click.
            </>,
            <DocLink href="/docs/ai/intent">Intent &amp; Auto-layout</DocLink>,
          ],
          [
            <strong>External agents</strong>,
            'Pair Huabu with Claude / Copilot / Gemini CLIs through the ACP bridge.',
            <DocLink href="/docs/ai/external-agents">External Agents</DocLink>,
          ],
        ]}
      />

      <H2>What the AI actually sees</H2>
      <P>Two things travel with every message you send:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          A compact <strong>canvas overview</strong> — node list, frame
          hierarchy, recent operations.
        </li>
        <li>
          The full content of any <strong>selected</strong> nodes, never
          truncated.
        </li>
      </ul>
      <P>Two more layers are available on demand:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <DocLink href="/docs/ai/memory">Memory &amp; Skills</DocLink> —
          workspace-wide preferences and per-canvas notes the AI maintains for
          you, plus reusable recipes (&quot;skills&quot;) you can invoke with{' '}
          <code>/&lt;name&gt;</code>.
        </li>
        <li>
          <strong>Tool calls</strong> — the AI can read node bodies, search the
          canvas, fetch URLs and (when paired with an external agent) reach the
          rest of your local filesystem.
        </li>
      </ul>
      <P>
        For the exact payload, see{' '}
        <DocLink href="/docs/ai/context">How AI Sees the Canvas</DocLink>.
      </P>

      <Callout tone="info">
        Edits the AI makes are first-class operations. Undo treats them like
        your own changes; Operate-mode batches can be reviewed and rolled back
        as a single unit.
      </Callout>

      <H2>Where to go next</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Pair Huabu with an existing agent CLI via{' '}
          <DocLink href="/docs/core/acp">Agent Client Protocol</DocLink>.
        </li>
        <li>
          Learn how the canvas is{' '}
          <DocLink href="/docs/core/local-first">stored on disk</DocLink>, so
          you understand where memory and skills actually live.
        </li>
      </ul>
    </PageLayout>
  );
}
