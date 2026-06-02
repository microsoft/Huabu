// TODO: fill in real handbook content for this section.
import {
  Bot,
  Boxes,
  Brain,
  ExternalLink,
  Frame as FrameIcon,
  Keyboard,
  Layout,
  Layers,
  MousePointer2,
  Pencil,
  Plug,
  Settings,
  Sparkles,
  Spline,
  Workflow,
} from 'lucide-react';

import { CardGrid, H2, NavCard, P, PageLayout } from '../components';

export default function Overview() {
  return (
    <PageLayout
      title="Huabu Handbook"
      description="Huabu is a canvas-based human/AI collaboration framework. Spread your thinking out as nodes on an infinite 2D surface and work side-by-side with an AI that sees the whole picture."
    >
      <CardGrid>
        <NavCard
          to="/docs/quickstart"
          icon={Sparkles}
          eyebrow="Start here"
          title="Quick Start"
          description="From a fresh install to a productive canvas in four steps."
        />
        <NavCard
          to="/docs/concepts/workspaces"
          icon={Layout}
          eyebrow="Concepts"
          title="Workspaces & Canvases"
          description="Pick a local folder, organise your work as one or many canvases, import & export."
        />
        <NavCard
          to="/docs/concepts/canvas-basics"
          icon={MousePointer2}
          eyebrow="Concepts"
          title="Canvas Basics"
          description="Select, pan, lasso, group — the moves you need before everything else."
        />
      </CardGrid>

      <H2>Build with the canvas</H2>
      <P>
        Nine node types plus typed edges cover almost any line of work — from
        annotated reading lists to product specs to research outlines.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/nodes/overview"
          icon={Boxes}
          eyebrow="Nodes"
          title="Node Types"
          description="Note, Text, Image, PDF, Video, Web, Frame, Sketch, Question — what each one does."
        />
        <NavCard
          to="/docs/nodes/frames"
          icon={FrameIcon}
          eyebrow="Nodes"
          title="Frames"
          description="Group nodes spatially; free / column / row layouts; auto-reflow on child resize."
        />
        <NavCard
          to="/docs/nodes/sketch"
          icon={Pencil}
          eyebrow="Nodes"
          title="Sketch"
          description="Freehand strokes the AI can interpret into real nodes."
        />
        <NavCard
          to="/docs/nodes/question"
          icon={Bot}
          eyebrow="Nodes"
          title="Question Nodes"
          description="A canvas-native Ask; the AI answers right next to your source material."
        />
        <NavCard
          to="/docs/nodes/edges"
          icon={Spline}
          eyebrow="Nodes"
          title="Edges & Connections"
          description="Draw typed edges with colour, dash, weight and arrow direction."
        />
        <NavCard
          to="/docs/nodes/content"
          icon={Layers}
          eyebrow="Nodes"
          title="Node Content"
          description="How node bodies are ingested into Markdown the AI can read."
        />
      </CardGrid>

      <H2>Work with the AI</H2>
      <CardGrid>
        <NavCard
          to="/docs/ai/overview"
          icon={Bot}
          eyebrow="AI"
          title="Ask & Operate"
          description="Two chat modes — free-form conversation vs. batched canvas edits with preview."
        />
        <NavCard
          to="/docs/ai/intent"
          icon={Workflow}
          eyebrow="AI"
          title="Intent & Auto-layout"
          description="Suggested next moves, plus the force-directed engine that places new nodes."
        />
        <NavCard
          to="/docs/ai/context"
          icon={Brain}
          eyebrow="AI"
          title="How AI Sees the Canvas"
          description="The exact context blocks Huabu wraps every chat message with."
        />
        <NavCard
          to="/docs/ai/external-agents"
          icon={Plug}
          eyebrow="AI"
          title="External Agents"
          description="Pair Huabu with Copilot / Claude / Gemini CLIs through the agentlet bridge."
        />
        <NavCard
          to="/docs/ai/memory"
          icon={Brain}
          eyebrow="AI"
          title="Memory & Skills"
          description="Long-lived preferences and reusable recipes the AI can read across canvases."
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
          description="Configure models, API keys, OAuth, and external agent integrations."
        />
        <NavCard
          to="/docs/reference/storage"
          icon={ExternalLink}
          eyebrow="Reference"
          title="Data Storage"
          description="What lives where on disk, plus backup, sync and Git tips."
        />
      </CardGrid>
    </PageLayout>
  );
}
