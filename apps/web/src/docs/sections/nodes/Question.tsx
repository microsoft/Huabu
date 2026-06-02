// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'why-question-nodes', label: 'Why a question node' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'states', label: 'States' },
  { id: 'agent-mention', label: 'Choosing the responding agent' },
  { id: 'spatial-context', label: 'Spatial context' },
  { id: 'follow-ups', label: 'Follow-ups & replay' },
];

export default function Question() {
  return (
    <PageLayout
      title="Question Nodes"
      description="A canvas-native Ask. Drop a Question node next to the relevant material and the AI answers right there, with its reply attached as a connected node."
      toc={toc}
    >
      <H2>Why a question node</H2>
      <P>
        The chat panel is great for free-form conversation. Question nodes are
        better when:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          You want the question (and its answer) to live{' '}
          <strong>in place</strong>, next to the source material.
        </li>
        <li>
          The question is <strong>local</strong> — about a specific area of the
          canvas — and shouldn&apos;t pull in the whole context.
        </li>
        <li>
          You&apos;re building a spatial thread (question → answer → follow-up)
          instead of a linear chat log.
        </li>
      </ul>

      <H2>Workflow</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Pick the Question tool from the canvas toolbar and click to place it.
        </li>
        <li>Double-click to edit and type the question.</li>
        <li>
          Optionally type <code>@</code> to pick which agent should answer (see
          below).
        </li>
        <li>
          Leave the editor or click <em>Run</em> — the node moves to{' '}
          <em>pending</em>.
        </li>
        <li>
          The server sends the question together with its{' '}
          <strong>spatial neighbourhood</strong> as the prompt.
        </li>
        <li>
          The reply streams into a new answer node, automatically connected back
          to the Question with an edge.
        </li>
        <li>
          The toolbar lets you replay the full conversation, or edit and re-run
          the question.
        </li>
      </ol>

      <H2>States</H2>
      <Table
        headers={['State', 'Meaning']}
        rows={[
          [<strong>idle</strong>, 'Editable. Not yet submitted.'],
          [<strong>pending</strong>, 'Queued / sent; waiting for the model.'],
          [<strong>done</strong>, 'A reply has landed as a connected node.'],
        ]}
      />
      <P>
        The Layers panel shows a small status dot for each Question so you can
        see at a glance which questions are still open.
      </P>

      <H2>Choosing the responding agent</H2>
      <P>
        Type <code>@</code> while editing the question to open a typeahead of
        available agents (the built-in agent plus any{' '}
        <DocLink href="/docs/ai/external-agents">external agents</DocLink>{' '}
        you&apos;ve paired). The chosen agent stays bound to that question for
        re-runs, so you can stage two Question nodes side by side and compare
        how different agents answer the same prompt.
      </P>

      <H2>Spatial context</H2>
      <P>
        Question nodes don&apos;t consume the entire canvas — they consume the{' '}
        <strong>semantic neighbourhood</strong> around themselves:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>The Question&apos;s parent frame (if any).</li>
        <li>Nodes spatially adjacent on the canvas.</li>
        <li>Nodes connected by edges.</li>
      </ul>
      <Callout tone="tip">
        Place the Question node <em>inside</em> the frame whose contents you
        want analysed — that&apos;s the most reliable way to scope the prompt.
      </Callout>

      <H2>Follow-ups & replay</H2>
      <P>
        Drop another Question node beside the answer, connect them, and ask the
        next thing. Each Question gets its own dedicated chat thread under the
        hood, so the toolbar&apos;s <em>View answers</em> button shows the full
        streamed reply (and any tool calls the AI made).
      </P>
    </PageLayout>
  );
}
