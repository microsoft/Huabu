// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bot, Settings as SettingsIcon } from 'lucide-react';

import {
  Callout,
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
  { id: '1-download-and-install-huabu', label: 'Download and install Huabu' },
  { id: '2-choose-a-home-folder', label: 'Choose a Home Folder' },
  { id: '3-configure-models-and-keys', label: 'Configure models and keys' },
  { id: '4-create-a-space', label: 'Create a Space' },
  { id: '5-add-content-to-your-space', label: 'Add content to your Space' },
  { id: '6-think-and-work-with-ai', label: 'Think and work with AI' },
];

export default function QuickStart() {
  return (
    <PageLayout
      title="Quick Start"
      description="Install Huabu, create your first Space, add one piece of material, and have your first conversation with AI."
      toc={toc}
    >
      <H2>1. Download and install Huabu</H2>
      <P>
        Download the latest version from{' '}
        <DocLink href="https://github.com/microsoft/Huabu/releases/latest">
          GitHub Releases
        </DocLink>
        . Choose the <code>.dmg</code> package on macOS or the <code>.exe</code>{' '}
        package on Windows, then install and launch Huabu.
      </P>

      <H2>2. Choose a Home Folder</H2>
      <P>
        On first launch, select a local folder and open it as your{' '}
        <strong>Home</strong>. Huabu stores your Spaces and their materials in
        this folder so you can choose where your work lives.
      </P>

      <H2>3. Configure models and keys</H2>
      <P>
        Open <strong>Settings</strong> (
        <SettingsIcon
          aria-label="Settings"
          className="inline-block size-[1em] align-[-0.15em]"
        />
        ) from the app header (or press <Shortcut combo="mod+," />
        ), then select <strong>Huabu Agent</strong>. The{' '}
        <strong>Chat Model</strong> is the only model you must set up to get
        started. Most providers ask for a <strong>Default model</strong>; Azure
        OpenAI asks for a single <strong>Deployment</strong>. When your provider
        offers multiple models, you can switch models for one conversation from
        the Chat Panel without changing the Settings default.
      </P>
      <P>
        The same page also holds optional settings — a{' '}
        <strong>Utility Model</strong> for lightweight background tasks,{' '}
        <strong>Image Generation</strong>, and capabilities such as{' '}
        <strong>Web Search</strong> — that you can configure later.
      </P>
      <Callout tone="info">
        API keys and sign-in credentials saved in the Huabu desktop app are
        encrypted at rest using your operating system&apos;s protected storage.
        Huabu never stores them as plain text.
      </Callout>
      <DocImage
        src="/docs/quick-start/configure-llm.png"
        alt="Huabu Agent settings with the Chat Model provider, endpoint, and API key fields"
        caption="Configure a provider, credentials, and its Chat Model or Deployment in Huabu Agent settings."
        className="mx-auto max-w-2xl"
      />

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
        ), start a new conversation, and choose who you are talking to:
      </P>
      <ul className="text-fg-muted list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed">
        <li>
          <strong>Huabu Chat</strong> — a plain conversation. Select the nodes
          you want as context, ask questions, and drag useful parts of a reply
          back into your Space to keep organizing your thinking.
        </li>
        <li>
          <strong>Huabu Agent</strong> — a conversation in which the agent can
          also act on your Space. It works with your materials and structure and
          records its changes so you can keep or revert them.
        </li>
      </ul>
      <P>
        You can add more agents too. Pair an{' '}
        <DocLink href="/docs/ai/external-agents">External Agent</DocLink> in{' '}
        <strong>Settings → External Agents</strong>; afterwards it appears in
        the Chat Panel as an option when you start a new conversation, bringing
        its own specialized context or tools, such as understanding a repository
        or producing a presentation.
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
