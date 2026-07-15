import {
  Callout,
  Code,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'why-memory', label: 'Why memory exists' },
  { id: 'two-tiers', label: 'Two tiers: User & Space' },
  { id: 'how-it-fills-up', label: 'How Huabu updates memory' },
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
        re-derives context the Space already implies. Memory keeps a small,
        focused record that the AI can carry into later work.
      </P>
      <Callout tone="info">
        Memory stores preferences and durable context. A reusable procedure,
        such as turning selected research notes into a comparison structure,
        belongs in a Skill instead.
      </Callout>

      <H2>Two tiers: User &amp; Space</H2>
      <Table
        headers={['Tier', 'Scope', 'Where it lives', 'Typical contents']}
        rows={[
          [
            <strong>User</strong>,
            'Applies to every Space in this Home.',
            <Code>setting/user.md</Code>,
            'Preferences ("respond in Markdown"), constraints ("Python 3.11"), recurring vocabulary.',
          ],
          [
            <strong>Space</strong>,
            'Just this one Space.',
            <Code>.memory/space.md</Code>,
            'Narrative state of this Space — the topic, decisions made, things to revisit.',
          ],
        ]}
      />
      <P>
        Both tiers are size-capped (about 4 KB or 80 lines each) so they stay
        focused. The cap is enforced on every AI write — if memory grows beyond
        the limit the curator agent compresses it back down on the next pass.
      </P>

      <H2>How Huabu updates memory</H2>
      <P>Memory changes through two paths:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Automatic curation.</strong> After enough Space activity, a
          background process reviews recent conversations and Space operations,
          then keeps only the details worth carrying forward. It runs quietly
          and never blocks your work.
        </li>
        <li>
          <strong>Explicit ask.</strong> Tell the AI in chat — &quot;remember
          that I prefer X&quot; or &quot;remember this decision for this
          Space&quot; — and it writes the appropriate tier directly.
        </li>
      </ul>

      <H2>How it&apos;s read back</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>User memory</strong> is available to every built-in Chat and
          Agent turn, so cross-Space preferences can apply immediately.
        </li>
        <li>
          <strong>Space memory</strong> is pulled on demand — the AI knows it
          exists and reads it when the topic warrants.
        </li>
      </ul>

      <H2>Hand-editing memory</H2>
      <P>
        Both tiers are plain Markdown. Open them in any editor to audit,
        correct, or remove an entry. The next AI write enforces the size cap
        again, so it is fine to leave a file slightly over the limit
        temporarily.
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
          [
            'User memory is Home-wide; Space memory is per-Space.',
            'Lives inside a Space folder.',
          ],
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
