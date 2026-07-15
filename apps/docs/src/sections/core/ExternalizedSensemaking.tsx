import {
  FolderTree,
  Layers,
  Layout,
  MessageSquare,
  MousePointer2,
  Network,
} from 'lucide-react';

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
import { NODE_ICON } from '../../config/nodeIcons';

const toc: TocEntry[] = [
  { id: 'the-problem', label: 'The problem we are solving' },
  { id: 'why-canvas', label: 'Why a Space, not a chat sidebar' },
  { id: 'three-layers', label: 'Three layers, one surface' },
  { id: 'the-surface', label: 'Layer 1 — The surface' },
  { id: 'the-units', label: 'Layer 2 — The units' },
  { id: 'the-structure', label: 'Layer 3 — Structure & navigation' },
  { id: 'how-they-compose', label: 'How the layers compose' },
  { id: 'design-principles', label: 'Design principles' },
  { id: 'when-not', label: 'When the Space is the wrong tool' },
];

export default function ExternalizedSensemaking() {
  return (
    <PageLayout
      title="Externalized Sensemaking"
      description="Huabu treats the Space as a persistent place to put the things you are still figuring out. Spreading thought outwards — onto a surface you can rearrange, group and revisit — is the design centre of the product. This page walks the whole stack: why we built it, what it is made of, and how the pieces compose."
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
        visual home — a Space that holds notes, sources, sketches, AI replies
        and the relationships between them. Because everything lives on the same
        surface, both you and the AI can read the whole picture.
      </P>

      <H2>Why a Space, not a chat sidebar</H2>
      <P>
        The dominant pattern for AI tooling today is a sidebar with a single
        chat thread. It works for short questions; it falls apart the moment the
        problem outgrows one prompt. A Space inverts each weakness:
      </P>
      <Table
        headers={['Chat sidebar', 'Space']}
        rows={[
          [
            'Context window is the last few messages.',
            'Context window is the whole Space — nodes, edges, layout, history.',
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
        A Huabu Space is built out of three layers stacked on top of each other.
        Every feature in the product belongs to one of them:
      </P>
      <Table
        headers={['Layer', 'Purpose', 'Examples']}
        rows={[
          [
            <strong>Surface</strong>,
            'Where work happens — the container and the Space itself.',
            'Home, Space, tools & gestures.',
          ],
          [
            <strong>Units</strong>,
            'What you put on the surface — typed pieces of content.',
            'Available node types include Note, Text, Image, PDF, Video, Web, Frame, Sketch, and Agent.',
          ],
          [
            <strong>Structure & navigation</strong>,
            'How the units relate to each other and how you find them.',
            'Edges, Frames, Layers panel, Chat panel.',
          ],
        ]}
      />
      <Callout tone="info">
        Each section below covers one layer with the same card pattern. The
        cards for Space interactions lead to the unified practical guide.
      </Callout>

      <H2>Layer 1 — The surface</H2>
      <P>
        The surface is the Space plus everything around it: the local folder
        that holds your work, the infinite 2D plane you draw on, and the
        gestures you use to move things around.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={FolderTree}
          eyebrow="Container"
          title="Home"
          description="A local folder you pick once. Holds every Space, attachment, memory and history file. Pick any folder; an empty one is easiest."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={Layout}
          eyebrow="Surface"
          title="Space"
          description="An infinite 2D plane with pan, zoom, marquee select, lasso select and direct manipulation."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={MousePointer2}
          eyebrow="Interaction"
          title="Tools & Gestures"
          description="Select, pan, lasso, multi-select toolbar, alignment, distribution, copy / paste / undo across the Space."
        />
      </CardGrid>

      <H2>Layer 2 — The units</H2>
      <P>
        Nodes are the things you place on the Space. Each type has its own
        editor, its own toolbar, and its own on-disk storage shape, but they
        share the same drag / resize / connect / lock affordances. The ten types
        fall into four loose categories — content, media, structure,
        interactive.
      </P>

      <H3>Content</H3>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.note}
          eyebrow="Content"
          title="Note Node"
          description="Rich Markdown for thoughts, outlines, AI-written prose. Lightbox editor with block-level commands."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.text}
          eyebrow="Content"
          title="Text Node"
          description="Short plain text for titles, labels, captions. Edits in place — no lightbox."
        />
      </CardGrid>

      <H3>Media</H3>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.image}
          eyebrow="Media"
          title="Image Node"
          description="PNG / JPG / GIF / WebP / SVG, auto-fit to source aspect. Drop or paste to create."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.pdf}
          eyebrow="Media"
          title="PDF Node"
          description="Full document with thumbnails, screenshots, text selection. The AI reads extracted text by tool call."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.video}
          eyebrow="Media"
          title="Video Node"
          description="MP4 / WebM / MOV / OGG plus YouTube embeds. Plays inline; expand for the full player."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.web}
          eyebrow="Media"
          title="Web Node"
          description="Captured URL with the article body extracted in the background. Becomes a real, searchable source."
        />
      </CardGrid>

      <H3>Structure</H3>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.frame}
          eyebrow="Structure"
          title="Frame Node"
          description="Labelled group container with free / column / row layout. Auto-reflows as children resize."
        />
      </CardGrid>

      <H3>Interactive</H3>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.sketch}
          eyebrow="Interactive"
          title="Sketch Node"
          description="Freehand strokes you can ask the AI to interpret into real nodes."
        />
        <NavCard
          to="/docs/work-with-ai"
          icon={NODE_ICON.question}
          eyebrow="Interactive"
          title="Agent Node"
          description="A dedicated AI conversation anchored beside the material it concerns."
        />
      </CardGrid>

      <H2>Layer 3 — Structure & navigation</H2>
      <P>
        Nodes alone are confetti. What turns a busy Space into something you can
        read and the AI can use are the structural features — connections
        between nodes, containers that carry layout, and panels that let you
        navigate without panning.
      </P>
      <CardGrid>
        <NavCard
          to="/docs/work-in-a-space"
          icon={Network}
          eyebrow="Relations"
          title="Edges"
          description="Typed connections with direction, colour, dash and weight. Lightweight metadata — they never own content."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={NODE_ICON.frame}
          eyebrow="Containers"
          title="Frames as structure"
          description="A Frame is both a node and a grouping primitive. Naming a Frame names a region; the AI reads frame titles too."
        />
        <NavCard
          to="/docs/work-in-a-space"
          icon={Layers}
          eyebrow="Navigation"
          title="Layers Panel"
          description="A flat, searchable list of every node on the Space — rename, lock, jump-to. The Space's table of contents."
        />
        <NavCard
          to="/docs/work-with-ai"
          icon={MessageSquare}
          eyebrow="Conversation"
          title="Chat Panel"
          description="Persistent threads that always see the Space alongside you. Sends selected nodes as focus automatically."
        />
        <NavCard
          to="/docs/nodes/content"
          icon={FolderTree}
          eyebrow="Under the hood"
          title="Node Content"
          description="How node bodies are ingested into Markdown the AI can read — the bridge between Space and AI context."
        />
      </CardGrid>

      <H2>How the layers compose</H2>
      <P>
        A useful Space is rarely one node type alone. Most of the value comes
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
          order, plus Agent Nodes (Layer 2 ×{' '}
          <DocLink href="/docs/work-with-ai">AI surface</DocLink>) for the
          things still open.
        </li>
        <li>
          <strong>Idea cluster.</strong> Dozens of Text nodes (Layer 2) captured
          fast, then grouped into themed Frames (Layer 3) with help from Agent
          Mode.
        </li>
        <li>
          <strong>Reading session.</strong> Web and PDF nodes (Layer 2),
          highlights as Notes, a Sketch node where you scribbled the structure,
          and an Agent Node asking the AI to interpret it.
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
          Space rewards messy first passes and tightening later.
        </li>
        <li>
          <strong>One surface for everything.</strong> Sources, notes, sketches,
          AI replies, open questions — all on the same plane. There&apos;s no
          separate &quot;chat history&quot; tab to consult.
        </li>
        <li>
          <strong>Your files, your format.</strong> See{' '}
          <DocLink href="/docs/core/open-vault">Open Home</DocLink> — nothing is
          locked inside the app.
        </li>
      </ul>

      <H2>When the Space is the wrong tool</H2>
      <P>
        It&apos;s worth being honest about where Huabu doesn&apos;t earn its
        keep. A Space is overkill for:
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
        for most are covered in{' '}
        <DocLink href="/docs/work-in-a-space">Work in a Space</DocLink>.
      </Callout>
    </PageLayout>
  );
}
