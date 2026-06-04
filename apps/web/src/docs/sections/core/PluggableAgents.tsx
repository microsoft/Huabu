import { Plug, Shield, Terminal, Zap } from 'lucide-react';

import {
  Callout,
  CardGrid,
  Code,
  CodeBlock,
  DocLink,
  H2,
  NavCard,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-idea', label: 'The idea' },
  { id: 'why-it-matters', label: 'Why pluggable matters' },
  { id: 'capabilities', label: 'What paired agents can do' },
  { id: 'how-it-works', label: 'How the bridge works' },
  { id: 'lifecycle', label: 'Per-message lifecycle' },
  { id: 'security', label: 'Security & sandboxing' },
  { id: 'going-further', label: 'Going further' },
];

export default function PluggableAgents() {
  return (
    <PageLayout
      title="Pluggable Agents"
      description="Huabu can drive any external coding agent that speaks the open Agent Client Protocol (ACP) — Claude, Copilot, Gemini and friends. You keep their login, quota and tool catalogue; the canvas just becomes the place they think on."
      toc={toc}
    >
      <H2>The idea</H2>
      <P>
        Huabu ships with a built-in agent for everyday canvas work. But the
        coding agents you already use are good at things Huabu shouldn&apos;t
        try to copy — terminal access, repo-aware tool calls, your own quota.
        Instead of re-implementing each one, Huabu speaks the open{' '}
        <strong>Agent Client Protocol</strong> (ACP) so any compliant agent can
        plug into a chat thread.
      </P>
      <P>
        ACP is a small JSON-RPC contract between an <strong>agent</strong> (a
        process that can think and run tools) and a <strong>client</strong> (an
        editor or canvas that hosts the conversation). The wire shape is
        intentionally narrow:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <Code>initialize</Code> / <Code>session/new</Code> /{' '}
          <Code>session/prompt</Code> — open a session and send a turn.
        </li>
        <li>
          <Code>session/update</Code> — streamed events as the agent thinks,
          calls tools and replies.
        </li>
        <li>
          <strong>Client capabilities</strong> — file reads, permission prompts,
          terminal requests, all gated by the host.
        </li>
      </ul>
      <P>
        Huabu acts as the ACP <strong>client</strong>. Any agent that speaks ACP
        — including the official <Code>claude --acp</Code>,{' '}
        <Code>copilot --acp</Code> and <Code>gemini --acp</Code> — can be paired
        with a Huabu chat thread.
      </P>

      <H2>Why pluggable matters</H2>
      <Table
        headers={['Without a shared protocol', 'With Pluggable Agents']}
        rows={[
          [
            'Each AI vendor needs a bespoke integration.',
            'Any ACP-compatible agent works through one shared bridge.',
          ],
          [
            'You re-authenticate inside Huabu separately from your CLI.',
            'Your existing CLI login, quota and tool catalogue are reused as-is.',
          ],
          [
            'Tool calls and permission prompts are vendor-specific.',
            'A single permission UI covers every agent.',
          ],
          [
            'Switching agents means switching products.',
            'Switching agents is a dropdown in the chat panel.',
          ],
        ]}
      />

      <H2>What paired agents can do</H2>
      <CardGrid>
        <NavCard
          to="/docs/ai/external-agents"
          icon={Plug}
          eyebrow="Setup"
          title="External Agents"
          description="One-click pairing for detected CLIs, plus the manual pairing flow."
        />
        <NavCard
          to="/docs/ai/agent-mode"
          icon={Zap}
          eyebrow="Workflow"
          title="Agent Mode"
          description="External agents emit the same change-list batches the built-in agent uses."
        />
        <NavCard
          to="/docs/ai/memory"
          icon={Terminal}
          eyebrow="Under the hood"
          title="Prompt payload"
          description="Each turn becomes a structured task + selected file refs the agent reads on demand."
        />
        <NavCard
          to="/docs/reference/settings"
          icon={Shield}
          eyebrow="Reference"
          title="Settings & LLM"
          description="Where pairing tokens live and how to revoke them."
        />
      </CardGrid>

      <H2>How the bridge works</H2>
      <P>
        Huabu embeds{' '}
        <DocLink href="https://github.com/hai-team/agentlet">agentlet</DocLink>,
        a small WebSocket bridge, into its server. You install the{' '}
        <Code>agentlet</Code> CLI on whichever machine the agent should run on
        (often your own laptop), then point it at Huabu with a one-time pairing
        token:
      </P>
      <CodeBlock language="bash">{`agentlet \\
  --agent "claude --acp" \\
  --server ws://localhost:3001/api/acp/agent \\
  --token <pairing-token>`}</CodeBlock>
      <P>
        Detected CLIs (Copilot, Claude, Gemini) get a one-click <em>Connect</em>{' '}
        in Settings that builds and copies that command for you — see{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>.
      </P>

      <H2>Per-message lifecycle</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          You type a message in the chat panel and pick an external agent.
        </li>
        <li>
          Huabu&apos;s preprocessor rewrites it into a structured prompt
          (&quot;task + file refs&quot;) the agent can act on.
        </li>
        <li>
          The prompt is sent over ACP <Code>session/prompt</Code> to the agent.
        </li>
        <li>
          The agent streams thoughts, text and tool calls back via{' '}
          <Code>session/update</Code>.
        </li>
        <li>
          Huabu translates those events into the same SSE stream the built-in
          agent uses, so the UI looks identical.
        </li>
      </ol>
      <Callout tone="info">
        One chat thread is bound to exactly one external agent at a time.
        Switching agents inside a thread starts an implicit new conversation, so
        contexts don&apos;t leak.
      </Callout>

      <H2>Security &amp; sandboxing</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Read-only file access</strong> by default — the agent can read{' '}
          <Code>canvas.json</Code>, <Code>nodes/**</Code> and{' '}
          <Code>.artifacts/**</Code> inside the current canvas; nothing else on
          disk.
        </li>
        <li>
          <strong>Permission prompts</strong> for anything beyond the sandbox.
          Each request shows the exact resource and tool involved.
        </li>
        <li>
          <strong>Pairing tokens</strong> are scoped, revocable and printed
          fresh per session.
        </li>
      </ul>

      <H2>Going further</H2>
      <P>
        For step-by-step pairing, troubleshooting and the manual flow when an
        agent isn&apos;t auto-detected, jump to{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>. For
        the wire format and reference implementation, see the{' '}
        <DocLink href="https://github.com/hai-team/agentlet">
          agentlet repo
        </DocLink>
        .
      </P>
    </PageLayout>
  );
}
