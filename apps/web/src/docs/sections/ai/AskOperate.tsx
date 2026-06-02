// TODO: fill in real handbook content for this section.
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
  { id: 'mental-model', label: 'Mental model' },
  { id: 'chat-panel', label: 'Chat panel' },
  { id: 'ask-mode', label: 'Ask mode' },
  { id: 'operate-mode', label: 'Operate mode' },
  { id: 'change-list', label: 'The change list' },
  { id: 'slash-commands', label: 'Slash commands' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'threads', label: 'Threads & agent binding' },
  { id: 'choosing-a-mode', label: 'Choosing a mode' },
];

export default function AskOperate() {
  return (
    <PageLayout
      title="Ask & Operate"
      description="Huabu's AI shares the canvas with you — it can read the entire context, not just your last message. This page covers the two conversational modes in the chat panel and how to choose between them."
      toc={toc}
    >
      <H2>Mental model</H2>
      <P>
        <strong>The canvas is shared memory.</strong> What you see is what the
        AI sees; what it writes lands on the same canvas. Specifically:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          The AI gets a canvas overview (node list, frame hierarchy, recent
          operations) with every message.
        </li>
        <li>
          Nodes you <strong>select</strong> are treated as focus — their full
          content is sent along, not truncated.
        </li>
        <li>
          Ingested node bodies are reachable via tool calls (see{' '}
          <DocLink href="/docs/nodes/content">Node Content</DocLink>).
        </li>
      </ul>

      <H2>Chat panel</H2>
      <P>
        The chat panel lives on the right of the canvas (toggle it from the
        floating button in the top-right). The mode selector to the left of the
        input switches between <strong>Ask</strong> and <strong>Operate</strong>
        ; one thread can switch back and forth.
      </P>

      <H2>Ask mode</H2>
      <P>
        Best for: open questions, explanations, syntheses, lightweight{' '}
        <em>&quot;write that down as a Note&quot;</em>.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>The AI streams text into the conversation.</li>
        <li>
          Tools are called on demand (web search, inspect nodes, read files, run
          grep / find).
        </li>
        <li>
          The AI doesn&apos;t batch-edit the canvas. Anything it does create
          appears one node at a time and is undoable with <Kbd>Ctrl</Kbd>/
          <Kbd>Cmd</Kbd>+<Kbd>Z</Kbd>.
        </li>
      </ul>

      <H2>Operate mode</H2>
      <P>
        Best for: batch tidying, precise canvas edits, turning an idea into a
        concrete set of operations.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>You describe the change in natural language.</li>
        <li>
          The AI emits a structured batch (create / move / connect / group /
          edit).
        </li>
        <li>
          After execution, a <strong>change list</strong> appears next to the
          canvas — undo the batch as one, keep it as one, or review item-by-item
          (see below).
        </li>
      </ul>

      <H2>The change list</H2>
      <P>
        Operate runs are not silent. Every change Huabu commits to the canvas on
        your behalf gets a card in the change-review panel:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Click a card to highlight the affected node on the canvas.</li>
        <li>Revert any single change without rolling back the rest.</li>
        <li>
          Or accept the whole batch as one undoable unit — perfect for ambitious
          requests like{' '}
          <em>group all the unanswered questions and draft an outline</em>.
        </li>
      </ul>

      <H2>Slash commands</H2>
      <P>
        Type <Code>/</Code> at the start of the chat input to open a typeahead
        of available commands:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          With an <strong>external agent</strong> bound to the thread, the list
          comes from the agent itself (Copilot, Claude, Gemini all expose their
          own slash commands).
        </li>
        <li>
          With the <strong>built-in agent</strong> in Operate mode, the list
          shows your workspace skills — reusable recipes you&apos;ve saved. See{' '}
          <DocLink href="/docs/ai/memory">Memory &amp; Skills</DocLink>.
        </li>
      </ul>
      <P>
        Navigate with <Kbd>↑</Kbd> / <Kbd>↓</Kbd>, accept with <Kbd>Tab</Kbd> or{' '}
        <Kbd>Enter</Kbd>.
      </P>

      <H2>Attachments</H2>
      <P>The AI can see more than just text. You can attach:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>PDF selections</strong> — drag a text or screenshot selection
          out of the PDF lightbox into the chat panel.
        </li>
        <li>
          <strong>Images</strong> — drop image files into the chat input.
        </li>
        <li>
          <strong>Selected nodes</strong> — auto-attached as context when you
          send while nodes are selected on the canvas.
        </li>
      </ul>

      <H2>Threads & agent binding</H2>
      <P>
        Each canvas has its own conversation history, broken into{' '}
        <strong>threads</strong>. Start a fresh thread for a new topic to avoid
        context pollution. History survives quit / reopen.
      </P>
      <P>
        Each thread is bound to one agent (the built-in agent, or an external
        one). Open the new-chat menu to start a thread bound to a different
        agent — perfect for comparing how two agents answer the same prompt side
        by side.
      </P>

      <H2>Choosing a mode</H2>
      <Table
        headers={['What you want to do', 'Pick']}
        rows={[
          ['Ask a question / explain / summarise', <strong>Ask</strong>],
          ['Batch-tidy or rearrange the canvas', <strong>Operate</strong>],
          [
            'Have the AI write a note and drop it on the canvas',
            'Either; Ask is lighter.',
          ],
          [
            'Avoid any canvas changes — only get an answer',
            <strong>Ask</strong>,
          ],
        ]}
      />
      <Callout tone="tip">
        To focus the AI,{' '}
        <strong>select the relevant nodes before sending</strong>. The selection
        becomes the spotlight.
      </Callout>
    </PageLayout>
  );
}
