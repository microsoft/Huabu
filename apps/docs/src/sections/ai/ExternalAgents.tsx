// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  { id: 'access-to-your-space', label: 'Access to your Space' },
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
      description="Connect different AI agents, configure them as Profiles in Huabu."
      toc={toc}
    >
      <H2>What is an external agent?</H2>
      <P>
        External agents are AI agents outside Huabu&apos;s built-in agent
        system. Huabu currently starts local{' '}
        <DocLink href="https://agentclientprotocol.com/get-started/agents">
          ACP-compatible agents
        </DocLink>
        , connects to them over ACP, and associates each with a working
        directory and chat thread. Model access, authentication, tools,
        permissions, and usage charges remain with the agent or its provider.
      </P>

      <H2>Access to your Space</H2>
      <P>
        A connected external agent does more than chat. Like Huabu Agent, it can
        read the current Space — its nodes, their content, and layout — and
        change it by creating, editing, connecting, moving, or deleting nodes.
        This access is scoped to the single Space and conversation the agent is
        attached to while that conversation runs; it does not extend to your
        other Spaces.
      </P>
      <Callout tone="info">
        An external agent may ask for your approval before it acts. The request
        appears as a{' '}
        <DocLink href="/docs/ai/agents-and-status#read-agent-node-status">
          Permission required
        </DocLink>{' '}
        state on its Agent Node. You can also review and undo the changes an
        agent makes, just as you would for Huabu Agent.
      </Callout>

      <H2>Before you start</H2>
      <P>Prepare the agent on the same computer that runs Huabu:</P>
      <ol className="list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Install an ACP-compatible agent.</strong> Huabu automatically
          detects these nine ACP-capable agent commands or adapters after
          installation:{' '}
          <DocLink href="https://www.npmjs.com/package/@github/copilot">
            GitHub Copilot
          </DocLink>
          ,{' '}
          <DocLink href="https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp">
            Claude Agent
          </DocLink>
          ,{' '}
          <DocLink href="https://geminicli.com/docs/get-started/installation">
            Gemini
          </DocLink>
          ,{' '}
          <DocLink href="https://www.npmjs.com/package/@agentclientprotocol/codex-acp">
            Codex
          </DocLink>
          ,{' '}
          <DocLink href="https://github.com/QwenLM/qwen-code">
            Qwen Code
          </DocLink>
          ,{' '}
          <DocLink href="https://github.com/MoonshotAI/kimi-cli">
            Kimi Code
          </DocLink>
          , <DocLink href="https://opencode.ai/docs/">OpenCode</DocLink>,{' '}
          <DocLink href="https://cursor.com/docs/cli/installation">
            Cursor
          </DocLink>
          , and{' '}
          <DocLink href="https://hermes-agent.nousresearch.com/docs/user-guide/features/acp">
            Hermes Agent
          </DocLink>
          . For any other ACP-compatible agent, select{' '}
          <strong>Custom command</strong> and enter its complete ACP launch
          command, such as <Code>/path/to/my-agent --acp</Code>. Use the command
          documented by that agent.
        </li>
        <li>
          <strong>Sign in and accept any first-run prompts.</strong> Open a
          normal terminal, run the agent once, and complete its authentication
          or provider setup. Huabu cannot complete an interactive sign-in for a
          background agent process.
        </li>
        <li>
          <strong>Ensure Huabu can find the agent.</strong> The agent command
          must be on the operating system&apos;s <Code>PATH</Code> environment
          variable when Huabu starts. Restart Huabu after installing the agent
          or changing <Code>PATH</Code>. If the command is still unavailable,
          use <strong>Custom command</strong> with its absolute executable path.
        </li>
      </ol>

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
            <>
              Choose a Preset to give the agent a ready-made role and workflow,
              including any required tools, configuration, and setup. Leave it
              set to <strong>None</strong> to use the agent as installed. See{' '}
              <DocLink href="#understand-presets">Understand Presets</DocLink>.
            </>,
          ],
          [
            <strong>Agent</strong>,
            'Installed agents appear first. Agents that are not installed appear in a disabled Not installed section, followed by Custom command. Selecting a Preset filters the list to agents supported by that Preset.',
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
          [
            <strong>Icon</strong>,
            'Choose one of four Profile icon shapes and four colors to identify this External Agent in Agent menus and on Agent Nodes. Huabu assigns a Profile icon automatically, and you can change it later.',
          ],
        ]}
      />
      <P>
        See{' '}
        <DocLink href="/docs/ai/agents-and-status#external-agent-profile-icons">
          External Agent Profile icons
        </DocLink>{' '}
        to preview the available shapes and colors.
      </P>
      <P>
        With no Preset, select <strong>Create profile</strong>. The Profile is
        ready to use immediately. Choose <strong>Custom command</strong> at the
        end of the Agent menu when you need an absolute path, extra flags, or an
        ACP agent Huabu does not detect. Enter the complete command Huabu should
        launch.
      </P>

      <H2>Understand Presets</H2>
      <P>
        A <strong>Preset</strong> is a ready-made workflow for a specific task.
        It gives an external agent a specialized role, instructions, and tools,
        and may configure the working directory for that workflow. A Preset is
        not a model and does not install the external agent itself.
      </P>
      <P>
        The first release includes the following Presets. Their additional
        requirements apply alongside the installed and authenticated external
        agent described above.
      </P>
      <Table
        headers={['Preset', 'What it does', 'Additional requirements']}
        rows={[
          [
            <strong>paper-reviewer</strong>,
            'Provides a paper-review role and workflow for discussing academic papers and drafting review responses.',
            'None. It does not install npm tools or skills.',
          ],
          [
            <strong>html-slides-maker</strong>,
            'Creates static HTML presentations and optional technical diagrams.',
            <>
              Node.js with <Code>npx</Code> available on the <Code>PATH</Code>,
              plus network access to GitHub during setup so Huabu can install
              the required skills.
            </>,
          ],
          [
            <strong>hackmd-publisher</strong>,
            'Turns selected Space material into a HackMD document and writes the published URL back to Huabu.',
            <>
              A HackMD API token, Node.js with <Code>npm</Code> and{' '}
              <Code>npx</Code> available on the <Code>PATH</Code>, access to a
              working npm registry, and network access to GitHub during setup.
            </>,
          ],
        ]}
      />
      <Callout tone="tip">
        On macOS, Windows, and Linux, <Code>npm</Code> and <Code>npx</Code> are
        normally installed with Node.js. Verify that <Code>node --version</Code>
        , <Code>npm --version</Code>, and <Code>npx --version</Code> work in a
        normal terminal, then restart Huabu after installing Node.js or changing
        the <Code>PATH</Code>. A company npm mirror is supported as long as it
        can provide the packages required by the Preset.
      </Callout>
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
        Agents list. When setup finishes successfully, the setup status and
        action disappear and the Profile becomes available in Chat. If setup
        fails, the Profile remains in the list so you can fix its configuration
        and retry.
      </P>
      <Callout tone="info">
        Preset configuration belongs to the Preset and is shared by Profiles
        created from the same Preset. The working directory and display name
        still belong to each individual Profile.
      </Callout>

      <H2>Use an external agent</H2>
      <P>
        Once a Profile is available, you can choose it from the agent menus in
        Chat. A Profile that uses a Preset appears after setup finishes
        successfully.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          To start a new conversation, open the dropdown beside the{' '}
          <strong>New chat</strong> button and select a Profile under{' '}
          <strong>External Agents</strong>.
        </li>
        <li>
          Before sending the first message in an empty conversation, you can
          also use the Agent menu in the message box to choose a Profile. After
          you send the message, you cannot change the Agent for that
          conversation.
        </li>
      </ul>
      <P>
        The <strong>Add agent</strong> entry in either menu opens Settings
        directly on the External Agents page. Send a message to begin the
        conversation. Huabu opens the selected Agent when needed and continues
        using it for that conversation. Type <Kbd>/</Kbd> in the message box to
        see any commands offered by that Agent.
      </P>
      <Callout tone="info">
        A conversation keeps using the Profile it started with. Start a new
        conversation to use a different Agent or updated Profile settings.
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
            'Return to External Agents and check its status. Complete the required Preset configuration, then use Set up or Retry. When setup succeeds, the status badge disappears and the Profile becomes available in Chat.',
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
