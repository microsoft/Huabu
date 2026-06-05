import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-idea', label: 'The idea' },
  { id: 'how-it-works', label: 'How the bridge works' },
  { id: 'lifecycle', label: 'Per-message lifecycle' },
  { id: 'security', label: 'Security & sandboxing' },
  { id: 'going-further', label: 'Going further' },
];

export default function PluggableAgents() {
  return (
    <PageLayout
      title="Pluggable Agents"
      description="Huabu is where you think; the agents you trust are where things get done. Pluggable Agents lets any external agent — coding CLIs like Claude, Copilot and Gemini, or any other compatible agent — plug into a chat thread, so the canvas can both hand finished thinking off to them and pull more minds into the thinking itself."
      toc={toc}
    >
      <H2>The idea</H2>
      <P>
        Huabu is a place to <em>think</em> — sketch, link, question,
        restructure. Thinking is only valuable when it lands as something real,
        and a single built-in agent can only carry an idea so far. Pluggable
        Agents exists to close both halves of that loop.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Get finished thinking off the canvas, fast.</strong> Hand a
          plan, a spec or a question to an external agent and let it turn the
          idea into edits, commits, tool calls or whatever else its toolbelt
          supports — using its login, its quota and its tool catalogue, not a
          re-implementation inside Huabu.
        </li>
        <li>
          <strong>Bring more agents into the thinking itself.</strong> Different
          agents have different strengths and different blind spots. Routing a
          Question node (or a whole chat thread) to a specific agent lets you
          stress-test an idea from several angles before you commit to one.
        </li>
      </ul>
      <P>
        Any external agent that speaks a standard agent protocol can plug in.
        The coding CLIs Huabu detects out of the box — <Code>claude</Code>,{' '}
        <Code>copilot</Code> and <Code>gemini</Code> — are just the obvious
        starting points; any other compatible agent works through the same
        bridge.
      </P>

      <H2>How the bridge works</H2>
      <P>
        Under the hood Huabu talks to your agent through an open agent protocol,
        so there&apos;s no per-vendor glue code: install a supported agent,
        point a profile at it in Settings → External Agents, and the canvas can
        drive it. You never launch or pair anything by hand — Huabu starts the
        agent for you when a chat first needs it and shuts it down when
        it&apos;s no longer in use.
      </P>
      <P>
        When a chat thread that uses a profile sends its first message, Huabu
        starts the configured agent in the right working directory and streams
        its responses into the chat — the experience matches the built-in agent.
        See <DocLink href="/docs/ai/external-agents">External Agents</DocLink>{' '}
        for the editor walk-through, and the{' '}
        <DocLink href="https://github.com/hai-team/agentlet#readme">
          agentlet README
        </DocLink>{' '}
        for the underlying protocol and the full list of supported agents.
      </P>

      <H2>Per-message lifecycle</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          You type a message in the chat panel and pick an external agent.
        </li>
        <li>
          Huabu rewrites it into a structured prompt (the task plus the canvas
          nodes / files it should look at) so the agent has the context it
          needs.
        </li>
        <li>The prompt is handed to the agent.</li>
        <li>
          The agent streams thoughts, text and tool calls back as it works.
        </li>
        <li>
          Huabu renders the stream in the chat panel exactly the way it renders
          the built-in agent, so the UI looks identical regardless of which CLI
          is on the other end.
        </li>
      </ol>
      <Callout tone="info">
        One chat thread uses exactly one external agent at a time. Switching
        agents inside a thread starts an implicit new conversation, so contexts
        don&apos;t leak.
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
          <strong>Permission prompts</strong> for anything beyond that sandbox.
          Each request shows the exact resource and tool involved.
        </li>
        <li>
          <strong>Credentials stay server-side.</strong> The browser never sees
          the tokens Huabu uses to talk to your agent CLI — they live only in
          the local server process.
        </li>
      </ul>

      <H2>Going further</H2>
      <P>
        For the Profile editor walk-through, troubleshooting and how the offline
        banner behaves, jump to{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>. For
        the protocol and the full list of supported agents, see the{' '}
        <DocLink href="https://github.com/hai-team/agentlet#readme">
          agentlet README
        </DocLink>
        .
      </P>
    </PageLayout>
  );
}
