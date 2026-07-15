import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  Shortcut,
  Table,
  type TocEntry,
} from '../components';
import { NODE_ICON } from '../config/nodeIcons';

const toc: TocEntry[] = [
  { id: 'choose-how-to-work', label: 'Choose how to work' },
  { id: 'give-ai-context', label: 'Give AI the right context' },
  { id: 'ask-and-discuss', label: 'Ask and discuss in Chat' },
  { id: 'let-agent-work', label: 'Let Agent work on the Space' },
  { id: 'review-ai-changes', label: 'Review AI changes' },
  { id: 'ask-beside-material', label: 'Ask beside your material' },
  { id: 'reuse-workflows', label: 'Reuse workflows with Skills' },
];

const listClassName =
  'text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed';
const orderedListClassName =
  'text-fg-muted list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed';

export default function WorkWithAI() {
  return (
    <PageLayout
      title="Work with AI"
      description="Choose the right AI surface, provide focused context, let an Agent work on your Space, and review every resulting change."
      toc={toc}
    >
      <H2>Choose how to work</H2>
      <P>
        Huabu offers three ways to work with AI. Start with the outcome you
        want, then choose the surface that keeps the conversation and any
        changes in the right place.
      </P>
      <Table
        headers={['What you want to do', 'Use']}
        rows={[
          [
            'Ask questions, discuss ideas, or understand selected material',
            <strong>Chat</strong>,
          ],
          [
            'Create, edit, arrange, or connect things in the Space',
            <strong>Agent</strong>,
          ],
          [
            'Keep a focused conversation beside the relevant material',
            <>
              <NODE_ICON.question
                aria-hidden
                className="inline-block size-[1em] align-[-0.15em]"
              />{' '}
              <strong>Agent Node</strong>
            </>,
          ],
        ]}
      />

      <H2>Give AI the right context</H2>
      <P>
        Good results start with a clear focus. Huabu sends references to the
        nodes you select, and the AI can inspect their content and the
        surrounding Space when it needs more detail.
      </P>
      <ul className={listClassName}>
        <li>
          <strong>Select relevant nodes before sending.</strong> The source
          count beside the composer confirms which nodes are in focus.
        </li>
        <li>
          <strong>Paste or drop a file or image into the composer.</strong> It
          is attached to that message without first becoming a Space node.
        </li>
        <li>
          <strong>Place an Agent Node beside the subject.</strong> Its position,
          parent Frame, and nearby or connected nodes help define the local
          context.
        </li>
      </ul>
      <Callout tone="tip">
        Select only what matters. A smaller, explicit scope is usually easier
        for the AI to interpret and easier for you to review.
      </Callout>

      <H2>Ask and discuss in Chat</H2>
      <ol className={orderedListClassName}>
        <li>Open the Chat Panel from the top-right of the Space.</li>
        <li>
          Start a conversation with <strong>Chat</strong>.
        </li>
        <li>Select any nodes that should be the focus.</li>
        <li>
          Type your question and press <Shortcut combo="Enter" />.
        </li>
        <li>Continue the conversation until the result is useful.</li>
      </ol>
      <P>
        Chat is read-only: it can inspect the Space, read selected sources,
        search files or the web, and explain what it finds, but it does not
        modify the Space. Use it for summaries, comparisons, explanations, and
        brainstorming.
      </P>
      <Callout tone="info">
        When the next step requires Space changes, start or switch to an Agent
        conversation and describe the outcome you want.
      </Callout>

      <H2>Let Agent work on the Space</H2>
      <ol className={orderedListClassName}>
        <li>Select the nodes the Agent should focus on.</li>
        <li>
          Start a conversation with <strong>Agent</strong>.
        </li>
        <li>
          Describe both the result and its shape—for example, “group these notes
          into named Frames and connect each source to its summary.”
        </li>
        <li>
          Send the request and let the Agent inspect and update the Space.
        </li>
        <li>Review the resulting changes above the composer.</li>
      </ol>
      <P>
        Agent can create, edit, move, group, connect, and remove items as part
        of a multi-step task. The changes appear in the Space as the Agent
        works; the review card then lets you keep or revert them.
      </P>

      <H2>Review AI changes</H2>
      <P>
        Agent changes are collected by conversation in a review card above the
        composer. Expand it to inspect individual changes or act on the whole
        set.
      </P>
      <Table
        headers={['Control', 'What it does']}
        rows={[
          [
            'Preview',
            'Press and hold to temporarily show the state before the change.',
          ],
          ['Keep', 'Keep one change and remove it from the review list.'],
          ['Revert', 'Undo one change when it is still safe to do so.'],
          ['Keep all', 'Keep every pending change in this conversation.'],
          [
            'Revert all',
            'Undo every pending change that can still be safely reverted.',
          ],
        ]}
      />
      <Callout tone="warning">
        If you or another Agent edits the same item later, an earlier change may
        become unsafe to revert. Huabu disables that revert instead of
        overwriting newer work.
      </Callout>

      <H2>Ask beside your material</H2>
      <P>
        An Agent Node keeps a dedicated conversation on the Space, making it
        useful for open questions that should remain visible beside their source
        material.
      </P>
      <ol className={orderedListClassName}>
        <li>
          Create an{' '}
          <NODE_ICON.question
            aria-hidden
            className="inline-block size-[1em] align-[-0.15em]"
          />{' '}
          <strong>Agent Node</strong> from the toolbar or a node&apos;s
          quick-create arrow.
        </li>
        <li>The Chat Panel opens the new node&apos;s conversation.</li>
        <li>
          Choose the built-in Chat, Agent, or an available external agent.
        </li>
        <li>Write the question and send it.</li>
        <li>
          Double-click the Agent Node later to reopen and continue its thread.
        </li>
      </ol>
      <P>
        Put the Agent Node inside the Frame you want it to understand, or
        connect it to the most relevant nodes. The conversation stays bound to
        that node and to the agent selected for it.
      </P>

      <H2>Reuse workflows with Skills</H2>
      <P>
        A Skill is a reusable set of instructions for a task you perform more
        than once. In a built-in Agent conversation, type <Code>/</Code> to open
        the Skills menu, choose a Skill, and send the turn. Any nodes selected
        at that moment remain the task&apos;s focus.
      </P>
      <Callout tone="tip">
        Use a Skill for a repeatable procedure, such as turning selected
        research notes into the same comparison structure. Use{' '}
        <DocLink href="/docs/ai/memory">Memory</DocLink> for preferences or
        facts you want carried between conversations.
      </Callout>
    </PageLayout>
  );
}
