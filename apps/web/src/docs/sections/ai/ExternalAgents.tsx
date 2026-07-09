import { Pencil, Settings as SettingsIcon, Trash2 } from 'lucide-react';

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
  { id: 'add-first-agent', label: 'Add your first agent' },
  { id: 'profile-fields', label: 'What goes into a profile' },
  { id: 'using-in-chat', label: 'Using a profile in chat' },
  { id: 'editing-deleting', label: 'Editing & deleting profiles' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
];

export default function ExternalAgents() {
  return (
    <PageLayout
      title="External Agents"
      description="The how-to for bringing your own external agent into Huabu: install a supported agent, create an agent profile in Settings, and use it from any chat thread."
      toc={toc}
    >
      <Callout tone="info">
        New here? Start with{' '}
        <DocLink href="/docs/core/pluggable-agents">Pluggable Agents</DocLink>{' '}
        for the rationale and the security model. This page focuses on the
        day-to-day workflow: setting up profiles and using them in chat.
      </Callout>

      <H2>Add your first agent</H2>
      <P>
        Open Settings (
        <SettingsIcon
          aria-label="Settings"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ) → <strong>External Agents</strong> and click{' '}
        <strong>Add agent</strong>. The editor opens with these tabs:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Detected agent</strong> — pick from the supported agents Huabu
          detected on your <Code>PATH</Code>. Copilot (<Code>copilot</Code>) and
          Gemini (<Code>gemini</Code>) speak ACP natively; Claude has no native
          ACP mode, so it&apos;s detected and launched through its ACP adapter
          bin (<Code>claude-agent-acp</Code>). The launch command is assembled
          for you; you don&apos;t see or edit the command string directly.
        </li>
        <li>
          <strong>Custom command</strong> — type the full launch command
          yourself. Use this for binaries that aren&apos;t on <Code>PATH</Code>,
          for flags the structured form doesn&apos;t expose, or for any agent
          Huabu didn&apos;t detect. See the{' '}
          <DocLink href="https://github.com/hai-team/agentlet#readme">
            agentlet README
          </DocLink>{' '}
          for the full list of supported agents and flags.
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
        If no supported agent shows up under <strong>Detected agent</strong>,
        install one first — for example{' '}
        <Code>npm install -g @github/copilot</Code>,{' '}
        <Code>npm install -g @agentclientprotocol/claude-agent-acp</Code>, or{' '}
        <Code>npm install -g @google/gemini-cli</Code> — then re-open the
        editor. Detection re-runs every time Settings is opened.
      </Callout>

      <H2>Using a profile in chat</H2>
      <P>Every profile appears in two places:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          The <strong>new-chat menu</strong> in the chat panel — pick a profile
          to start a thread bound to that external agent instead of Huabu&apos;s
          built-in agent. The menu also has an inline <strong>Add agent</strong>{' '}
          entry that opens the same Profile editor without leaving the chat
          surface.
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
        (Copilot / Claude / Gemini all differ). The agent is started in the
        background on your first message and re-used for the rest of the chat;
        Huabu may release it between sessions to free resources, and will start
        it again automatically the next time you message.
      </P>
      <Callout tone="info">
        One chat thread is permanently bound to one agent. Switching agents
        means starting a new thread, so contexts don&apos;t leak across agents.
      </Callout>

      <H2>Editing & deleting profiles</H2>
      <P>
        Each row in Settings → External Agents has a{' '}
        <Pencil
          aria-label="Edit"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        (edit) and a{' '}
        <Trash2
          aria-label="Delete"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        (delete) icon. A profile is a template that&apos;s only consulted when
        you start a new chat — once a chat is running, it remembers its own copy
        of the command, working directory and other settings.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Editing</strong> a profile updates the template for future
          chats. Chats that are already open keep using the settings they were
          started with; start a new chat to pick up the new command or working
          directory.
        </li>
        <li>
          <strong>Deleting</strong> a profile (after a confirmation prompt)
          removes it from the menu. Chats that were already using it keep
          working — you just can&apos;t start a new chat with that profile
          anymore.
        </li>
      </ul>
      <Callout tone="info">
        This is deliberate: an open chat&apos;s settings never change underneath
        a turn that&apos;s already running, so an in-flight reply can&apos;t get
        confused by a profile edit or deletion.
      </Callout>

      <H2>Troubleshooting</H2>
      <P>
        If something goes wrong, Huabu surfaces it in two places: an amber{' '}
        <strong>Worker offline</strong> banner above the profile list in
        Settings → External Agents (with the last error message and a{' '}
        <strong>Restart worker</strong> button), and an inline error inside the
        affected chat thread. The common cases — and what to do about them — are
        listed below.
      </P>
      <Table
        headers={['Symptom', 'Likely cause / fix']}
        rows={[
          [
            'Built-in tab is empty in the Profile editor',
            'No supported agent is on PATH for the Sediment server. Install at least one (e.g. copilot / claude / gemini, see the install commands above) and re-open Settings.',
          ],
          [
            'Worker offline banner appears',
            'Huabu can\u2019t start the background process that drives external agents. Use Restart worker to try again immediately; if the error mentions a missing CLI or path, install / fix it and restart.',
          ],
          [
            'Profile saves but the agent never replies',
            'The agent process probably crashed on launch. Try the launch command in a normal terminal to see the real error, fix the command in the profile (or pick a different CLI), then send a new message.',
          ],
          [
            'Edited a profile but the chat still uses the old command / cwd',
            'Expected. Open chats keep the settings they were started with. Start a new chat to use the updated profile.',
          ],
        ]}
      />
    </PageLayout>
  );
}
