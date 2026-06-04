import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-is-acp', label: 'What is ACP' },
  { id: 'what-it-enables', label: 'What ACP lets Huabu do' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'security-model', label: 'Security & sandboxing' },
  { id: 'where-next', label: 'Where to go next' },
];

export default function Acp() {
  return (
    <PageLayout
      title="Agent Client Protocol (ACP)"
      description="ACP is the open protocol Huabu uses to talk to external coding agents. It lets you keep using the official Claude / Copilot / Gemini CLIs (with your own login and tool catalogue) and still drive them from the canvas."
      toc={toc}
    >
      <H2>What is ACP</H2>
      <P>
        ACP — <em>Agent Client Protocol</em> — is a JSON-RPC contract between an{' '}
        <strong>agent</strong> (a process that can think and run tools) and a{' '}
        <strong>client</strong> (an editor or canvas that hosts the
        conversation). It standardises the things any thoughtful agent needs:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <Code>initialize</Code> / <Code>session/new</Code> /{' '}
          <Code>session/prompt</Code> — open a session and send a turn.
        </li>
        <li>
          <Code>session/update</Code> — streamed events as the agent thinks,
          calls tools, and replies.
        </li>
        <li>
          Client-side capabilities — file reads, permission prompts, terminal
          requests, all gated by the host.
        </li>
      </ul>
      <P>
        Huabu acts as an ACP <strong>client</strong>. Any agent that speaks ACP
        — including the official <Code>claude --acp</Code>,{' '}
        <Code>copilot --acp</Code> and <Code>gemini --acp</Code> — can be paired
        with a Huabu chat thread.
      </P>

      <H2>What ACP lets Huabu do</H2>
      <Table
        headers={['Without ACP', 'With ACP']}
        rows={[
          [
            'Each AI vendor needs a bespoke integration in Huabu.',
            'Any ACP-compatible agent works through one shared bridge.',
          ],
          [
            'You re-authenticate in Huabu separately from your CLI.',
            'Your existing CLI login, quota and tool catalogue are reused as-is.',
          ],
          [
            'Tool calls and permissions are vendor-specific.',
            'A single permission UI and tool-call stream covers every agent.',
          ],
          [
            'Switching agents means switching products.',
            'Switching agents is a dropdown in the chat panel.',
          ],
        ]}
      />

      <H2>How it works</H2>
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
      <P>From that point on, the flow per chat message is:</P>
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
        Switching agents inside a thread starts an implicit new conversation so
        contexts don&apos;t leak.
      </Callout>

      <H2>Security &amp; sandboxing</H2>
      <P>
        External agents are powerful — they often have a Bash tool. Huabu&apos;s
        ACP integration constrains what they can do:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Read-only file access</strong> by default — the agent can read{' '}
          <Code>canvas.json</Code>, <Code>nodes/**</Code> and{' '}
          <Code>.artifacts/**</Code> inside the current canvas; nothing else on
          disk.
        </li>
        <li>
          <strong>Permission prompts</strong> for anything beyond the sandbox.
          Every request shows up as a UI popup with the exact resource and tool
          involved.
        </li>
        <li>
          <strong>Pairing tokens</strong> are scoped, revocable and printed
          fresh per session.
        </li>
      </ul>

      <H2>Where to go next</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          See the{' '}
          <DocLink href="/docs/ai/external-agents">External Agents</DocLink>{' '}
          page for step-by-step pairing, including the one-click flow when an
          agent CLI is on your PATH.
        </li>
        <li>
          For implementation details and the wire format, read the{' '}
          <DocLink href="https://github.com/hai-team/agentlet">
            agentlet repo
          </DocLink>
          .
        </li>
      </ul>
    </PageLayout>
  );
}
