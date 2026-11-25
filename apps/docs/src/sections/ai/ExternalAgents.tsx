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
  { id: 'utility-tasks', label: 'Utility tasks' },
  { id: 'use-an-external-agent', label: 'Use an external agent' },
  { id: 'manage-and-troubleshoot', label: 'Manage & troubleshoot' },
];

export default function ExternalAgents() {
  return (
    <PageLayout
      title="External Agents"
      description="Bring your existing agent harnesses into a shared visual workspace, without configuring a built-in model provider."
      toc={toc}
    >
      <H2>What is an external agent?</H2>
      <P>
        Huabu is a visual interface for the agents you already use. An agent
        harness is the environment that runs your agent and provides its model
        access, tools, and permissions. Connect{' '}
        <DocLink href="https://agentclientprotocol.com/get-started/agents">
          ACP-compatible agents
        </DocLink>{' '}
        on a connected device and choose them through saved Profiles. Huabu
        supplies the Space context, conversation interface, and change review.
        Authentication and usage charges remain with the agent or its provider.
        Built-In Pi is optional, not a prerequisite.
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
      <P>
        Prepare the agent on the device where it will run. For the usual local
        desktop setup, this is your own computer. For another device, open{' '}
        <strong>
          Settings &gt; Agent &gt; Connected devices &gt; Add device
        </strong>{' '}
        and follow the Agentlet connection instructions.
      </P>
      <ol className="text-fg-muted list-decimal space-y-2 pl-5 text-[15px] leading-relaxed">
        <li>
          <strong>Install an ACP-compatible agent.</strong> Huabu automatically
          detects these ten ACP-capable agent commands or adapters after
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
          ,{' '}
          <DocLink href="https://www.npmjs.com/package/@tencent-ai/codebuddy-code">
            CodeBuddy
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
          <strong>Ensure the connected device can find the agent.</strong> The
          agent command must be on the <Code>PATH</Code> inherited by its
          Agentlet process. Restart the local desktop app or reconnect the
          device after installing the agent or changing <Code>PATH</Code>.
          Claude and Codex require their ACP adapters, not only the native CLI.
          If the command is still unavailable, use{' '}
          <strong>Custom command</strong> with its absolute executable path.
        </li>
      </ol>

      <H2>Create a Profile</H2>
      <P>
        A <strong>Profile</strong> is Huabu&apos;s saved connection to one agent
        harness on a connected device, with a launch configuration and working
        directory. Supported agents discovered when a device connects receive
        Profiles automatically; you do not need to create one manually to start
        using them. Discovery does not install agents or sign in for you.
      </P>
      <P>
        To create another Profile, open Settings (
        <SettingsIcon
          aria-label="Settings"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ) &gt; <strong>Agent &gt; External agents</strong>, select{' '}
        <strong>Add agent</strong>, and complete these fields:
      </P>
      <Table
        headers={['Field', 'What to choose']}
        rows={[
          [
            <strong>Device</strong>,
            'Choose the connected device where the agent will run. Agent commands and working-directory paths belong to that device.',
          ],
          [
            <strong>Agent</strong>,
            'Choose a supported installed harness, or Custom command for another ACP-compatible launch command. Missing agents or adapters must be installed on the selected device first.',
          ],
          [
            <strong>Auto-approve all tool calls</strong>,
            'Available only for harnesses that support it, and off by default: an agent that confirms tool calls then asks before each one. Turn it on only in trusted environments, because it bypasses those confirmations. An agent with no confirmation of its own runs its tools without asking either way.',
          ],
          [
            <strong>Working directory</strong>,
            'An absolute folder path on the selected device. Automatic Profiles receive a default workspace; manually created Profiles need a working directory you choose.',
          ],
          [
            <strong>Display name</strong>,
            'A label that identifies this Profile in Settings and Agent selectors.',
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
        Save the Profile, then select it when starting a conversation. Use{' '}
        <strong>Custom command</strong> when you need an absolute executable
        path, extra flags, or an ACP agent Huabu does not detect. Enter the
        complete command documented by that agent.
      </P>

      <H2>Utility tasks</H2>
      <P>
        A connected external Profile can also handle Huabu-owned background
        tasks such as titles, summaries, keywords, and image labels. Review the
        selection under <strong>Settings &gt; Agent &gt; Utility tasks</strong>.
        If no Utility Agent configuration exists, Huabu selects an available
        external Profile automatically. Existing selections are preserved.
      </P>
      <Callout tone="info">
        Utility tasks do not silently fall back to Built-In Pi. The selected
        device and agent must remain available. Image tasks require image
        support, and automatic Huabu Memory curation still requires a Built-In
        Pi Utility Agent. See{' '}
        <DocLink href="/docs/ai/models-and-capabilities">
          Models &amp; Capabilities
        </DocLink>{' '}
        for optional services and other limits.
      </Callout>

      <H2>Use an external agent</H2>
      <P>
        Once its device is connected, choose the Profile from the agent menus in
        Chat. You do not need to configure a separate Huabu Chat Model.
      </P>
      <ul className="text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed">
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
        directly on the Agent page. Send a message to begin the conversation.
        Huabu opens the selected Agent when needed and continues using it for
        that conversation. Type <Kbd>/</Kbd> in the message box to see any
        commands offered by that Agent.
      </P>
      <Callout tone="info">
        A conversation keeps using the Profile it started with. Start a new
        conversation to use a different Agent or updated Profile settings.
      </Callout>

      <H2>Manage &amp; troubleshoot</H2>
      <P>
        In <strong>Settings &gt; Agent &gt; External agents</strong>, use{' '}
        <Pencil
          aria-label="Edit"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        to edit a Profile, and{' '}
        <Trash2
          aria-label="Delete"
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        to remove it from future agent selectors. You can update its name, icon,
        working directory, and supported launch options. A Custom command
        Profile also allows command edits. The device and harness identity are
        fixed; create another Profile to change them. Edits apply to
        conversations that have not started, not already-running sessions.
        Deleting a Profile does not delete its working directory, and later
        discovery can recreate an automatic default.
      </P>
      <Table
        headers={['Symptom', 'What to check']}
        rows={[
          [
            'An Agent is marked not installed',
            'Install the indicated CLI or ACP adapter on the selected device, complete sign-in, and reconnect it. Confirm that Agentlet inherits the PATH containing the executable.',
          ],
          [
            'The Agent menu has no suitable installed agent',
            'Check Connected devices, then install a supported harness or use Custom command with the full ACP launch command on that device.',
          ],
          [
            'An existing Profile is not available in Chat',
            'Confirm that its device is connected. Offline Profiles remain editable in Settings but cannot be selected for new work.',
          ],
          [
            'Background tasks fail after changing devices',
            'Check the selected Profile under Utility tasks. Huabu preserves that selection when a device disconnects or a Profile is deleted; choose another available Profile explicitly.',
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
