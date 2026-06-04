import {
  Callout,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'starting-point', label: 'Starting point' },
  { id: 'frame-the-problem', label: 'Frame the problem' },
  { id: 'capture-decisions', label: 'Capture decisions as nodes' },
  { id: 'roll-up', label: 'Roll up into a spec frame' },
  { id: 'review-with-others', label: 'Reviewing with others' },
];

export default function ProductSpec() {
  return (
    <PageLayout
      title="Drafting a Product Spec"
      description="A spec is a sequence of decisions plus enough context to defend them. Huabu lets you keep the context — sketches, references, half-written paragraphs — beside the decision instead of compressing it all into a single Google Doc."
      toc={toc}
    >
      <H2>Starting point</H2>
      <P>
        A new canvas titled <em>&quot;Permissions redesign&quot;</em>, plus a
        Slack thread and a tracking issue you want to digest before deciding
        anything.
      </P>

      <H2>Frame the problem</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Drop a <DocLink href="/docs/nodes/text">Text</DocLink> heading at the
          top: <em>&quot;Problem&quot;</em>.
        </li>
        <li>
          Add a <DocLink href="/docs/nodes/note">Note</DocLink> below it for the
          symptom your users are hitting.
        </li>
        <li>
          Paste the Slack thread and issue URLs as{' '}
          <DocLink href="/docs/nodes/web">Web nodes</DocLink>; the article body
          for each is extracted in the background.
        </li>
        <li>
          Group the lot into a{' '}
          <DocLink href="/docs/nodes/frames">Frame</DocLink> set to{' '}
          <em>Column</em> layout — it stays tidy as you add more.
        </li>
      </ul>

      <H2>Capture decisions as nodes</H2>
      <P>
        Each decision is its own Note. Use a consistent shape — &quot;What we
        decided / Why / Alternatives we rejected / Open questions&quot; — and
        the canvas naturally turns into a decision log you can scan.
      </P>
      <Callout tone="tip">
        Open questions become{' '}
        <DocLink href="/docs/nodes/question">Question nodes</DocLink> instead of
        paragraphs inside the decision Note. The AI can take a first cut at each
        one without cluttering the decision itself.
      </Callout>
      <P>
        Use <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd> at any point to get an{' '}
        <DocLink href="/docs/ai/intent">Intent</DocLink> suggestion. Common ones
        at this stage:{' '}
        <em>&quot;extract a glossary from the open questions&quot;</em>,{' '}
        <em>&quot;cluster the open questions by theme&quot;</em>.
      </P>

      <H2>Roll up into a spec frame</H2>
      <P>
        When the canvas is busy and you want a written deliverable, multi-select
        the Problem Frame plus every decision Note and ask in Operate mode:
      </P>
      <p className="my-2 ml-4 border-l-2 border-gray-200 pl-3 text-[15px] text-gray-600 italic">
        &quot;Draft a one-page spec from these nodes. Lead with the problem,
        list the decisions in order with a sentence of rationale each, end with
        the open questions.&quot;
      </p>
      <P>
        The AI emits a change list: a new Frame called{' '}
        <em>&quot;Spec v0&quot;</em> containing one Note per section. Approve
        the batch as a whole, or step through each operation to tweak before
        commit.
      </P>

      <H2>Reviewing with others</H2>
      <P>Two ways to share:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Hand off the canvas folder.</strong> Export the canvas as a{' '}
          <code>.zip</code> bundle from the canvas list; the receiver imports it
          into their own workspace and sees exactly what you saw.
        </li>
        <li>
          <strong>Promote the Spec frame.</strong> Open each Note inside it,
          copy the rendered Markdown, paste into your team&apos;s actual spec
          system. The source-of-truth structure stays on the canvas; the doc is
          just the snapshot you sign off on.
        </li>
      </ul>
    </PageLayout>
  );
}
