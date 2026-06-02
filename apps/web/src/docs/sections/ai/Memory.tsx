// TODO: fill in real handbook content for this section.
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
  { id: 'three-tiers', label: 'Three tiers of memory' },
  { id: 'how-it-fills-up', label: 'How memory fills up' },
  { id: 'how-its-read', label: "How it's read back" },
  { id: 'skills', label: 'Skills' },
  { id: 'hand-editing', label: 'Hand-editing memory' },
];

export default function Memory() {
  return (
    <PageLayout
      title="Memory & Skills"
      description="Huabu keeps a small amount of long-lived context that survives across messages, canvases and sessions. There are three tiers — workspace, canvas and skill — and they answer different questions for the AI."
      toc={toc}
    >
      <H2>Three tiers of memory</H2>
      <Table
        headers={['Tier', 'Scope', 'Where it lives', 'Visibility']}
        rows={[
          [
            <strong>Workspace</strong>,
            'Cross-canvas — applies to every canvas in this workspace.',
            <Code>setting/.huabu.md</Code>,
            'Visible & hand-editable.',
          ],
          [
            <strong>Canvas</strong>,
            'Just this one canvas.',
            <Code>memory/canvas.md</Code>,
            'Mostly written by the AI; hand-editable if you really want.',
          ],
          [
            <strong>Skill</strong>,
            'Reusable recipes the AI can run on request.',
            <Code>setting/skills/&lt;id&gt;/SKILL.md</Code>,
            'Hand-authored or AI-authored with explicit rationale.',
          ],
        ]}
      />
      <P>
        Workspace and canvas memory are size-capped (≈ 4 KB / 80 lines each) so
        they stay focused. Skills have no size limit but are gated behind a
        rationale check, so the AI can&apos;t silently create dozens of narrow
        ones.
      </P>

      <H2>How memory fills up</H2>
      <P>Two write paths feed each tier:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Automatic curation.</strong> After enough canvas activity, a
          background curator agent reviews recent operations and updates
          workspace / canvas memory in the background. You don&apos;t see it
          happen; you see the effect on the next AI reply.
        </li>
        <li>
          <strong>Explicit ask.</strong> Tell the AI in chat — &quot;remember
          that I prefer X&quot;, &quot;save this as a skill&quot; — and
          it&apos;ll write the relevant tier directly. The AI is instructed to
          only do this when you ask, not on its own initiative.
        </li>
      </ul>

      <H2>How it&apos;s read back</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Workspace memory</strong> is auto-injected at the start of
          every new chat thread, so cross-canvas preferences (&quot;always
          respond in markdown&quot;, &quot;I&apos;m using Python 3.11&quot;)
          apply from the first message.
        </li>
        <li>
          <strong>Canvas memory</strong> is pulled on demand — the AI knows it
          exists and reads it when relevant.
        </li>
        <li>
          <strong>Skills</strong> are listed in the AI&apos;s system prompt and
          shown as slash-command suggestions in Operate mode. The AI reads a
          skill&apos;s full body before applying it.
        </li>
      </ul>

      <H2>Skills</H2>
      <P>
        A skill is just a Markdown file with a name, a description, and a recipe
        — anything from &quot;turn a research session into a comparison
        table&quot; to &quot;clean up this canvas the way I like&quot;. Two ways
        to author them:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Write one yourself.</strong> Drop a folder under{' '}
          <Code>setting/skills/&lt;id&gt;/</Code> with a <Code>SKILL.md</Code>{' '}
          inside. Use it in Operate mode with <Code>/&lt;name&gt;</Code>.
        </li>
        <li>
          <strong>Ask the AI to save one.</strong> &quot;Save this approach as a
          skill called &lt;name&gt;.&quot; The AI gates new skills behind a
          short rationale — it has to justify why a new skill is needed instead
          of editing an existing one.
        </li>
      </ul>

      <H2>Hand-editing memory</H2>
      <P>
        All three tiers are plain Markdown — open in any editor and tweak.
        Workspace and canvas memory accept any text up to the size cap; on the
        AI&apos;s next write the cap is enforced again. Skill files can grow
        freely.
      </P>
      <Callout tone="tip">
        Memory is meant to be small and focused. If you find yourself wanting to
        remember a large body of reference material, put it in a Note or PDF
        node on a dedicated canvas instead — node content has no size cap.
      </Callout>
    </PageLayout>
  );
}
