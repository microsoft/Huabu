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
  { id: 'what-it-is', label: 'What Chat Mode is' },
  { id: 'when-to-use', label: 'When to reach for it' },
  { id: 'what-the-ai-can-do', label: 'What the AI can do in Chat Mode' },
  { id: 'how-edits-arrive', label: 'How edits arrive' },
  { id: 'attachments', label: 'Attachments & node references' },
  { id: 'chat-vs-agent', label: 'Chat Mode vs. Agent Mode' },
];

export default function ChatMode() {
  return (
    <PageLayout
      title="Chat Mode"
      description="Chat Mode is Huabu's free-form conversation surface. You talk; the AI answers, streaming text and occasionally creating a single node when you ask for it. Use it when you want a discussion, an explanation or a quick note — not a sweeping Space reorg."
      toc={toc}
    >
      <H2>What Chat Mode is</H2>
      <P>
        Open the chat panel, set the mode selector to <strong>Chat</strong>,
        type, hit <Kbd>Enter</Kbd>. Replies stream into the conversation. The AI
        sees the Space overview plus any nodes you have selected as the
        spotlight — selecting before sending is how you point.
      </P>

      <H2>When to reach for it</H2>
      <Table
        headers={['Situation', 'Why Chat Mode fits']}
        rows={[
          [
            'Asking a question about a source on the Space',
            'You want a streamed answer in the panel, not a node creation.',
          ],
          [
            'Brainstorming or rubber-ducking',
            'Iteration is fast; nothing commits to the Space until you ask.',
          ],
          [
            'Getting a single Note written from a topic',
            'Ask the AI to write it, then drop the reply into a Note with one click.',
          ],
          [
            'Asking the AI to read or summarise selected nodes',
            'Selection auto-attaches; no need to copy-paste content.',
          ],
        ]}
      />

      <H2>What the AI can do in Chat Mode</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Stream natural language replies into the conversation.</li>
        <li>
          Call read-only tools on demand — inspect nodes, run grep / find on the
          Space, fetch a URL, search the web.
        </li>
        <li>
          Create the occasional one-off node when you explicitly ask
          (&quot;write that down as a Note&quot;).
        </li>
      </ul>
      <Callout tone="info">
        Chat Mode <strong>doesn&apos;t batch-edit</strong> the Space. If you
        want grouped edits with a preview, switch to{' '}
        <DocLink href="/docs/ai/agent-mode">Agent Mode</DocLink>.
      </Callout>

      <H2>How edits arrive</H2>
      <P>
        Anything Chat Mode does create appears one node at a time. Each creation
        is a normal Space operation — undoable with <Kbd>Ctrl</Kbd>/
        <Kbd>Cmd</Kbd>+<Kbd>Z</Kbd>, editable like a node you made yourself.
      </P>

      <H2>Attachments &amp; node references</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Selection auto-attaches.</strong> Send while nodes are
          selected on the Space and their full content rides along.
        </li>
        <li>
          <strong>
            <Code>@</Code> picker
          </strong>{' '}
          — type <Code>@</Code> in the composer to fuzzy-search any Space node
          by title and inline it as a reference.
        </li>
        <li>
          <strong>File / image drop</strong> — drop a file into the composer to
          attach it to a single message without creating a node.
        </li>
      </ul>

      <H2>Chat Mode vs. Agent Mode</H2>
      <Table
        headers={['Aspect', 'Chat Mode', 'Agent Mode']}
        rows={[
          [
            'Primary output',
            'Streamed conversation',
            'Reviewable change list on the Space',
          ],
          [
            'Space edits',
            'One at a time when you ask',
            'Batched: create / move / connect / group / edit',
          ],
          [
            'Best for',
            'Questions, explanations, single notes',
            'Tidying, restructuring, multi-step tasks',
          ],
          ['Undo granularity', 'Per node', 'Per item or per batch'],
        ]}
      />
      <Callout tone="tip">
        You can switch mode mid-thread — history isn&apos;t lost. Often the
        natural flow is Chat &rarr; Agent: explore the problem, then ask the
        agent to commit the result.
      </Callout>
    </PageLayout>
  );
}
