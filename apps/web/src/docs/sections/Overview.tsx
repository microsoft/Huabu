import {
  AlignVerticalJustifyCenter,
  Bot,
  Boxes,
  Brain,
  FolderTree,
  Image as ImageIcon,
  Keyboard,
  Layers,
  Layout,
  Lightbulb,
  MessageSquare,
  MousePointer2,
  Network,
  Plug,
  ScanSearch,
  Settings,
  Soup,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { CardGrid, H2, NavCard, P } from '../components';

export default function Overview() {
  return (
    <div className="py-24">
      <header className="mb-20 space-y-4 text-center">
        <h1 className="text-fg-default text-4xl font-semibold tracking-tight">
          Huabu Handbook
        </h1>
        <P className="mx-auto max-w-2xl text-base">
          Huabu is a canvas-based human-AI collaboration framework. Spread your
          thinking out as nodes on an infinite 2D surface and work side-by-side
          with an AI that sees the whole picture.
        </P>
      </header>

      <div className="space-y-5">
        <CardGrid>
          <NavCard
            to="/docs/quickstart"
            icon={Sparkles}
            eyebrow="Start here"
            title="Quick Start"
            description="From a fresh install to a productive canvas in four steps."
          />
          <NavCard
            to="/docs/showcase"
            icon={ImageIcon}
            eyebrow="See it"
            title="Showcase"
            description="A visual tour of the kinds of work Huabu canvases tend to fit."
          />
          <NavCard
            to="/docs/core/externalized-sensemaking"
            icon={Layers}
            eyebrow="Read first"
            title="Externalized Sensemaking"
            description="The case for treating the canvas as external memory — the design centre of the product."
          />
        </CardGrid>

        <H2>Core</H2>
        <P>
          Four longer reads. Each one is a hub that links into the per-feature
          pages — read these to understand <em>what</em> Huabu is and{' '}
          <em>why</em> it&apos;s shaped this way.
        </P>
        <CardGrid>
          <NavCard
            to="/docs/core/externalized-sensemaking"
            icon={Layers}
            eyebrow="Core"
            title="Externalized Sensemaking"
            description="Workspace, canvas, nodes, edges, panels — the building blocks at a glance."
          />
          <NavCard
            to="/docs/core/agentic-canvas"
            icon={Bot}
            eyebrow="Core"
            title="Agentic Canvas"
            description="Seven surfaces of AI on one canvas, all reading the same shared memory."
          />
          <NavCard
            to="/docs/core/pluggable-agents"
            icon={Plug}
            eyebrow="Core"
            title="Pluggable Agents"
            description="How Huabu plugs into Claude / Copilot / Gemini CLIs through one open protocol."
          />
          <NavCard
            to="/docs/core/open-vault"
            icon={FolderTree}
            eyebrow="Core"
            title="Open Vault"
            description="Every canvas is a folder of Markdown files. Back it up, sync it, version it."
          />
        </CardGrid>

        <H2>Work with AI</H2>
        <CardGrid>
          <NavCard
            to="/docs/ai/chat-mode"
            icon={MessageSquare}
            eyebrow="AI"
            title="Chat Mode"
            description="Open conversation in the chat panel — explanations, syntheses, single notes."
          />
          <NavCard
            to="/docs/ai/agent-mode"
            icon={Bot}
            eyebrow="AI"
            title="Agent Mode"
            description="Structured canvas edits with a reviewable change list before anything commits."
          />
          <NavCard
            to="/docs/ai/question-mode"
            icon={Lightbulb}
            eyebrow="AI"
            title="Question Mode"
            description="Ask a question right where the source material is; the AI answers in line."
          />
          <NavCard
            to="/docs/ai/intent"
            icon={Sparkles}
            eyebrow="AI"
            title="Intent"
            description="Context-aware 'what next' suggestions you can run with one click."
          />
          <NavCard
            to="/docs/ai/digest"
            icon={Soup}
            eyebrow="AI"
            title="Digest"
            description="The background job that folds canvas activity into long-lived memory."
          />
          <NavCard
            to="/docs/ai/memory"
            icon={Brain}
            eyebrow="AI"
            title="Memory"
            description="Workspace + canvas memory tiers the AI maintains for you."
          />
          <NavCard
            to="/docs/ai/skills"
            icon={Wrench}
            eyebrow="AI"
            title="Skills"
            description="Reusable AI recipes invoked with /name in the composer."
          />
          <NavCard
            to="/docs/ai/external-agents"
            icon={Plug}
            eyebrow="AI"
            title="External Agents"
            description="Pair Huabu with the Claude / Copilot / Gemini CLIs through the agentlet bridge."
          />
        </CardGrid>

        <H2>Work in Canvas</H2>
        <CardGrid>
          <NavCard
            to="/docs/concepts/workspaces"
            icon={FolderTree}
            eyebrow="Canvas"
            title="Workspaces"
            description="Pick a local folder, organise work as one or many canvases, import & export."
          />
          <NavCard
            to="/docs/concepts/canvas-basics"
            icon={Layout}
            eyebrow="Canvas"
            title="Canvas"
            description="Select, pan, lasso, place nodes, marquee select, alignment, distribution."
          />
          <NavCard
            to="/docs/nodes/overview"
            icon={Boxes}
            eyebrow="Canvas"
            title="Nodes"
            description="Nine node types — Note, Text, Image, PDF, Video, Web, Frame, Sketch, Question."
          />
          <NavCard
            to="/docs/nodes/edges"
            icon={Network}
            eyebrow="Canvas"
            title="Edges"
            description="Typed connections with direction, colour, dash and weight."
          />
          <NavCard
            to="/docs/concepts/alignment"
            icon={AlignVerticalJustifyCenter}
            eyebrow="Canvas"
            title="Layout & Alignment"
            description="Multi-select align + distribute, smart-snap guides and Frame layouts."
          />
          <NavCard
            to="/docs/concepts/semantic-zoom"
            icon={ScanSearch}
            eyebrow="Canvas"
            title="Semantic Zoom"
            description="Heavy nodes collapse to a lightweight placeholder when zoomed out."
          />
          <NavCard
            to="/docs/concepts/layers-panel"
            icon={Layers}
            eyebrow="Canvas"
            title="Layers Panel"
            description="A flat list of every node on the canvas — rename, lock, jump-to."
          />
          <NavCard
            to="/docs/concepts/chat-panel"
            icon={MessageSquare}
            eyebrow="Canvas"
            title="Chat Panel"
            description="The persistent thread on the right side that always sees the canvas."
          />
        </CardGrid>

        <H2>Reference</H2>
        <CardGrid>
          <NavCard
            to="/docs/reference/shortcuts"
            icon={Keyboard}
            eyebrow="Reference"
            title="Keyboard Shortcuts"
            description="Every keybinding grouped by what it applies to."
          />
          <NavCard
            to="/docs/reference/settings"
            icon={Settings}
            eyebrow="Reference"
            title="Settings & LLM"
            description="Configure models, API keys, OAuth and external agent integrations."
          />
          <NavCard
            to="/docs/reference/storage"
            icon={MousePointer2}
            eyebrow="Reference"
            title="Data Storage"
            description="What lives where on disk, plus backup, sync and Git tips."
          />
        </CardGrid>
      </div>
    </div>
  );
}
