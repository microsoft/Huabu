import {
  Callout,
  Code,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-it-is', label: 'What Agent Mode is' },
  { id: 'when-to-use', label: 'When to reach for it' },
  { id: 'the-change-list', label: 'The change list' },
  { id: 'lifecycle', label: 'A turn, end to end' },
  { id: 'slash-commands', label: 'Slash commands & skills' },
  { id: 'tips', label: 'Tips for good Agent prompts' },
];

export default function AgentMode() {
  return (
    <PageLayout
      title="Agent Mode"
      description="Agent Mode is the surface for structured, multi-step canvas edits. You describe the outcome; the AI plans a batch of operations; you review and accept (or discard) the batch as a single unit."
      toc={toc}
    >
      <H2>What Agent Mode is</H2>
      <P>
        Open the chat panel, set the mode selector to <strong>Agent</strong>,
        describe what you want. The AI emits a structured plan — a sequence of
        operations like <em>create</em>, <em>move</em>, <em>connect</em>,{' '}
        <em>group</em>, <em>edit</em> — and shows it in a change-review panel
        before anything commits to the canvas.
      </P>

      <H2>When to reach for it</H2>
      <Table
        headers={['Situation', 'Why Agent Mode fits']}
        rows={[
          [
            'Tidying a busy canvas',
            'One prompt produces a coordinated reshuffle you can accept or revert as one.',
          ],
          [
            'Building a comparison out of loose notes',
            'The AI can create a Frame plus per-cell Text nodes in one go.',
          ],
          [
            'Restructuring with confidence',
            'Nothing commits silently — you see every intended change first.',
          ],
          [
            'Running a saved skill',
            'Slash commands (see below) are an Agent Mode feature.',
          ],
        ]}
      />

      <H2>The change list</H2>
      <P>
        Once the AI proposes a batch, a change-review panel slides in next to
        the canvas. Every operation gets its own card:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Click a card to highlight the affected node on the canvas.</li>
        <li>Accept or discard individual items.</li>
        <li>
          Or accept / discard the <strong>whole batch</strong> — perfect for
          ambitious prompts like{' '}
          <em>
            &quot;group all the unanswered questions and draft an outline&quot;
          </em>
          .
        </li>
        <li>
          A discarded batch leaves the canvas untouched. A discarded single-item
          only rolls back that operation; the rest of the batch stays.
        </li>
      </ul>
      <Callout tone="info">
        Once committed, an accepted batch is a normal undo step. Press{' '}
        <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Z</Kbd> to roll the entire batch
        back as one move.
      </Callout>

      <H2>A turn, end to end</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          You type a prompt; optionally pre-select nodes that should be the
          focus.
        </li>
        <li>The AI inspects the canvas overview and any selected nodes.</li>
        <li>It emits a plan as a structured batch of operations.</li>
        <li>
          The change-review panel shows the plan; nothing has hit the canvas
          yet.
        </li>
        <li>
          You accept the batch (or individual items). Accepted operations commit
          atomically.
        </li>
        <li>The committed batch is now a single undoable step.</li>
      </ol>

      <H2>Slash commands &amp; skills</H2>
      <P>
        Type <Code>/</Code> at the start of the composer to open a typeahead of
        available commands. With the built-in agent the list is your workspace{' '}
        <DocLink href="/docs/ai/skills">skills</DocLink> — reusable recipes
        you&apos;ve saved. With an{' '}
        <DocLink href="/docs/ai/external-agents">external agent</DocLink> bound
        to the thread the list comes from the agent itself (each CLI ships its
        own slash commands).
      </P>
      <P>
        Navigate with <Kbd>↑</Kbd> / <Kbd>↓</Kbd>, accept with <Kbd>Tab</Kbd> or{' '}
        <Kbd>Enter</Kbd>.
      </P>

      <H2>Tips for good Agent prompts</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Select the scope first.</strong> Selection is the cheapest way
          to say &quot;only touch these&quot;.
        </li>
        <li>
          <strong>State the shape, not just the goal.</strong> &quot;Arrange
          these as a table with rows X and columns Y&quot; beats &quot;tidy
          this&quot;.
        </li>
        <li>
          <strong>Prefer single intentions per turn.</strong> Two contradictory
          goals in one prompt produces a confused batch.
        </li>
        <li>
          <strong>Iterate on the batch, not the prompt.</strong> Accepting most
          of a batch and tweaking a few items is faster than re-prompting from
          scratch.
        </li>
      </ul>
    </PageLayout>
  );
}
