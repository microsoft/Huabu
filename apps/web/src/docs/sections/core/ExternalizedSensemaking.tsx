import {
  FolderTree,
  Layers,
  Layout,
  MessageSquare,
  MousePointer2,
  Network,
} from 'lucide-react';

import { NODE_ICON } from '@/config/nodeIcons';

import {
  Callout,
  CardGrid,
  DocLink,
  H2,
  H3,
  NavCard,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-problem', label: 'The problem we are solving' },
  { id: 'why-canvas', label: 'Why a canvas, not a chat sidebar' },
  { id: 'three-layers', label: 'Three layers, one surface' },
  { id: 'the-surface', label: 'Layer 1 — The surface' },
  { id: 'the-units', label: 'Layer 2 — The units (nine node types)' },
  { id: 'the-structure', label: 'Layer 3 — Structure & navigation' },
  { id: 'how-they-compose', label: 'How the layers compose' },
  { id: 'design-principles', label: 'Design principles' },
  { id: 'when-not', label: 'When the canvas is the wrong tool' },
];

export default function ExternalizedSensemaking() {
  return (
    <PageLayout
      title="Externalized Sensemaking"
      description="Huabu treats the canvas as a persistent place to put the things you are still figuring out. Spreading thought outwards — onto a surface you can rearrange, group and revisit — is the design centre of the product. This page walks the whole stack: why we built it, what it is made of, and how the pieces compose."
      toc={toc}
    >
      <H2>The problem we are solving</H2>
      <P>
        Working memory holds a handful of items at a time. Most real problems —
        digesting a research area, drafting a spec, debugging a system, building
        a literature review — are an order of magnitude larger. People cope by
        externalising: sticky notes on a wall, whiteboards, scattered text
        files, browser tabs piled to the right. The cost is that those artefacts
        are siloed from each other and invisible to any AI tool you might want
        to apply.
      </P>
      <P>
        Huabu&apos;s answer is to give externalisation a single, persistent
        visual home — a canvas that holds notes, sources, sketches, AI replies
        and the relationships between them. Because everything lives on the same
        surface, both you and the AI can read the whole picture.
      </P>

      <H2>Why a canvas, not a chat sidebar</H2>
      <P>
        The dominant pattern for AI tooling today is a sidebar with a single
        chat thread. It works for short questions; it falls apart the moment the
        problem outgrows one prompt. A canvas inverts each weakness:
      </P>
      <Table
        headers={['Chat sidebar', 'Canvas']}
        rows={[
          [
            'Context window is the last few messages.',
            'Context window is the whole canvas — nodes, edges, layout, history.',
          ],
          [
            'Outputs are linear: scroll up to find anything older.',
            'Outputs are spatial: place them where they belong, find them by location.',
          ],
          [
            'Switching topics means a new conversation and lost state.',
            'Switching focus is just panning to a different region.',
          ],
          [
            'Structure (groups, comparisons, hierarchies) is implicit in prose.',
            'Structure is explicit — frames, edges, alignment all carry meaning.',
          ],
          [
            'AI output disappears when the conversation rolls.',
            'AI output is a real node you can keep, edit or wire into something larger.',
          ],
        ]}
      />

      <H2>Three layers, one surface</H2>
      <P>
        A Huabu canvas is built out of three layers stacked on top of each
        other. Every feature in the product belongs to one of them:
      </P>
      <Table
        headers={['Layer', 'Purpose', 'Examples']}
        rows={[
          [
            <strong>Surface</strong>,
            'Where work happens — the container and the canvas itself.',
            'Workspace, Canvas, tools & gestures.',
          ],
          [
            <strong>Units</strong>,
            'What you put on the surface — typed pieces of content.',
            'Nine node types: Note, Text, Image, PDF, Video, Web, Frame, Sketch, Question.',
          ],
          [
            <strong>Structure & navigation</strong>,
            'How the units relate to each other and how you find them.',
            'Edges, Frames, Layers panel, Chat panel.',
          ],
        ]}
      />
      <Callout tone="info">
        Each section below covers one layer with the same card pattern — click
        any card to jump to the per-feature page.
      </Callout>

      <H2>Layer 1 — The surface</H2>
      <P>
        The surface is the canvas plus everything around it: the local folder
        that holds your work, the infinite 2D plane you draw on, and the
        gestures you use to move things around.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/concepts/workspaces"
          icon={FolderTree}
          eyebrow="Container"
          title="Workspace"
          description="A local folder you pick once. Holds every canvas, attachment, memory and history file. Pick any folder; an empty one is easiest."
        />
        <NavCard
          to="/docs/concepts/canvas-basics"
          icon={Layout}
          eyebrow="Surface"
          title="Canvas"
          description="An infinite 2D plane with pan, zoom, marquee select, lasso select and direct manipulation."
        />
        <NavCard
          to="/docs/concepts/canvas-basics"
          icon={MousePointer2}
          eyebrow="Interaction"
          title="Tools & Gestures"
          description="Select, pan, lasso, multi-select toolbar, alignment, distribution, copy / paste / undo across the canvas."
        />
      </CardGrid>

      <H2>Layer 2 — The units (nine node types)</H2>
      <P>
        Nodes are the things you place on the canvas. Each type has its own
        editor, its own toolbar, and its own on-disk storage shape, but they
        share the same drag / resize / connect / lock affordances. The nine
        types fall into four loose categories — content, media, structure,
        interactive.
      </P>

      <H3>Content</H3>
      <CardGrid>
        <NavCard
          to="/docs/nodes/note"
          icon={NODE_ICON.note}
          eyebrow="Content"
          title="Note Node"
          description="Rich Markdown for thoughts, outlines, AI-written prose. Lightbox editor with block-level commands."
        />
        <NavCard
          to="/docs/nodes/text"
          icon={NODE_ICON.text}
          eyebrow="Content"
          title="Text Node"
          description="Short plain text for titles, labels, captions. Edits in place — no lightbox."
        />
      </CardGrid>

      <H3>Media</H3>
      <CardGrid>
        <NavCard
          to="/docs/nodes/image"
          icon={NODE_ICON.image}
          eyebrow="Media"
          title="Image Node"
          description="PNG / JPG / GIF / WebP / SVG, auto-fit to source aspect. Drop or paste to create."
        />
        <NavCard
          to="/docs/nodes/pdf"
          icon={NODE_ICON.pdf}
          eyebrow="Media"
          title="PDF Node"
          description="Full document with thumbnails, screenshots, text selection. The AI reads extracted text by tool call."
        />
        <NavCard
          to="/docs/nodes/video"
          icon={NODE_ICON.video}
          eyebrow="Media"
          title="Video Node"
          description="MP4 / WebM / MOV / OGG plus YouTube embeds. Plays inline; expand for the full player."
        />
        <NavCard
          to="/docs/nodes/web"
          icon={NODE_ICON.web}
          eyebrow="Media"
          title="Web Node"
          description="Captured URL with the article body extracted in the background. Becomes a real, searchable source."
        />
      </CardGrid>

      <H3>Structure</H3>
      <CardGrid>
        <NavCard
          to="/docs/nodes/frames"
          icon={NODE_ICON.frame}
          eyebrow="Structure"
          title="Frame Node"
          description="Labelled group container with free / column / row layout. Auto-reflows as children resize."
        />
      </CardGrid>

      <H3>Interactive</H3>
      <CardGrid>
        <NavCard
          to="/docs/nodes/sketch"
          icon={NODE_ICON.sketch}
          eyebrow="Interactive"
          title="Sketch Node"
          description="Freehand strokes you can ask the AI to interpret into real nodes."
        />
        <NavCard
          to="/docs/nodes/question"
          icon={NODE_ICON.question}
          eyebrow="Interactive"
          title="Question Node"
          description="A sticky-note question the AI answers in a connected reply, right where the source is."
        />
      </CardGrid>

      <H2>Layer 3 — Structure & navigation</H2>
      <P>
        Nodes alone are confetti. What turns a busy canvas into something you
        can read and the AI can use are the structural features — connections
        between nodes, containers that carry layout, and panels that let you
        navigate without panning.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/nodes/edges"
          icon={Network}
          eyebrow="Relations"
          title="Edges"
          description="Typed connections with direction, colour, dash and weight. Lightweight metadata — they never own content."
        />
        <NavCard
          to="/docs/nodes/frames"
          icon={NODE_ICON.frame}
          eyebrow="Containers"
          title="Frames as structure"
          description="A Frame is both a node and a grouping primitive. Naming a Frame names a region; the AI reads frame titles too."
        />
        <NavCard
          to="/docs/concepts/layers-panel"
          icon={Layers}
          eyebrow="Navigation"
          title="Layers Panel"
          description="A flat, searchable list of every node on the canvas — rename, lock, jump-to. The canvas's table of contents."
        />
        <NavCard
          to="/docs/concepts/chat-panel"
          icon={MessageSquare}
          eyebrow="Conversation"
          title="Chat Panel"
          description="Persistent threads that always see the canvas alongside you. Sends selected nodes as focus automatically."
        />
        <NavCard
          to="/docs/nodes/content"
          icon={FolderTree}
          eyebrow="Under the hood"
          title="Node Content"
          description="How node bodies are ingested into Markdown the AI can read — the bridge between canvas and AI context."
        />
      </CardGrid>

      <H2>How the layers compose</H2>
      <P>
        A useful canvas is rarely one node type alone. Most of the value comes
        from how the layers combine. A few common shapes:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Literature review.</strong> A Frame of PDF nodes (Layer 2 ×
          Layer 3) with one Note per source (Layer 2). An edge from each PDF to
          its Note labels the relationship.
        </li>
        <li>
          <strong>Decision diagram.</strong> A row of Image or Text nodes (Layer
          2) connected by labelled edges (Layer 3). The Frame title (Layer 3)
          names the decision.
        </li>
        <li>
          <strong>Spec brief.</strong> Notes for the problem and each decision
          (Layer 2), a Frame in column layout (Layer 3) to enforce reading
          order, plus Question nodes (Layer 2 ×{' '}
          <DocLink href="/docs/ai/question-mode">AI surface</DocLink>) for the
          things still open.
        </li>
        <li>
          <strong>Idea cluster.</strong> Dozens of Text nodes (Layer 2) captured
          fast, then grouped into themed Frames (Layer 3) by an Intent
          suggestion from the AI.
        </li>
        <li>
          <strong>Reading session.</strong> Web and PDF nodes (Layer 2),
          highlights as Notes, a Sketch node where you scribbled the structure,
          and a Question node asking the AI to interpret it.
        </li>
      </ul>

      <H2>Design principles</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Persistence beats prompts.</strong> Anything worth saving gets
          a node. Nothing important should live only in the chat transcript or
          in your head.
        </li>
        <li>
          <strong>Structure is content.</strong> Spatial groupings, frame names
          and edge labels are real data the AI reads — not visual flair.
        </li>
        <li>
          <strong>Cheap iteration.</strong> Drag, regroup, undo, restart. The
          canvas rewards messy first passes and tightening later.
        </li>
        <li>
          <strong>One surface for everything.</strong> Sources, notes, sketches,
          AI replies, open questions — all on the same plane. There&apos;s no
          separate &quot;chat history&quot; tab to consult.
        </li>
        <li>
          <strong>Your files, your format.</strong> See{' '}
          <DocLink href="/docs/core/open-vault">Open Vault</DocLink> — nothing
          is locked inside the app.
        </li>
      </ul>

      <H2>When the canvas is the wrong tool</H2>
      <P>
        It&apos;s worth being honest about where Huabu doesn&apos;t earn its
        keep. A canvas is overkill for:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>One-shot questions.</strong> &quot;What&apos;s the syntax for
          X&quot; — open a chat, ask, close.
        </li>
        <li>
          <strong>Strictly linear writing.</strong> A long article that needs a
          single uninterrupted draft is happier in a normal editor.
        </li>
        <li>
          <strong>Real-time co-editing.</strong> Huabu is single-machine today;
          if you need two people typing at once, reach for a tool that&apos;s
          designed for it.
        </li>
      </ul>
      <Callout tone="tip">
        Read this page once for orientation. Day-to-day, the things you reach
        for most are{' '}
        <DocLink href="/docs/concepts/canvas-basics">Canvas</DocLink> and the
        per-node pages — start with{' '}
        <DocLink href="/docs/nodes/note">Note</DocLink> and{' '}
        <DocLink href="/docs/nodes/frames">Frame</DocLink>.
      </Callout>
    </PageLayout>
  );
}
