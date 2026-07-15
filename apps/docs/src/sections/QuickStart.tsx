import {
  Callout,
  DocImage,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
} from '../components';

export default function QuickStart() {
  return (
    <PageLayout
      title="Quick Start"
      description="From download to a productive thinking space in six steps, with links to deeper guides when you want more detail."
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

      <H2>2. Choose a Home</H2>
      <P>
        On first launch, choose a local folder for Huabu to use as your{' '}
        <strong>Home</strong>. A Home holds all of your Spaces, settings,
        skills, and shared memory.
      </P>
      <P>
        See{' '}
        <DocLink href="/docs/concepts/workspaces">data storage details</DocLink>{' '}
        to learn how Huabu organizes data in this folder.
      </P>

      <H2>3. Configure Huabu Agent</H2>
      <P>
        Open <strong>Settings</strong> from the app header, then select{' '}
        <strong>Huabu Agent</strong>. Configure the capabilities you want to
        use:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Chat Model (required)</strong> — choose the provider and model
          that power Chat, Agent, and other AI interactions, then complete the
          provider&apos;s API key or OAuth authentication.
        </li>
        <li>
          <strong>Utility Model (optional)</strong> — follow the Chat Model or
          choose a faster, lower-cost model for lightweight background tasks
          such as labels and summaries.
        </li>
        <li>
          <strong>Image Generation (optional)</strong> — configure an image
          model if you want Huabu Agent to generate images in your Space.
        </li>
        <li>
          <strong>Other Capabilities (optional)</strong> — add a Tavily API key
          for web search and a RapidAPI key for importing YouTube transcripts.
        </li>
      </ul>
      <Callout tone="tip">
        Provider details, authentication steps, and troubleshooting live in{' '}
        <DocLink href="/docs/reference/settings">Settings &amp; LLM</DocLink>.
      </Callout>
      <DocImage
        src="/docs/quick-start/configure-llm-web.png"
        alt="Huabu Agent settings showing the conversation model configuration"
        caption="Web preview — this screenshot will be replaced with the desktop version."
        className="mx-auto max-w-2xl"
      />
      <Callout tone="info" title="Using an external agent?">
        Install and authenticate an ACP-compatible agent such as Copilot or
        Gemini, or an ACP adapter for Claude or Codex. Then open{' '}
        <strong>Settings → External Agents</strong> and select{' '}
        <strong>Add agent</strong>. See{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink> for
        profile setup and usage.
      </Callout>

      <H2>4. Create a Space</H2>
      <P>
        A <strong>Space</strong> is an independent place to think and work on a
        topic, question, or project. Inside your Home, select{' '}
        <strong>New Space</strong> to create a Space and open it immediately.
      </P>
      <DocImage
        src="/docs/quick-start/create-canvas-web.png"
        alt="Huabu Space list with the New Space button"
        caption="Web preview — this screenshot will be replaced with the desktop version."
        className="mx-auto max-w-2xl"
      />

      <H2>5. Bring materials into your Space</H2>
      <P>
        Add the materials you want to think with, then arrange them in whatever
        structure makes sense:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Add source material</strong> — drag in PDFs, images, videos,
          or other supported files, or paste URLs for web pages and YouTube
          videos. Huabu creates the appropriate node for each item.
        </li>
        <li>
          <strong>Add your own thinking</strong> — create Notes, Text, and
          Sketch nodes from the toolbar, or paste text directly onto the Space.
        </li>
        <li>
          <strong>Shape your Space</strong> — place related nodes near each
          other, connect explicit relationships with edges, or wrap a group in a
          Frame. Select multiple nodes and press <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
          <Kbd>G</Kbd> to frame them together.
        </li>
      </ul>
      <DocImage
        src="/docs/quick-start/add-content-web.png"
        alt="Huabu Space with a new Note node and the node toolbar"
        caption="Web preview — this screenshot will be replaced with the desktop version."
        className="mx-auto max-w-2xl"
      />

      <H2>6. Think and work with AI</H2>
      <P>
        Once your materials are in the Space, choose how you want AI to
        participate:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>
            <DocLink href="/docs/concepts/chat-panel">Chat Panel</DocLink>
          </strong>{' '}
          — talk with Huabu Agent or any paired external agent. Select the nodes
          you want to use as context, then drag useful parts of a reply back
          into the Space to continue organizing your thinking.
        </li>
        <li>
          <strong>Agent Mode</strong> — describe what you want to accomplish and
          let Huabu Agent work with the materials and structure in your Space.
          It presents any proposed changes for you to review before applying
          them.
        </li>
        <li>
          <strong>
            <DocLink href="/docs/nodes/question">Question Node</DocLink>
          </strong>{' '}
          — ask beside relevant material so the question stays in context with
          the ideas and sources around it.
        </li>
        {/*
          <li>
            <strong>Intent</strong> — press <Kbd>Cmd</Kbd>+<Kbd>I</Kbd> to ask the
            AI to suggest the next move based on the Space&apos;s current state.
          </li>
        */}
        <li>
          <strong>
            <DocLink href="/docs/ai/external-agents">External Agents</DocLink>
          </strong>{' '}
          — bring a paired ACP agent into your Space when you need specialized
          context or capabilities, such as understanding a repository, producing
          a presentation, or taking action with its own tools.
        </li>
      </ul>
      <Callout tone="tip" title="Where to next">
        Continue with{' '}
        <DocLink href="/docs/concepts/canvas-basics">Space Basics</DocLink> to
        learn how to select, arrange, connect, and frame materials in a Space.
        For deeper AI workflows, explore{' '}
        <DocLink href="/docs/ai/chat-mode">Chat Mode</DocLink>,{' '}
        <DocLink href="/docs/ai/agent-mode">Agent Mode</DocLink>, or{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>.
      </Callout>
    </PageLayout>
  );
}
