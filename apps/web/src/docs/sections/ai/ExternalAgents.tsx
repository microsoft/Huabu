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
  { id: 'why-external-agents', label: 'Why use an external agent' },
  { id: 'add-first-agent', label: 'Add your first agent' },
  { id: 'profile-fields', label: 'What goes into a profile' },
  { id: 'using-in-chat', label: 'Using a profile in chat' },
  { id: 'editing-deleting', label: 'Editing & deleting profiles' },
  { id: 'daemon-health', label: 'Daemon health & troubleshooting' },
];

export default function ExternalAgents() {
  return (
    <PageLayout
      title="External Agents"
      description="Bring your own coding agent. Huabu can drive the official Copilot, Claude or Gemini CLIs (and any other ACP-compatible binary) through an embedded bridge — no pairing codes, no terminal paste. You configure an agent profile in Settings and Huabu spawns the process on demand."
      toc={toc}
    >
      <H2>Why use an external agent</H2>
      <P>
        The coding CLIs ship with their own tool catalogue, slash commands,
        login and quota. Binding one to a Huabu chat thread lets the canvas
        drive your existing agent setup — your prompts go through Huabu, but the
        agent itself keeps using your provider account, your local files and its
        own command set.
      </P>
      <P>
        Under the hood Huabu&apos;s server forks a small <Code>agentlet</Code>{' '}
        daemon and supervises it for you. You never touch the daemon directly;
        you only edit <strong>agent profiles</strong> — stable recipes that say{' '}
        <em>which</em> CLI to run, <em>where</em> to run it, and with which
        flags.
      </P>

      <H2>Add your first agent</H2>
      <P>
        Open Settings (gear icon, top-right) → <strong>External Agents</strong>{' '}
        and click <strong>Add agent</strong>. The editor opens with two tabs:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Built-in</strong> — pick from the ACP-capable CLIs Huabu
          detected on your <Code>PATH</Code> (<Code>copilot</Code>,{' '}
          <Code>claude</Code>, <Code>gemini</Code>). The launch command is
          assembled for you; you don&apos;t see or edit the command string
          directly.
        </li>
        <li>
          <strong>Custom</strong> — type the full launch command yourself. Use
          this for binaries that aren&apos;t on <Code>PATH</Code>, for flags the
          structured form doesn&apos;t expose, or for any CLI Huabu didn&apos;t
          detect.
        </li>
      </ul>
      <P>
        Fill in <strong>Working directory</strong> (the project root the agent
        should treat as its workspace), optionally tweak the{' '}
        <strong>Display name</strong>, and click <strong>Create profile</strong>
        . The profile is persisted on the server and shows up immediately in
        every chat surface — no restart, no terminal step.
      </P>
      <Callout tone="info">
        If no ACP-capable CLI shows up under <strong>Built-in</strong>, install
        one first — for example <Code>npm install -g @github/copilot</Code>,{' '}
        <Code>npm install -g @anthropic-ai/claude-code</Code>, or{' '}
        <Code>npm install -g @google/gemini-cli</Code> — then re-open the
        editor. Detection re-runs every time Settings is opened.
      </Callout>

      <H2>What goes into a profile</H2>
      <Table
        headers={['Field', 'Meaning']}
        rows={[
          [
            'Agent',
            'Which CLI the daemon should spawn. Built-in fills the launch command for you; Custom takes a free-form command line.',
          ],
          [
            'Auto-approve all tool calls',
            'Only shown for CLIs that expose an explicit allow-all flag (e.g. Copilot\u2019s --allow-all). Convenient for sandboxed runs, risky for anything that touches your filesystem or network.',
          ],
          [
            'Working directory',
            'Absolute path the agent process is launched in. The agent treats it as the project root for file edits and tool calls. A folder-picker button appears next to the field when the host supports it.',
          ],
          [
            'Display name',
            'Label shown in the chat panel and @mention menu. Defaults to "<Agent> (<folder basename>)" — leave the field blank to accept the default.',
          ],
          [
            'Auto-restart on crash',
            'Hidden under the Advanced section. When on, the daemon restarts the agent process if it exits unexpectedly. Default: on.',
          ],
          [
            'Extra args / Environment',
            'Also under Advanced. Extra args are appended to the structured launch command. Environment is one KEY=VALUE per line, merged into the agent process env (API keys, HTTPS_PROXY, etc.).',
          ],
        ]}
      />
      <P>
        The <strong>Agent</strong> field is immutable once a profile exists —
        editing the profile shows the chosen CLI as a static label. Switching
        CLIs means creating a new profile.
      </P>

      <H2>Using a profile in chat</H2>
      <P>Every profile appears in two places:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          The <strong>new-chat menu</strong> in the chat panel — pick a profile
          to start a thread bound to that external agent instead of Huabu&apos;s
          built-in agent. The menu also has an inline{' '}
          <strong>Create agent</strong> entry that opens the same Profile editor
          without leaving the chat surface.
        </li>
        <li>
          The <strong>@mention menu</strong> inside a{' '}
          <DocLink href="/docs/nodes/question">Question node</DocLink> — type{' '}
          <Code>@</Code> followed by the profile&apos;s display name to route
          that single question to the external agent.
        </li>
      </ul>
      <P>
        Inside a thread bound to an external agent, press <Kbd>/</Kbd> to see
        the agent&apos;s own slash commands — each CLI exposes its own set
        (Copilot / Claude / Gemini all differ). The agent is spawned lazily on
        first message and re-used across turns; the daemon may tear it down
        between sessions to free resources.
      </P>
      <Callout tone="info">
        One chat thread is permanently bound to one agent. Switching agents
        means starting a new thread, so contexts don&apos;t leak across agents.
      </Callout>

      <H2>Editing & deleting profiles</H2>
      <P>
        Each row in Settings → External Agents has a pencil (edit) and a trash
        (delete) icon. Edits hot-reload — the next message sent to a thread
        bound to that profile uses the updated command / cwd. Deleting a profile
        asks for confirmation; threads that were bound to the deleted profile
        fall back to Huabu&apos;s built-in agent.
      </P>
      <Callout tone="warning">
        Profile data persists across server restarts (it lives on disk under the
        workspace storage path). Pairing codes and per-session daemon tokens are
        gone in the daemon model — there is no longer anything you need to
        regenerate after a restart.
      </Callout>

      <H2>Daemon health & troubleshooting</H2>
      <P>
        On the happy path the daemon is invisible. When the supervisor cannot
        keep it online, an amber <strong>Worker offline</strong> banner appears
        above the profile list with the last error message and a{' '}
        <strong>Restart worker</strong> button. The supervisor also retries on
        its own with exponential backoff; the button is an escape hatch when
        backoff has stretched too long or you just fixed the underlying problem
        (installed the missing CLI, freed a port, etc.).
      </P>
      <Table
        headers={['Symptom', 'Likely cause / fix']}
        rows={[
          [
            'Built-in tab is empty in the Profile editor',
            'No supported CLI is on PATH for the Sediment server process. Install at least one (copilot / claude / gemini) and re-open Settings.',
          ],
          [
            'Worker offline banner with "daemon path not found"',
            'The bundled daemon entry was not found. Set HUABU_AGENTLET_DAEMON_PATH to a built agentlet daemon, or run from the monorepo so the bundled fallback resolves.',
          ],
          [
            'Profile saves but the agent never responds',
            'Open the banner area to confirm the daemon is online. If it is, the agent process likely crashed on launch — toggle Auto-restart off, try the command in a terminal manually, then re-enable it.',
          ],
          [
            'Threads bound to a deleted / renamed profile silently switch agents',
            'Expected behaviour. The binding is by profileId, so deleting falls back to the built-in agent. Renaming keeps the binding (the alias stored on the thread updates on the next turn).',
          ],
        ]}
      />
    </PageLayout>
  );
}
