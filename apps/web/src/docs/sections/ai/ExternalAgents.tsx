// TODO: fill in real handbook content for this section.
import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'why-external-agents', label: 'Why use an external agent' },
  { id: 'detected-agents', label: 'Detected agents (one-click)' },
  { id: 'manual-pairing', label: 'Manual pairing (advanced)' },
  { id: 'pairing-codes', label: 'Pairing codes & reconnects' },
  { id: 'auto-path', label: 'agentlet on PATH' },
  { id: 'using-an-agent', label: 'Using an agent in chat' },
  { id: 'unpairing', label: 'Unpairing' },
];

export default function ExternalAgents() {
  return (
    <PageLayout
      title="External Agents"
      description="Bring your own coding agent. Huabu can pair with the official Copilot, Claude or Gemini CLIs (and any other ACP-compatible agent) through a small bridge called agentlet. The external agent then drives the chat panel just like the built-in agent does."
      toc={toc}
    >
      <H2>Why use an external agent</H2>
      <P>
        The CLIs ship with their own tool catalogue, slash commands, login and
        quota. Pairing one with Huabu lets the canvas drive your existing agent
        setup — your prompts go through Huabu, but the agent itself keeps using
        your provider account, your local files (if you grant access) and its
        own command set.
      </P>

      <H2>Detected agents (one-click)</H2>
      <P>
        Open Settings → External Agents. Huabu probes your machine for installed
        CLIs (<Code>copilot</Code>, <Code>claude</Code>, <Code>gemini</Code>)
        and lists only the ones it finds. Each card has a{' '}
        <strong>Connect</strong> button that does three things at once:
      </P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Generates a fresh pairing code.</li>
        <li>
          Builds the full launch command (something like{' '}
          <Code>
            agentlet --token XXXX-XXXX --agent &quot;copilot --acp
            --allow-all&quot;
          </Code>
          ).
        </li>
        <li>Copies that command to your clipboard.</li>
      </ol>
      <P>
        Paste the command into a terminal within 60 seconds, hit Enter, and the
        chat panel switches over to the new agent. The{' '}
        <strong>Auto-approve tool calls</strong> toggle is shown only for agents
        that support a clean &quot;approve all&quot; flag (Copilot today) —
        it&apos;s on by default for hassle-free use.
      </P>

      <H2>Manual pairing (advanced)</H2>
      <P>
        For any CLI Huabu didn&apos;t detect (a remote shell, a custom build, a
        non-standard binary) use <strong>Pair manually</strong>:
      </P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Click <em>Generate code</em>. You get an 8-character pairing code like{' '}
          <Code>XXXX-XXXX</Code> with a 60-second countdown.
        </li>
        <li>
          On the machine running the agent, run agentlet with that code and your
          launch command:
        </li>
      </ol>
      <CodeBlock language="bash">
        agentlet --token XXXX-XXXX --agent &quot;claude --acp&quot;
      </CodeBlock>
      <P>
        The first connection from any agent claims the code; subsequent
        reconnections by the same agent reuse it.
      </P>

      <H2>Pairing codes & reconnects</H2>
      <Table
        headers={['Event', 'What happens']}
        rows={[
          ['Code generated', '60-second window for the first connection.'],
          [
            'First connection',
            'Locks the code to the connecting agent&apos;s identity.',
          ],
          [
            'Same agent reconnects (wifi blip, dev hot-reload, laptop wake)',
            'Has up to 5 minutes to come back with the same code; chat continues seamlessly.',
          ],
          ['Different agent tries the code', 'Refused — the code is bound.'],
          ['You click the ✕ on the agent card', 'Code revoked immediately.'],
          ['Sediment server restart', 'All pairings cleared; you regenerate.'],
        ]}
      />

      <H2>agentlet on PATH</H2>
      <P>
        Running <Code>pnpm install</Code> in the Sediment repo adds the bundled{' '}
        <Code>bin/agentlet</Code> wrapper to your user shell PATH automatically
        (zsh / bash / fish on POSIX, User PATH on Windows). After that, the{' '}
        <Code>agentlet</Code> command works from any new terminal — no{' '}
        <Code>export PATH=...</Code> needed.
      </P>
      <P>If you don&apos;t want that behaviour, opt out:</P>
      <CodeBlock language="bash">{`# Opt out for this install:
HUABU_NO_AUTO_PATH=1 pnpm install`}</CodeBlock>
      <P>CI environments are skipped automatically.</P>

      <H2>Using an agent in chat</H2>
      <P>
        Once paired, the agent shows up in the new-chat menu and on each
        thread&apos;s header. You can:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Start a new thread bound to the external agent — it replaces the
          built-in agent for that thread only.
        </li>
        <li>
          Use <Kbd>/</Kbd> to see the agent&apos;s own slash commands (Copilot /
          Claude / Gemini each expose their own).
        </li>
        <li>
          Mention the agent from a{' '}
          <DocLink href="/docs/nodes/question">Question node</DocLink> via{' '}
          <Code>@agent-name</Code> so its answers come from that agent.
        </li>
        <li>
          Stage multiple agents at once — one per thread or one per question —
          and compare answers.
        </li>
      </ul>

      <H2>Unpairing</H2>
      <P>
        Click the ✕ on the agent card in Settings. The code revokes, the
        agentlet wrapper exits cleanly, and any future runs need a fresh code.
      </P>
      <Callout tone="warning">
        Pairing codes live entirely in memory on the Sediment server — they
        never touch the disk. A server restart wipes them; you&apos;ll
        regenerate next time you want to pair.
      </Callout>
    </PageLayout>
  );
}
