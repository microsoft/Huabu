// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bot, Settings as SettingsIcon } from 'lucide-react';

import {
  Callout,
  CodeBlock,
  DocImage,
  DocLink,
  H2,
  P,
  PageLayout,
  Shortcut,
  type TocEntry,
} from '../components';
import { NODE_ICON } from '../config/nodeIcons';

const toc: TocEntry[] = [
  { id: '1-run-huabu-from-source', label: 'Run Huabu from source' },
  { id: '2-choose-a-home-folder', label: 'Choose a Home Folder' },
  { id: '3-connect-your-agent', label: 'Connect your agent' },
  { id: '4-create-a-space', label: 'Create a Space' },
  { id: '5-add-content-to-your-space', label: 'Add content to your Space' },
  { id: '6-think-and-work-with-ai', label: 'Think and work with AI' },
];

export default function QuickStart() {
  return (
    <PageLayout
      title="Quick Start"
      description="Run Huabu, connect an agent you already use, and start working together in your first Space."
      toc={toc}
    >
      <span id="1-download-and-install-huabu" />
      <H2>1. Run Huabu from source</H2>
      <P>
        Running from source is the recommended way to use Huabu. Desktop
        installers are coming soon.
      </P>
      <P>
        Requirements: Node.js 24.16.0+ and pnpm 10+. Get the source from{' '}
        <DocLink href="https://github.com/microsoft/Huabu">GitHub</DocLink>,
        then install dependencies in the repository directory:
      </P>
      <CodeBlock language="bash">pnpm install</CodeBlock>
      <P>Start the desktop application:</P>
      <CodeBlock language="bash">pnpm start:desktop</CodeBlock>
      <P>Or start the web application:</P>
      <CodeBlock language="bash">pnpm start:web</CodeBlock>
      <P>
        For the web application, open the server address printed in the
        terminal. See the{' '}
        <DocLink href="https://github.com/microsoft/Huabu#building-from-source">
          README
        </DocLink>{' '}
        for more setup options.
      </P>

      <H2>2. Choose a Home Folder</H2>
      <P>
        On first launch, select a local folder and open it as your{' '}
        <strong>Home</strong>. Huabu stores your Spaces and their materials in
        this folder so you can choose where your work lives.
      </P>

      <H2>3. Connect your agent</H2>
      <P>
        Huabu is a visual workspace for the agents you already use. Install a
        supported ACP-compatible agent or adapter and complete its sign-in on
        the device where it will run. Open <strong>Settings</strong> (
        <SettingsIcon
          aria-label="Settings"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ) from the app header (or press <Shortcut combo="mod+," />
        ), then select <strong>Agent</strong>. Check{' '}
        <strong>Connected devices</strong> and <strong>External agents</strong>:
        supported agents discovered on a connected device receive
        ready-to-select Profiles automatically.
      </P>
      <P>
        Use <strong>Add device</strong> to follow the connection instructions
        for another device, or <strong>Add agent</strong> to create a Profile
        with your own working directory or ACP command. See{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink> for
        supported agents and setup details. The agent keeps its own model
        access, tools, permissions, and provider account.
      </P>
      <Callout tone="info">
        You do not need to configure a built-in model provider to get started.
        Built-In Pi remains an optional alternative. Review{' '}
        <strong>Settings &gt; Agent &gt; Utility tasks</strong> for background
        work, and configure optional integrations separately under{' '}
        <strong>Settings &gt; Services</strong>. See{' '}
        <DocLink href="/docs/ai/models-and-capabilities">
          Models &amp; Capabilities
        </DocLink>{' '}
        for capability requirements and limits.
      </Callout>

      <H2>4. Create a Space</H2>
      <P>
        A <strong>Space</strong> is an independent place to think and work on a
        topic, question, or project. Inside your Home, select{' '}
        <strong>New Space</strong> to create a Space and open it immediately.
      </P>
      <DocImage
        src="/docs/quick-start/create-canvas.png"
        alt="Huabu Space list with the New Space button"
        caption="Create a Space for the topic or project you want to work on."
        className="mx-auto max-w-2xl"
      />

      <H2>5. Add content to your Space</H2>
      <P>There are several ways to bring content into a Space:</P>
      <ul className="text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed">
        <li>
          <strong>Paste</strong> — copy text or an image anywhere and paste it
          straight into your Space.
        </li>
        <li>
          <strong>Drag and drop</strong> — drop files from your computer into
          your Space.
        </li>
        <li>
          <strong>Keep useful AI results</strong> — drag a useful block from a
          Chat reply into your Space, where it becomes its own node. See{' '}
          <DocLink href="/docs/work-in-a-space#drag-content-into-the-space">
            Drag content into the Space
          </DocLink>
          .
        </li>
        <li>
          <strong>Upload or Link</strong> — from the toolbar, choose{' '}
          <strong>Upload Files</strong> to add a PDF or image, or{' '}
          <strong>Add Links</strong> to bring in a web page.
        </li>
        <li>
          <strong>Create a node</strong> — start from scratch with a{' '}
          <NODE_ICON.note
            aria-hidden
            className="inline-block size-[1em] align-[-0.15em]"
          />{' '}
          <strong>Note</strong>,{' '}
          <NODE_ICON.text
            aria-hidden
            className="inline-block size-[1em] align-[-0.15em]"
          />{' '}
          <strong>Text</strong>,{' '}
          <NODE_ICON.frame
            aria-hidden
            className="inline-block size-[1em] align-[-0.15em]"
          />{' '}
          <strong>Frame</strong>, or{' '}
          <NODE_ICON.sketch
            aria-hidden
            className="inline-block size-[1em] align-[-0.15em]"
          />{' '}
          <strong>Sketch</strong> from the toolbar.
        </li>
      </ul>
      <DocImage
        src="/docs/quick-start/add-content.png"
        alt="Huabu toolbar with the Upload or Link menu open showing Upload Files and Add Links, alongside the Note, Text, Frame, and Sketch tools"
        caption="Add content by pasting, dragging, uploading — or create a Note, Text, Frame, or Sketch from the toolbar."
        className="mx-auto max-w-2xl"
      />

      <H2>6. Think and work with AI</H2>
      <P>
        Every conversation lives in the{' '}
        <DocLink href="/docs/work-with-ai">Chat Panel</DocLink>. Open it with
        the top-right button (
        <Bot
          aria-label="Open chat panel"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ), start a new conversation, and select your connected Agent Profile.
        You can:
      </P>
      <ul className="text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed">
        <li>
          <strong>Discuss your materials</strong> — select the nodes you want as
          context, ask questions, and drag useful parts of a reply back into
          your Space to keep organizing your thinking.
        </li>
        <li>
          <strong>Work on the Space</strong> — ask the agent to create, edit,
          arrange, or connect materials, then review its changes and keep or
          revert them.
        </li>
      </ul>
      <P>
        Start a new conversation to work with another Profile. Each agent brings
        the tools and capabilities of its own harness; supported model, mode,
        and permission controls appear when the agent exposes them.
      </P>
      <P>
        Prefer to ask right beside your material? Add an{' '}
        <NODE_ICON.question
          aria-hidden
          className="inline-block size-[1em] align-[-0.15em]"
        />{' '}
        <DocLink href="/docs/work-with-ai">Agent Node</DocLink> in your Space to
        start a conversation in place, so it stays in context with the ideas and
        sources around it.
      </P>
      <Callout tone="tip" title="Where to next">
        Continue with{' '}
        <DocLink href="/docs/work-in-a-space">Work in a Space</DocLink> to learn
        how to select, arrange, connect, and frame materials in a Space. For
        deeper AI workflows, continue with{' '}
        <DocLink href="/docs/work-with-ai">Work with AI</DocLink> or configure{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>.
      </Callout>
    </PageLayout>
  );
}
