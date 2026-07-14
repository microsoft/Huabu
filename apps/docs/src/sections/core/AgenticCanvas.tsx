import {
  Bot,
  Brain,
  Lightbulb,
  MessageSquare,
  Plug,
  Sparkles,
  Wrench,
} from 'lucide-react';

import {
  Callout,
  CardGrid,
  DocLink,
  H2,
  NavCard,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-it-means', label: 'What "agentic Space" means' },
  { id: 'shared-memory', label: 'The Space as shared memory' },
  { id: 'surfaces', label: 'Six AI surfaces on one Space' },
  { id: 'what-ai-sees', label: 'What the AI actually sees' },
  { id: 'edits-as-objects', label: 'Edits are first-class objects' },
  { id: 'safety', label: 'Safety rails' },
];

export default function AgenticCanvas() {
  return (
    <PageLayout
      title="Agentic Space"
      description="Huabu's AI isn't a sidebar — it's a participant on the same surface you work on. It reads the whole Space, writes back into it, and exposes its capabilities through six distinct surfaces tuned to different moments in your workflow."
      toc={toc}
    >
      <H2>What &quot;agentic Space&quot; means</H2>
      <P>
        The phrase has two pieces. <strong>Space</strong> means the AI works on
        the same 2D surface you do, with the same nodes, frames and edges.{' '}
        <strong>Agentic</strong> means the AI can take initiative — call tools,
        run multi-step plans, edit the Space, ask permission for anything it
        can&apos;t do alone — instead of just responding to one prompt at a
        time.
      </P>

      <H2>The Space as shared memory</H2>
      <P>
        Most assistants are stateless between turns. Huabu&apos;s AI is
        stateless between turns <em>too</em>, but the Space itself is the state:
        what you see is what it sees, and what it writes is something you can
        edit. Three concrete consequences:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Pointing is selection.</strong> Highlighting nodes on the
          Space tells the AI which inputs matter for the next turn.
        </li>
        <li>
          <strong>Grouping is grammar.</strong> Frame names and edge labels show
          up in the Space overview the AI reads each turn.
        </li>
        <li>
          <strong>Output is durable.</strong> Anything the AI produces is a real
          node you can keep, edit or delete — not a chat bubble that scrolls
          off-screen.
        </li>
      </ul>

      <H2>Six AI surfaces on one Space</H2>
      <P>
        Pick the surface that matches what you&apos;re trying to do. They all
        share the Space, so you can hop between them without losing context.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/ai/chat-mode"
          icon={MessageSquare}
          eyebrow="Chat"
          title="Chat Mode"
          description="Open conversation in the chat panel — explanations, syntheses, light note-writing."
        />
        <NavCard
          to="/docs/ai/agent-mode"
          icon={Bot}
          eyebrow="Chat"
          title="Agent Mode"
          description="Structured Space edits with a reviewable change list before anything commits."
        />
        <NavCard
          to="/docs/ai/question-mode"
          icon={Lightbulb}
          eyebrow="On the Space"
          title="Question Mode"
          description="Ask a question right where the source material is; the AI answers in line."
        />
        <NavCard
          to="/docs/ai/intent"
          icon={Sparkles}
          eyebrow="On the Space"
          title="Intent"
          description="Context-aware “what next” suggestions you can run with one click."
        />
        <NavCard
          to="/docs/ai/memory"
          icon={Brain}
          eyebrow="Long-term"
          title="Memory"
          description="Cross-Space preferences and per-Space notes the AI maintains for you."
        />
        <NavCard
          to="/docs/ai/skills"
          icon={Wrench}
          eyebrow="Long-term"
          title="Skills"
          description="Reusable AI recipes you invoke with /name in the composer."
        />
        <NavCard
          to="/docs/ai/external-agents"
          icon={Plug}
          eyebrow="Bring your own"
          title="External Agents"
          description="Pair Huabu with Claude / Copilot / Gemini CLIs through the Pluggable Agents bridge."
        />
      </CardGrid>

      <H2>What the AI actually sees</H2>
      <P>Two things travel with every message you send:</P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          A compact <strong>Space overview</strong> — node list, frame
          hierarchy, recent operations.
        </li>
        <li>
          The full content of any <strong>selected</strong> nodes, never
          truncated.
        </li>
      </ol>
      <P>
        Two more layers come in on demand: <strong>memory</strong> for
        long-lived preferences, and <strong>tool calls</strong> for reading more
        node bodies, fetching URLs, running the AI&apos;s built-in search.
      </P>

      <H2>Edits are first-class objects</H2>
      <Table
        headers={['Mode', 'How edits arrive']}
        rows={[
          [
            <strong>Chat Mode</strong>,
            'One node at a time, undoable with Ctrl/Cmd+Z like your own edits.',
          ],
          [
            <strong>Agent Mode</strong>,
            'Batched as a structured change list — accept whole, accept per-item, or discard.',
          ],
          [
            <strong>Question node</strong>,
            'Reply is appended to the node as soon as the AI finishes.',
          ],
          [
            <strong>Intent</strong>,
            'Suggested edits are committed as a batch you can roll back.',
          ],
        ]}
      />

      <H2>Safety rails</H2>
      <Callout tone="info">
        Nothing the AI does happens silently. Built-in tools are sandboxed to
        the current Home; external agents stay read-only by default and prompt
        for permission for anything beyond that. See{' '}
        <DocLink href="/docs/core/pluggable-agents">Pluggable Agents</DocLink>{' '}
        for the full security model.
      </Callout>
    </PageLayout>
  );
}
