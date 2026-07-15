import {
  Bot,
  Brain,
  Lightbulb,
  MessageSquare,
  Plug,
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
  { id: 'surfaces', label: 'AI surfaces on one Space' },
  { id: 'what-ai-sees', label: 'What the AI actually sees' },
  { id: 'edits-as-objects', label: 'Edits are first-class objects' },
  { id: 'safety', label: 'Safety rails' },
];

export default function AgenticCanvas() {
  return (
    <PageLayout
      title="Agentic Space"
      description="Huabu's AI isn't a sidebar — it's a participant on the same surface you work on. It reads the whole Space, writes back into it, and exposes capabilities tuned to different moments in your workflow."
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

      <H2>AI surfaces on one Space</H2>
      <P>
        Pick the surface that matches what you&apos;re trying to do. They all
        share the Space, so you can hop between them without losing context.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/work-with-ai"
          icon={MessageSquare}
          eyebrow="Chat"
          title="Chat Mode"
          description="Open conversation in the chat panel — explanations, syntheses, light note-writing."
        />
        <NavCard
          to="/docs/work-with-ai"
          icon={Bot}
          eyebrow="Chat"
          title="Agent Mode"
          description="Structured Space edits with a review card that lets you keep or revert each change."
        />
        <NavCard
          to="/docs/work-with-ai"
          icon={Lightbulb}
          eyebrow="On the Space"
          title="Agent Node"
          description="Keep a dedicated AI conversation beside the material it concerns."
        />
        <NavCard
          to="/docs/ai/memory"
          icon={Brain}
          eyebrow="Long-term"
          title="Memory"
          description="Cross-Space preferences and per-Space notes the AI maintains for you."
        />
        <NavCard
          to="/docs/work-with-ai"
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
      <P>Every message gives the AI a focused starting point:</P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          References to any <strong>selected nodes</strong>, including a short
          preview and the file path the AI can read for full content.
        </li>
        <li>
          For an Agent Node, a fresh view of its nearby, connected, and
          parent-Frame context.
        </li>
      </ol>
      <P>
        The built-in AI then uses tools on demand to inspect the wider Space,
        read full node bodies, fetch URLs, search, or consult memory.
      </P>

      <H2>Edits are first-class objects</H2>
      <Table
        headers={['Mode', 'How edits arrive']}
        rows={[
          [
            <strong>Chat Mode</strong>,
            'Read-only conversation: it can inspect and explain the Space without changing it.',
          ],
          [
            <strong>Agent Mode</strong>,
            'Changes appear as the Agent works, then remain reviewable with Keep and Revert controls.',
          ],
          [
            <strong>Agent Node</strong>,
            'A dedicated conversation remains anchored to a visible node on the Space.',
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
