// TODO: fill in real handbook content for this section.
import {
  Callout,
  CodeBlock,
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
      description="From a fresh install to a productive canvas in four steps. Each step links to the deeper reference page if you want more detail."
    >
      <H2>1. Pick a workspace</H2>
      <P>
        On first launch Huabu asks for a <strong>workspace</strong> — a local
        folder it will use to store everything. Pick any folder (an empty one is
        easiest). All canvases, notes, AI history, and attachments live inside
        that folder as plain files, so backups and cross-machine sync work with
        whatever tool you already use.
      </P>
      <P>Inside the workspace Huabu creates one subfolder per canvas:</P>
      <CodeBlock language="text">{`<workspace>/
├── <canvas-title>/
│   ├── canvas.json          # canvas topology
│   ├── nodes/               # one Markdown file per node
│   ├── .artifacts/          # raw binaries (PDFs, images, videos)
│   ├── memory/canvas.md     # AI-written canvas memory
│   └── .history/            # chat + intent history
└── setting/
    ├── .huabu.md            # workspace-wide memory
    └── skills/              # your custom skills`}</CodeBlock>
      <Callout tone="info">
        You can switch workspaces at any time from Settings. Recent workspaces
        are remembered so flipping between projects is one click.
      </Callout>

      <H2>2. Create a canvas</H2>
      <P>
        Inside a workspace you land on the canvas list. Hit{' '}
        <strong>New canvas</strong>, give it a name that describes what
        you&apos;re about to explore, and press <Kbd>Enter</Kbd> — you&apos;ll
        drop straight into the empty canvas, ready to work.
      </P>
      <P>
        See{' '}
        <DocLink href="/docs/concepts/workspaces">
          Workspaces &amp; Canvases
        </DocLink>{' '}
        for the full lifecycle, including importing and exporting canvases as
        <code>.zip</code> bundles.
      </P>

      <H2>3. Configure an LLM</H2>
      <P>
        Open the settings popover in the canvas header (gear icon) and pick a
        model under <strong>LLM Settings</strong>. Two ways to authenticate:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>API key</strong> — for OpenAI / Anthropic / Google / Mistral /
          Groq and friends. Keys are saved locally and only ever sent on the
          actual model call.
        </li>
        <li>
          <strong>GitHub Copilot (OAuth)</strong> — pick the provider, click{' '}
          <em>Login with GitHub</em>, paste the device code into the GitHub page
          that opens, done. Tokens refresh themselves.
        </li>
        <li>
          <strong>External agent CLI</strong> — if you already use{' '}
          <code>copilot</code>, <code>claude</code> or <code>gemini</code>{' '}
          locally, the Settings popover detects them and offers a one-click{' '}
          <em>Connect</em>. See{' '}
          <DocLink href="/docs/ai/external-agents">External Agents</DocLink>.
        </li>
      </ul>
      <Callout tone="tip">
        Full provider list, OAuth notes and troubleshooting tips live in{' '}
        <DocLink href="/docs/reference/settings">Settings &amp; LLM</DocLink>.
      </Callout>

      <H2>4. Put something on the canvas</H2>
      <P>The surface is yours. A few ways to get content in:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Drag a file in</strong> from your OS to drop a PDF, image or
          video as a node.
        </li>
        <li>
          <strong>Paste a URL</strong> with <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
          <Kbd>V</Kbd> — Huabu auto-detects images, PDFs, web pages and YouTube
          links and creates the right node.
        </li>
        <li>
          <strong>Click a node tool</strong> in the top toolbar (Frame / Note /
          Text / Sketch / Question), then click on the canvas.
        </li>
        <li>
          <strong>Write a Question</strong> — drop a Question node, type the
          question, and the AI answers in a connected reply node.
        </li>
      </ul>
      <P>
        Once you have a handful of nodes, wrap related ones with <Kbd>Cmd</Kbd>+
        <Kbd>G</Kbd> to make a <strong>Frame</strong> — that gives the AI a
        clean unit of context to reason about.
      </P>

      <H2>Bring the AI in</H2>
      <P>
        Open the chat panel on the right and ask anything about the canvas. The
        AI sees the same nodes you do — selecting nodes first focuses the
        conversation on them. Or press <Kbd>Cmd</Kbd>+<Kbd>I</Kbd> to ask the AI
        to suggest the next move based on the canvas&apos; current state.
      </P>
      <Callout tone="tip" title="Where to next">
        Press <Kbd>?</Kbd> on any canvas to view the shortcut modal. Browse{' '}
        <DocLink href="/docs/concepts/canvas-basics">Canvas Basics</DocLink> for
        the rest of the workflow, or jump straight to{' '}
        <DocLink href="/docs/ai/chat-mode">Chat Mode</DocLink> and{' '}
        <DocLink href="/docs/ai/agent-mode">Agent Mode</DocLink> to learn the
        two AI modes.
      </Callout>
    </PageLayout>
  );
}
