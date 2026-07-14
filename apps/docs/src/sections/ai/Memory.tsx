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
  { id: 'why-memory', label: 'Why memory exists' },
  { id: 'two-tiers', label: 'Two tiers: User & Space' },
  { id: 'how-it-fills-up', label: 'How memory fills up' },
  { id: 'how-its-read', label: "How it's read back" },
  { id: 'hand-editing', label: 'Hand-editing memory' },
  { id: 'memory-vs-notes', label: 'Memory vs. notes' },
];

export default function Memory() {
  return (
    <PageLayout
      title="Memory"
      description="Memory is a small amount of long-lived context the AI carries between messages, Spaces and sessions. Two tiers — User and Space — answer different questions for it."
      toc={toc}
    >
      <H2>Why memory exists</H2>
      <P>
        Without memory, every new chat thread is a stranger again. The AI
        re-learns your preferences, re-asks the same clarifying questions and
        re-derives context the Space already implies. Memory is the smallest
        possible cure: a few lines of plain text that ride along on every turn.
      </P>
      <Callout tone="info">
        Reusable AI <em>recipes</em> — &quot;turn a research session into a
        comparison table&quot;, &quot;cluster these by theme&quot; — live next
        door as <DocLink href="/docs/ai/skills">Skills</DocLink>, not as memory
        entries.
      </Callout>

      <H2>Two tiers: User &amp; Space</H2>
      <Table
        headers={['Tier', 'Scope', 'Where it lives', 'Typical contents']}
        rows={[
          [
            <strong>User</strong>,
            'Applies to every Space in this Home.',
            <Code>setting/.huabu.md</Code>,
            'Preferences ("respond in Markdown"), constraints ("Python 3.11"), recurring vocabulary.',
          ],
          [
            <strong>Space</strong>,
            'Just this one Space.',
            <Code>.memory/canvas.md</Code>,
            'Narrative state of this Space — the topic, decisions made, things to revisit.',
          ],
        ]}
      />
      <P>
        Both tiers are size-capped (≈ 4 KB / 80 lines each) so they stay
        focused. The cap is enforced on every AI write — if memory grows beyond
        the limit the curator agent compresses it back down on the next pass.
      </P>

      <H2>How memory fills up</H2>
      <P>Two write paths feed each tier:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Automatic curation.</strong> After enough Space activity, a
          background curator agent reviews recent operations and updates User /
          Space memory. You don&apos;t see it happen; you see the effect on the
          next AI reply.
        </li>
        <li>
          <strong>Explicit ask.</strong> Tell the AI in chat — &quot;remember
          that I prefer X&quot; — and it writes the relevant tier directly. The
          AI is instructed to only write memory on request, not on its own
          initiative.
        </li>
      </ul>

      <H2>How it&apos;s read back</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>User memory</strong> is auto-injected at the start of every
          new chat thread, so cross-Space preferences apply from the first
          message.
        </li>
        <li>
          <strong>Space memory</strong> is pulled on demand — the AI knows it
          exists and reads it when the topic warrants.
        </li>
      </ul>

      <H2>Hand-editing memory</H2>
      <P>
        Both tiers are plain Markdown. Open in any editor and tweak. The next AI
        write enforces the size cap again, so it&apos;s fine to leave the file
        slightly over the limit temporarily.
      </P>
      <Callout tone="tip">
        If you find yourself reaching for memory to store a large body of
        reference material, that&apos;s a sign the material wants to be a Note
        or PDF on a dedicated Space instead — node content has no size cap.
      </Callout>

      <H2>Memory vs. notes</H2>
      <Table
        headers={['Memory', 'Notes']}
        rows={[
          [
            'Tiny, curated, model-facing.',
            'Arbitrary size, human-facing primary.',
          ],
          [
            'Auto-injected into prompts.',
            'Read only when explicitly attached or selected.',
          ],
          ['Lives outside any single Space.', 'Lives inside a Space folder.'],
          [
            'Best for preferences and recurring context.',
            'Best for content you might want to re-read.',
          ],
        ]}
      />
    </PageLayout>
  );
}
// TODO: fill in real handbook content for this section.
