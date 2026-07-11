import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-a-skill-is', label: 'What a skill is' },
  { id: 'when-to-author-one', label: 'When to author one' },
  { id: 'invoking-a-skill', label: 'Invoking a skill' },
  { id: 'authoring-a-skill', label: 'Authoring a skill' },
  { id: 'ai-authored', label: 'AI-authored skills & the rationale check' },
  { id: 'where-they-live', label: 'Where skills live on disk' },
];

export default function Skills() {
  return (
    <PageLayout
      title="Skills"
      description="A skill is a reusable AI recipe — a Markdown file with a name, a description and a procedure. Skills sit next to memory but answer a different question: not 'what does the AI know about me', but 'what does it know how to do for me'."
      toc={toc}
    >
      <H2>What a skill is</H2>
      <P>
        Skills are short Markdown files that teach the AI a procedure you want
        repeated reliably. Examples that fit well:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>&quot;Turn a research session into a comparison table.&quot;</li>
        <li>
          &quot;Clean up this canvas the way I like — frame loose notes, label
          clusters, prune duplicates.&quot;
        </li>
        <li>&quot;Draft a one-page spec from these decision Notes.&quot;</li>
        <li>
          &quot;Run the standard literature-review template over the selected
          sources.&quot;
        </li>
      </ul>
      <P>
        Skills are not memory — they don&apos;t shape every reply. They run when
        you invoke them, and only then.
      </P>

      <H2>When to author one</H2>
      <Table
        headers={['Sign', 'Verdict']}
        rows={[
          [
            'You have typed the same multi-step prompt three times.',
            'Save it as a skill.',
          ],
          [
            'You have a procedure with non-obvious steps that the AI keeps forgetting.',
            'Skill.',
          ],
          [
            'You want a one-line preference (always respond in Markdown).',
            <>
              That&apos;s <DocLink href="/docs/ai/memory">memory</DocLink>, not
              a skill.
            </>,
          ],
          [
            'You want a fact remembered across sessions.',
            <>
              That&apos;s also <DocLink href="/docs/ai/memory">memory</DocLink>.
            </>,
          ],
        ]}
      />

      <H2>Invoking a skill</H2>
      <P>
        Skills run in <DocLink href="/docs/ai/agent-mode">Agent Mode</DocLink>.
        Type <Code>/</Code> in the composer to open the slash-command typeahead;
        your skills appear by name. Pick one and the AI loads the skill body
        before executing the turn.
      </P>
      <Callout tone="info">
        Pre-selected nodes are still the scope. If a skill operates on &quot;the
        selected source notes&quot;, the AI uses whatever you have selected when
        you invoked the skill.
      </Callout>

      <H2>Authoring a skill</H2>
      <P>
        Drop a folder under <Code>setting/skills/&lt;id&gt;/</Code> with a{' '}
        <Code>SKILL.md</Code> inside. The minimum shape is a YAML frontmatter
        with name and description, then the procedure in normal Markdown:
      </P>
      <CodeBlock language="markdown">{`---
name: comparison-table
description: Build a comparison table from selected source notes.
---

Given the currently selected nodes:

1. Identify the dimensions worth comparing (method, dataset, claim, weakness).
2. Create a Frame called "Comparison — <topic>" in row layout.
3. For each source, add one row of Text nodes filling each dimension.
4. Connect the original sources to their row with edges labelled "row source".
5. Stop. Do not edit the source notes themselves.`}</CodeBlock>
      <P>
        That&apos;s it — any extra assets the skill needs (templates, examples)
        can live in the same folder.
      </P>

      <H2>AI-authored skills &amp; the rationale check</H2>
      <P>
        You can also ask the AI to save the current approach as a skill —
        &quot;Save this as a skill called <em>&lt;name&gt;</em>.&quot; Before
        creating one, the AI runs a <strong>rationale check</strong>: it has to
        justify why a new skill is needed rather than extending an existing one.
        This is the simplest way to stop a slowly accumulating graveyard of
        near-duplicate skills.
      </P>

      <H2>Where skills live on disk</H2>
      <CodeBlock language="text">{`<workspace>/setting/skills/
├── comparison-table/
│   ├── SKILL.md
│   └── template.md
├── canvas-cleanup/
│   └── SKILL.md
└── lit-review/
    └── SKILL.md`}</CodeBlock>
      <P>
        Because skills are plain folders of Markdown, you can version-control
        them, share them between workspaces by copy-paste, or move them
        wholesale to a teammate&apos;s machine.
      </P>
    </PageLayout>
  );
}
