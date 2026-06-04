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
  { id: 'getting-sources-in', label: 'Getting sources onto the canvas' },
  { id: 'reading-with-ai', label: 'Reading alongside the AI' },
  { id: 'comparison', label: 'Building a comparison' },
  { id: 'synthesis', label: 'Producing a synthesis' },
  { id: 'what-stays', label: 'What stays on disk' },
];

export default function ResearchReview() {
  return (
    <PageLayout
      title="Reading a Research Topic"
      description="You're catching up on a new area. You have a handful of papers, a few blog posts, maybe a video lecture, and a vague sense of what the open questions are. Here's how a Huabu canvas earns its keep."
      toc={toc}
    >
      <H2>Starting point</H2>
      <P>
        A new canvas titled something like{' '}
        <em>&quot;Diffusion language models&quot;</em>. Empty. You have five
        PDFs, two arxiv URLs and a YouTube link in a folder on your desktop.
      </P>

      <H2>Getting sources onto the canvas</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Drag the PDFs straight in.</strong> Each becomes a{' '}
          <DocLink href="/docs/nodes/pdf">PDF node</DocLink> with thumbnails and
          selectable text.
        </li>
        <li>
          <strong>Paste the URLs</strong> with <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
          <Kbd>V</Kbd>. The arxiv links become{' '}
          <DocLink href="/docs/nodes/web">Web nodes</DocLink> (article body
          auto-extracted); the YouTube link becomes a{' '}
          <DocLink href="/docs/nodes/video">Video node</DocLink>.
        </li>
        <li>
          Lasso them all and press <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>G</Kbd>{' '}
          to drop them into a <DocLink href="/docs/nodes/frames">Frame</DocLink>{' '}
          called <em>&quot;Sources&quot;</em> set to <em>Row</em> layout.
        </li>
      </ul>

      <H2>Reading alongside the AI</H2>
      <P>
        For each source, double-click to read in the lightbox. Anything worth
        capturing goes into a <DocLink href="/docs/nodes/note">Note</DocLink>{' '}
        beside the source node. When you&apos;re unsure about something, drop a{' '}
        <DocLink href="/docs/nodes/question">Question node</DocLink> with the
        source selected — the AI replies right next to the material, not in a
        far-away chat window.
      </P>
      <Callout tone="tip">
        Select the PDF node and ask in chat:{' '}
        <em>
          &quot;summarise this paper&apos;s contribution in 4 bullet
          points&quot;
        </em>
        . The selected node&apos;s full extracted text is sent — no copy-pasting
        needed.
      </Callout>

      <H2>Building a comparison</H2>
      <P>
        Once you have a Note per source, multi-select them and ask in Operate
        mode:{' '}
        <em>
          &quot;arrange these as a comparison: rows are the papers, columns are
          method / dataset / claim / weakness&quot;
        </em>
        . The AI emits a batch — typically a Frame containing one Text node per
        cell — and you get a change-list to approve or tweak before it commits.
      </P>

      <H2>Producing a synthesis</H2>
      <P>
        With the comparison Frame selected, switch back to Ask mode and say{' '}
        <em>
          &quot;write a 500-word synthesis that frames the open questions&quot;
        </em>
        . The reply streams into the chat panel; one click on the &quot;Save as
        Note&quot; button drops it next to the comparison Frame as a real canvas
        node. Edit in place, link related sources with edges, and you have
        something you can hand off.
      </P>

      <H2>What stays on disk</H2>
      <P>
        The canvas folder now contains: the original PDFs in{' '}
        <code>.artifacts/</code>, one Markdown note per source under{' '}
        <code>nodes/</code>, the synthesis as another Markdown file, and your
        chat history. You can grep, back up or hand the folder to a teammate
        without exporting anything — see{' '}
        <DocLink href="/docs/core/local-first">
          Local-first &amp; Markdown
        </DocLink>
        .
      </P>
    </PageLayout>
  );
}
