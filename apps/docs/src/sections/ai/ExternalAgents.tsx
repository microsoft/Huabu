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
  { id: 'what-is-an-external-agent', label: 'What is an external agent?' },
  { id: 'before-you-start', label: 'Before you start' },
  { id: 'create-a-profile', label: 'Create a Profile' },
  { id: 'understand-presets', label: 'Understand Presets' },
  { id: 'use-an-external-agent', label: 'Use an external agent' },
  { id: 'manage-and-troubleshoot', label: 'Manage & troubleshoot' },
];

export default function ExternalAgents() {
  return (
    <PageLayout
      title="External Agents"
      description="Connect an AI coding agent installed on your computer, configure it as a Profile in Huabu, and use it in Chat or an Agent Node."
      toc={toc}
    >
      <H2>What is an external agent?</H2>
      <P>
        An external agent is an AI agent that runs on your computer through its
        own command-line application. Huabu starts the agent, gives it the
        working directory you choose, and connects it to a chat thread. The
        agent&apos;s model access, sign-in, tools, permissions, and usage
        charges still belong to that external application.
      </P>
      <Callout tone="info">
        External Agents are independent of the models under{' '}
        <strong>Settings &gt; Huabu Agent</strong>. Configuring a Chat Model for
        Huabu does not install or sign in to Copilot, Claude, Gemini, Codex, or
        another external agent.
      </Callout>

      <H2>Before you start</H2>
      <P>Prepare the agent on the same computer that runs Huabu:</P>
      <ol className="list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Install an ACP-compatible agent.</strong> Huabu recognizes
          GitHub Copilot CLI, Claude Code through <Code>claude-agent-acp</Code>,
          Gemini CLI, and Codex through <Code>codex-acp</Code>. You can also use
          a different ACP command through <strong>Custom command</strong>.
        </li>
        <li>
          <strong>Sign in and accept any first-run prompts.</strong> Open a
          normal terminal, run the agent once, and complete its authentication
          or provider setup. Huabu cannot complete an interactive sign-in for a
          background agent process.
        </li>
        <li>
          <strong>Make the command available to Huabu.</strong> The executable
          must be on the <Code>PATH</Code> inherited by Huabu. If it is not,
          choose <strong>Custom command</strong> later and enter an absolute
          executable path.
        </li>
        <li>
          <strong>Choose a working directory.</strong> Use an existing local
          folder that contains the project or files the agent should work with.
          Your user account and the agent must be able to read it; agents that
          create or edit files also need write access.
        </li>
      </ol>
      <Callout tone="tip">
        Verify the agent in a terminal before adding it to Huabu. If the command
        can start, authenticate, and answer there, most setup problems are
        already out of the way. Installation commands and supported launch
        options are listed in the{' '}
        <DocLink href="https://github.com/hai-team/agentlet#readme">
          agentlet README
        </DocLink>
        .
      </Callout>

      <H2>Create a Profile</H2>
      <P>
        A <strong>Profile</strong> is Huabu&apos;s saved connection to one
        external agent in one working directory. Open Settings (
        <SettingsIcon
          aria-label="Settings"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ) &gt; <strong>External Agents</strong>, select{' '}
        <strong>Add agent</strong>, and complete these fields:
      </P>
      <Table
        headers={['Field', 'What to choose']}
        rows={[
          [
            <strong>Preset</strong>,
            'Leave it set to None for a general-purpose agent, or select a packaged workflow. Presets may add configuration and setup steps.',
          ],
          [
            <strong>Agent</strong>,
            'Choose an installed agent. Agents supported by a selected Preset but missing from your computer are shown as unavailable with an installation hint.',
          ],
          [
            <strong>Auto-approve all tool calls</strong>,
            'Optional. With no Preset, this appears when Huabu knows the selected agent’s auto-approval option. Enable it only when you trust the agent and the working directory.',
          ],
          [
            <strong>Working directory</strong>,
            'The local project folder used as the agent process working directory. Each Profile can point to a different folder.',
          ],
          [
            <strong>Display name</strong>,
            'Optional. Huabu derives a name from the agent or Preset and the working-directory folder when you leave it empty.',
          ],
        ]}
      />
      <P>
        With no Preset, select <strong>Create profile</strong>. The Profile is
        ready to use immediately. Choose <strong>Custom command</strong> at the
        end of the Agent menu when you need an absolute path, extra flags, or an
        ACP agent Huabu does not detect. Enter the complete command Huabu should
        launch.
      </P>

      <H2>Understand Presets</H2>
      <P>
        A <strong>Preset</strong> is a packaged Agent Team workflow. It is not a
        model and it does not include an agent executable. Instead, it defines a
        specialized role, the agents that can run it, any required
        configuration, and the setup needed to prepare your working directory.
      </P>
      <P>
        For example, <strong>paper-reviewer</strong> gives the selected agent a
        paper-review role and workflow. <strong>hackmd-publisher</strong> adds a
        HackMD token, publishing tools, and instructions for turning selected
        Space material into a document and writing the published URL back to
        Huabu. <strong>deepv-slides-maker</strong> adds a DeepV service endpoint
        and API key for producing editable slide decks. Available Presets may
        change as Huabu adds or updates packaged workflows.
      </P>
      <Table
        headers={['Without a Preset', 'With a Preset']}
        rows={[
          [
            'Huabu launches the selected agent with its standard ACP command.',
            "Huabu launches the selected agent with the Preset's managed instructions and tools.",
          ],
          [
            'You can select any installed recognized agent or enter a Custom command.',
            'You can select only an installed agent supported by that Preset. Custom command is unavailable.',
          ],
          [
            'The Profile is ready as soon as it is created.',
            'Huabu prepares the working directory before the Profile becomes available.',
          ],
          [
            'No Preset-specific configuration is required.',
            'The Preset may request tokens or other configuration. Secret values are stored securely and are never displayed again.',
          ],
        ]}
      />
      <P>
        After selecting a Preset, complete any fields shown directly below it,
        choose an available Agent and a working directory, then select{' '}
        <strong>Create and set up</strong>. Setup continues from the External
        Agents list. The Profile becomes selectable when setup reaches{' '}
        <strong>Ready</strong>. If setup fails, the Profile remains in the list
        so you can fix its configuration and retry.
      </P>
      <Callout tone="info">
        Preset configuration belongs to the Preset and is shared by Profiles
        created from the same Preset. The working directory and display name
        still belong to each individual Profile.
      </Callout>

      <H2>Use an external agent</H2>
      <P>A ready Profile appears in Huabu&apos;s agent selectors:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          In the <strong>new-chat menu</strong>, select a Profile under{' '}
          <strong>External Agents</strong> to start a thread with it. The{' '}
          <strong>Add agent</strong> entry opens Settings directly on the
          External Agents page.
        </li>
        <li>
          In an <DocLink href="/docs/work-with-ai">Agent Node</DocLink>, type{' '}
          <Code>@</Code> and the Profile name to direct a new question to that
          external agent.
        </li>
      </ul>
      <P>
        Send the first message to start the external process. Huabu reuses it
        for the thread and starts it again when necessary. Press <Kbd>/</Kbd>{' '}
        inside the thread to see slash commands exposed by that particular
        agent.
      </P>
      <Callout tone="info">
        A chat thread stays bound to the Profile it started with. To use a
        different agent or pick up changed Profile settings, start a new thread.
      </Callout>

      <H2>Manage &amp; troubleshoot</H2>
      <P>
        In <strong>Settings &gt; External Agents</strong>, use{' '}
        <Pencil
          aria-label="Edit"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        to rename a Profile or update shared Preset configuration, and{' '}
        <Trash2
          aria-label="Delete"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        to remove it from future agent selectors. The launch command, selected
        agent, Preset, and working directory are fixed after creation; create a
        new Profile to change them. Existing chat threads keep the connection
        settings captured when they were created.
      </P>
      <Table
        headers={['Symptom', 'What to check']}
        rows={[
          [
            'An Agent is marked not installed',
            'Install the indicated CLI or adapter, run it once in a terminal, and reopen the Add agent editor. Confirm that Huabu inherits the PATH containing the executable.',
          ],
          [
            'The Agent menu has no suitable installed agent',
            'For a Profile without a Preset, use Custom command with the full ACP launch command. A Preset requires one of its supported agents and cannot use a custom command.',
          ],
          [
            'A Preset Profile is not available in Chat',
            'Return to External Agents and check its status. Complete required Preset configuration, then use Set up or Retry until the Profile is Ready.',
          ],
          [
            'Worker offline appears',
            'Select Restart worker. If the error names a missing executable or path, correct the installation or Profile command first.',
          ],
          [
            'The agent starts but does not reply',
            'Run the same agent command in a terminal and check authentication, provider access, first-run prompts, and ACP support. Also confirm that the working directory still exists and is accessible.',
          ],
        ]}
      />
    </PageLayout>
  );
}
