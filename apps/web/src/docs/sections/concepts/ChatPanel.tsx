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
  { id: 'opening-the-panel', label: 'Opening the panel' },
  { id: 'anatomy', label: 'Anatomy of the panel' },
  { id: 'sending-a-message', label: 'Sending a message' },
  { id: 'threads', label: 'Threads' },
  { id: 'mode-selector', label: 'Mode selector' },
  { id: 'attachments', label: 'Attachments & node references' },
  { id: 'change-list', label: 'Change list (Operate mode)' },
  { id: 'history', label: 'Where chat history lives' },
];

export default function ChatPanel() {
  return (
    <PageLayout
      title="Chat Panel"
      description="The chat panel is where you talk to the AI without leaving the canvas. It docks on the right, stays out of the way until you need it, and always sees what's on the canvas — there's no separate 'context window' to manage."
      toc={toc}
    >
      <H2>Opening the panel</H2>
      <P>
        Toggle the panel from the floating button in the top-right of the canvas
        (or press <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>K</Kbd>). It slides in
        over the right edge of the canvas and pushes nothing — the canvas stays
        where it was. Toggle again to close.
      </P>

      <H2>Anatomy of the panel</H2>
      <Table
        headers={['Region', 'What lives there']}
        rows={[
          [
            <strong>Header</strong>,
            'Thread title, thread switcher, new-thread button, agent indicator (built-in vs. external).',
          ],
          [
            <strong>Conversation</strong>,
            'Scrollable transcript. AI thinking, tool calls and replies are folded into collapsible blocks so the text stays readable.',
          ],
          [
            <strong>Mode selector</strong>,
            <>
              Dropdown to the left of the input — switches between{' '}
              <strong>Ask</strong>, <strong>Operate</strong> and any paired
              external agent.
            </>,
          ],
          [
            <strong>Composer</strong>,
            <>
              The input box. Supports markdown, slash commands and the{' '}
              <Code>@</Code> picker for referencing canvas nodes.
            </>,
          ],
        ]}
      />

      <H2>Sending a message</H2>
      <P>
        Type and hit <Kbd>Enter</Kbd>; <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> adds a
        newline. Selected nodes on the canvas are sent with the message
        automatically — there&apos;s nothing to attach by hand. To send without
        the current selection, click empty canvas first to clear it.
      </P>
      <Callout tone="tip">
        The selection rule is the fastest way to point. &quot;Summarise
        this&quot; with one PDF selected and one node hovered in chat is
        unambiguous to the AI.
      </Callout>

      <H2>Threads</H2>
      <P>
        Each canvas has its own set of threads. The thread switcher in the
        header lists them by title; the New-thread button starts a fresh one
        with empty history. Switching threads is non-destructive — every thread
        is persisted under the canvas folder&apos;s <Code>.history/</Code>{' '}
        directory.
      </P>

      <H2>Mode selector</H2>
      <P>The dropdown to the left of the composer picks the mode:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Ask</strong> — free-form conversation. The AI streams text
          into the panel and can call tools, but doesn&apos;t batch-edit the
          canvas.
        </li>
        <li>
          <strong>Operate</strong> — structured canvas edits. Replies arrive as
          a previewable change list on the canvas (see below).
        </li>
        <li>
          <strong>External agents</strong> — anything you&apos;ve paired via{' '}
          <DocLink href="/docs/ai/external-agents">External Agents</DocLink>{' '}
          shows up as additional options.
        </li>
      </ul>
      <P>
        For the full breakdown of the two built-in modes, read{' '}
        <DocLink href="/docs/ai/overview">Chat with AI</DocLink>.
      </P>

      <H2>Attachments &amp; node references</H2>
      <P>
        Two ways to bring extra context into a message without selecting it on
        the canvas:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>
            <Code>@</Code> picker
          </strong>{' '}
          — type <Code>@</Code> in the composer to fuzzy-search canvas nodes by
          title; the chosen node is inlined as a reference.
        </li>
        <li>
          <strong>File attachments</strong> — drop a file onto the composer to
          attach it to a single message (without creating a node). Useful for
          one-off images or scratch transcripts.
        </li>
      </ul>

      <H2>Change list (Operate mode)</H2>
      <P>
        When Operate mode produces canvas edits, a change-list panel slides in
        next to the canvas. Each operation gets its own card with a diff and
        either <em>Accept</em> / <em>Discard</em> per item or whole-batch
        controls at the top. Discarding the batch undoes every change at once.
      </P>

      <H2>Where chat history lives</H2>
      <P>
        Threads, messages, tool calls and pending change lists are all written
        under the canvas folder:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <Code>.history/threads/</Code> — one JSON file per thread.
        </li>
        <li>
          <Code>.history/intent/</Code> — recent intent suggestions.
        </li>
      </ul>
      <P>
        See <DocLink href="/docs/reference/storage">Data Storage</DocLink> for
        the full on-disk layout.
      </P>
    </PageLayout>
  );
}
