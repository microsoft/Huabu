import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-it-is', label: 'What Digest does' },
  { id: 'what-gets-digested', label: 'What gets digested' },
  { id: 'when-it-runs', label: 'When it runs' },
  { id: 'what-it-writes-to', label: 'Where it writes' },
  { id: 'how-to-influence', label: 'How to steer the Digest' },
  { id: 'inspecting', label: 'Inspecting & resetting' },
];

export default function Digest() {
  return (
    <PageLayout
      title="Digest"
      description="The Digest is a small background agent that watches your canvas activity — chat turns, AI operations, intent runs — and folds them into memory. It's the reason the AI seems to “remember” what your canvas is about without you having to retell it every turn."
      toc={toc}
    >
      <H2>What Digest does</H2>
      <P>
        Each canvas accumulates raw activity: chat transcripts, the operations
        the AI ran, the intents you accepted, the nodes that appeared and moved.
        Most of that is too noisy to read back into every future prompt. The
        Digest job compresses it down to the parts worth remembering and writes
        them into <DocLink href="/docs/ai/memory">memory</DocLink>.
      </P>
      <P>
        In effect, Digest is the bridge between &quot;what you and the AI just
        did&quot; and &quot;what the AI carries into the next
        conversation.&quot; Without it, every new chat thread would be a
        stranger.
      </P>

      <H2>What gets digested</H2>
      <Table
        headers={['Source', 'What it contributes']}
        rows={[
          [
            <strong>Chat threads</strong>,
            'Recent user / assistant turns from the canvas — questions you asked, decisions you reached.',
          ],
          [
            <strong>Recent operations</strong>,
            'The last ~100 canvas operations (create / move / connect / edit) — what changed and in what order.',
          ],
          [
            <strong>Intent episodes</strong>,
            <>
              The most recent <DocLink href="/docs/ai/intent">Intent</DocLink>{' '}
              runs — what you asked Huabu to plan and which plan you accepted.
            </>,
          ],
        ]}
      />
      <P>
        Each source is read with a cursor, so the Digest only sees what&apos;s
        new since its last pass. Nothing is re-digested forever.
      </P>

      <H2>When it runs</H2>
      <P>
        The Digest runs in the background after enough canvas activity
        accumulates — you don&apos;t trigger it manually and there&apos;s no
        modal to confirm. The effect is visible only on the AI&apos;s next reply
        (it will reference things from earlier turns more naturally) or on the
        file system, where workspace / canvas memory gets a few new lines.
      </P>
      <Callout tone="info">
        Digest is intentionally quiet. If it ran with a notification every time,
        it would pull your attention away from the canvas — exactly the wrong
        tradeoff for a feature whose job is to be invisible.
      </Callout>

      <H2>Where it writes</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <Code>setting/.huabu.md</Code> — workspace-wide memory; the curator
          only adds something here if it generalises beyond this one canvas.
        </li>
        <li>
          <Code>memory/canvas.md</Code> — per-canvas memory; this is where most
          Digest output lands.
        </li>
      </ul>
      <P>
        Both files are plain Markdown — see{' '}
        <DocLink href="/docs/ai/memory">Memory</DocLink> for the size caps and
        on-disk layout.
      </P>

      <H2>How to steer the Digest</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Tell it explicitly.</strong> &quot;Remember that I prefer
          X.&quot; The Digest treats explicit asks as priority signals.
        </li>
        <li>
          <strong>Name your frames.</strong> Frame titles are the cheapest way
          to label a region of the canvas; the Digest picks them up alongside
          node titles.
        </li>
        <li>
          <strong>Accept Intent runs.</strong> An accepted Intent leaves a tidy
          episode the Digest can summarise; a rejected one is ignored.
        </li>
        <li>
          <strong>Trim memory yourself.</strong> Memory files are hand-editable.
          Strike out lines you don&apos;t want the AI to carry forward.
        </li>
      </ul>

      <H2>Inspecting &amp; resetting</H2>
      <P>
        Because everything lives in plain files, you can audit the Digest&apos;s
        work in any text editor:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          The current state of memory is in <Code>setting/.huabu.md</Code> and{' '}
          <Code>memory/canvas.md</Code>.
        </li>
        <li>
          The raw inputs are under <Code>.history/</Code> inside each canvas
          folder — chat transcripts, ops log, intent episodes.
        </li>
        <li>
          To start fresh on a canvas, delete <Code>memory/canvas.md</Code> (the
          Digest will rebuild it next pass) or wipe <Code>.history/</Code> to
          restart from zero context.
        </li>
      </ul>
    </PageLayout>
  );
}
