import {
  Bot,
  Boxes,
  FolderTree,
  Layers,
  Lightbulb,
  MessageSquare,
  Network,
  Plug,
  Sparkles,
  Workflow,
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
            to="/docs/core/externalized-sensemaking"
            icon={Layers}
            eyebrow="Core"
            title="Externalized Sensemaking"
            description="Why we built Huabu — the case for treating the canvas as external memory."
          />
          <NavCard
            to="/docs/demos"
            icon={Lightbulb}
            eyebrow="Demo cases"
            title="See it in motion"
            description="Three worked examples: research, product specs and brainstorms."
          />
        </CardGrid>

        <H2>Core ideas</H2>
        <P>
          Four short reads that explain what the product actually is and why
          each design choice was made.
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
            description="Five surfaces of AI on the canvas, all reading the same shared memory."
          />
          <NavCard
            to="/docs/core/acp"
            icon={Plug}
            eyebrow="Core"
            title="Agent Client Protocol"
            description="How Huabu talks to Claude / Copilot / Gemini CLIs through one open protocol."
          />
          <NavCard
            to="/docs/core/local-first"
            icon={FolderTree}
            eyebrow="Core"
            title="Local-first & Markdown"
            description="Every canvas is a folder of Markdown files. Back it up, sync it, version it."
          />
        </CardGrid>

        <H2>Work with AI</H2>
        <CardGrid>
          <NavCard
            to="/docs/ai/overview"
            icon={MessageSquare}
            eyebrow="AI"
            title="Chat with AI"
            description="Ask and Operate modes — open conversation vs. previewable canvas edits."
          />
          <NavCard
            to="/docs/ai/intent"
            icon={Workflow}
            eyebrow="AI"
            title="Intent & Auto-layout"
            description="Context-aware 'what next' suggestions, plus the engine that places new nodes."
          />
          <NavCard
            to="/docs/ai/external-agents"
            icon={Plug}
            eyebrow="AI"
            title="External Agents"
            description="Pair Huabu with the Copilot / Claude / Gemini CLIs through the agentlet bridge."
          />
        </CardGrid>

        <H2>Work in the canvas</H2>
        <CardGrid>
          <NavCard
            to="/docs/concepts/workspaces"
            icon={FolderTree}
            eyebrow="Canvas"
            title="Workspaces & Canvases"
            description="Pick a local folder, organise work as one or many canvases, import & export."
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
            title="Edges & Connections"
            description="Typed connections with direction, colour, dash and weight."
          />
        </CardGrid>
      </div>
    </div>
  );
}
