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
  { id: 'what-a-skill-is', label: 'What a Skill is' },
  { id: 'when-to-use-one', label: 'When to use one' },
  { id: 'run-a-skill', label: 'Run a Skill' },
  { id: 'save-a-skill', label: 'Save a Skill' },
  { id: 'where-skills-live', label: 'Where Skills live' },
];

const listClassName =
  'text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed';

export default function Skills() {
  return (
    <PageLayout
      title="Skills"
      description="Skills are reusable instructions for tasks you want an Agent to perform consistently."
      toc={toc}
    >
      <H2>What a Skill is</H2>
      <P>
        A Skill teaches an Agent a repeatable procedure. It can describe the
        steps to follow, the expected result, and any constraints that should
        apply each time.
      </P>
      <ul className={listClassName}>
        <li>Turn selected research notes into a comparison structure.</li>
        <li>Organize loose material into consistently named Frames.</li>
        <li>Draft the same kind of brief from a set of decision notes.</li>
      </ul>

      <H2>When to use one</H2>
      <Table
        headers={['What you want to keep', 'Use']}
        rows={[
          ['A repeatable procedure with several steps', <strong>Skill</strong>],
          [
            'A preference, constraint, or durable fact',
            <DocLink href="/docs/ai/memory">Memory</DocLink>,
          ],
          [
            'Reference material you want to read again',
            <strong>Space node</strong>,
          ],
        ]}
      />

      <H2>Run a Skill</H2>
      <ol className="text-fg-muted list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed">
        <li>Start a conversation with the built-in Agent.</li>
        <li>Select the nodes the Skill should work on.</li>
        <li>
          Type <Code>/</Code> in the composer to open the Skills menu.
        </li>
        <li>Choose a Skill, add any task-specific instruction, and send.</li>
      </ol>
      <Callout tone="info">
        The nodes selected when you send the turn remain the Skill&apos;s focus.
      </Callout>

      <H2>Save a Skill</H2>
      <P>
        After completing a useful workflow, ask the Agent to remember the
        procedure as a Skill—for example, “Save this approach as a Skill called
        research comparison.” Huabu asks the Agent to reuse or extend an
        existing Skill when possible instead of creating near-duplicates.
      </P>

      <H2>Where Skills live</H2>
      <P>
        User Skills are plain Markdown files stored under{' '}
        <Code>setting/skills/&lt;id&gt;/SKILL.md</Code> in your Home. You can
        inspect, edit, copy, or version-control them like other text files.
      </P>
      <Callout tone="tip">
        Keep each Skill focused on one reusable outcome. A shorter catalogue of
        distinct procedures is easier to choose from than many overlapping
        variations.
      </Callout>
    </PageLayout>
  );
}
