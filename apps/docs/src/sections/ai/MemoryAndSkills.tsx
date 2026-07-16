// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  { id: 'what-they-remember', label: 'What Memory and Skills remember' },
  { id: 'two-memory-tiers', label: 'Two Memory tiers' },
  { id: 'how-memory-updates', label: 'How Memory updates' },
  { id: 'review-memory', label: 'Review and edit Memory' },
  { id: 'run-a-skill', label: 'Run a Skill' },
  { id: 'save-a-skill', label: 'Save a Skill' },
];

const orderedListClassName =
  'text-fg-muted list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed';

export default function MemoryAndSkills() {
  return (
    <PageLayout
      title="Memory & Skills"
      description="Memory carries durable context between conversations, while Skills preserve procedures an Agent can run again."
      toc={toc}
    >
      <H2>What Memory and Skills remember</H2>
      <P>
        Memory and Skills help the AI carry useful knowledge into later work,
        but they preserve different things.
      </P>
      <Table
        headers={['Save', 'When to use it', 'Example']}
        rows={[
          [
            <strong>Memory</strong>,
            'For a preference, constraint, decision, or durable fact.',
            'I prefer concise summaries.',
          ],
          [
            <strong>Skill</strong>,
            'For a repeatable procedure with a consistent outcome.',
            'Turn selected research notes into a comparison structure.',
          ],
        ]}
      />
      <Callout tone="info">
        Huabu curates Memory automatically. Use <Code>/create-skill</Code> when
        you want Agent to preserve a successful repeatable workflow.
      </Callout>
      <Callout tone="info">
        Memory curation and Skill creation or updates use the Utility Model.
        Running a Skill to complete a task uses the Chat Model. If Utility is
        not configured, Huabu uses Chat for authoring too.
      </Callout>

      <H2>Two Memory tiers</H2>
      <Table
        headers={['Tier', 'Scope', 'Where it lives', 'Typical contents']}
        rows={[
          [
            <strong>User</strong>,
            'Applies to every Space in this Home.',
            <Code>setting/user.md</Code>,
            'Preferences, constraints, and recurring vocabulary.',
          ],
          [
            <strong>Space</strong>,
            'Applies only to the current Space.',
            <Code>.memory/space.md</Code>,
            'The topic, decisions, and things to revisit.',
          ],
        ]}
      />
      <P>
        User Memory is available to every built-in Chat and Agent turn. Space
        Memory is read on demand when the current topic needs it. Both tiers are
        kept small, about 4 KB or 80 lines each, so they remain focused.
      </P>

      <H2>How Memory updates</H2>
      <P>
        After enough Space activity, a background process reviews recent
        conversations and operations, then keeps only details worth carrying
        forward. It runs without interrupting your work.
      </P>
      <P>
        Telling the AI to remember a preference or Space decision makes the
        request a strong candidate for that review. It does not update Memory
        immediately, and the curator still decides whether the detail is worth
        keeping.
      </P>

      <H2>Review and edit Memory</H2>
      <P>
        Both tiers are plain Markdown. Open them in any editor to audit,
        correct, or remove an entry. Huabu checks the size limit when it writes
        Memory, but it does not trim a file that you edit beyond the limit.
      </P>
      <Callout tone="tip">
        Keep large reference material as nodes in a Space. Memory works best for
        small facts and preferences that should influence future conversations.
      </Callout>

      <H2>Run a Skill</H2>
      <ol className={orderedListClassName}>
        <li>Start a conversation with the built-in Agent.</li>
        <li>Select the nodes the Skill should work on.</li>
        <li>
          Type <Code>/</Code> in the chat input to open the Skills menu.
        </li>
        <li>Choose a Skill, add any task-specific instruction, and send.</li>
      </ol>
      <Callout tone="info">
        The nodes selected when you send the request remain the Skill&apos;s
        focus.
      </Callout>

      <H2>Save a Skill</H2>
      <P>
        In an Agent conversation, type <Code>/create-skill</Code> followed by a
        description of the reusable procedure. To change an existing Skill, use{' '}
        <Code>/update-skill</Code> followed by the Skill and the change you
        want.
      </P>
      <P>
        When creating a Skill, Huabu checks the catalogue and warns if a similar
        Skill may be a better update target. It does not silently turn creation
        into an update.
      </P>
      <P>
        User Skills are plain Markdown files stored under{' '}
        <Code>setting/skills/&lt;id&gt;/SKILL.md</Code> in your Home. You can
        inspect, edit, copy, or version-control them like other text files.
      </P>
      <Callout tone="tip">
        Keep each Skill focused on one reusable outcome. A short catalogue of
        distinct procedures is easier to use than many overlapping variations.
      </Callout>
    </PageLayout>
  );
}
