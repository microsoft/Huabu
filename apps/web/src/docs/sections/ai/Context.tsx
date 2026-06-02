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
  { id: 'whats-in-the-prompt', label: "What's in the prompt" },
  { id: 'how-to-focus-the-ai', label: 'How to focus the AI' },
];

export default function Context() {
  return (
    <PageLayout
      title="How AI Sees the Canvas"
      description="Every message you send is wrapped with structured context drawn from the current canvas. This page lists what gets included and how to steer it."
      toc={toc}
    >
      <H2>What&apos;s in the prompt</H2>
      <P>
        On each send, Huabu assembles the following blocks and ships them to the
        model along with your message:
      </P>
      <Table
        headers={['Block', 'What it carries']}
        rows={[
          [
            'Canvas outline',
            'Type, title and a short snippet for every node on the canvas, plus the frame hierarchy.',
          ],
          [
            'Selected node bodies',
            'The full content of currently selected nodes — no truncation.',
          ],
          [
            'Recent operations',
            'Last create / delete / connect / move actions, so the AI knows what just happened.',
          ],
          [
            'Workspace memory',
            <>
              On the first message of a thread, the contents of{' '}
              <DocLink href="/docs/ai/memory">workspace memory</DocLink> are
              auto-injected so cross-canvas preferences apply from the start.
            </>,
          ],
          [
            'Attachments',
            'Images or text snippets you sent from a PDF selection.',
          ],
        ]}
      />

      <H2>How to focus the AI</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Select before sending.</strong> The selection becomes the
          spotlight — its full text is included verbatim.
        </li>
        <li>
          <strong>Group into a frame.</strong> Frames are first-class context
          units — &quot;summarise this frame&quot; is well-defined.
        </li>
        <li>
          <strong>Use Question nodes for local asks.</strong> They consume only
          the spatial neighbourhood around the question node, not the entire
          canvas. See{' '}
          <DocLink href="/docs/nodes/question">Question Nodes</DocLink>.
        </li>
      </ul>
      <Callout tone="info">
        Want to see how the AI reaches into ingested node bodies and shared
        memory? Read <DocLink href="/docs/nodes/content">Node Content</DocLink>{' '}
        and <DocLink href="/docs/ai/memory">Memory &amp; Skills</DocLink>.
      </Callout>
    </PageLayout>
  );
}
