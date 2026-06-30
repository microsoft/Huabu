// TODO: fill in real handbook content for this section.
import { NODE_ICON } from '@/config/nodeIcons';

import {
  Callout,
  CardGrid,
  DocLink,
  H2,
  NavCard,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-nine-types', label: 'The nine node types' },
  { id: 'expand-and-edit', label: 'Expand & edit' },
  { id: 'single-select-toolbar', label: 'Single-select toolbar' },
  { id: 'multi-select-toolbar', label: 'Multi-select toolbar' },
  { id: 'locking', label: 'Locking' },
];

export default function NodesOverview() {
  return (
    <PageLayout
      title="Node Types"
      description="Huabu ships ten node types. Note / Text and the media types (Image / PDF / Office / Video / Web) are pure content. Frame is structure. Sketch and Question are interactive. Each type has its own page — this hub points to them and covers the behaviours every node shares."
      toc={toc}
    >
      <H2>The ten node types</H2>
      <CardGrid>
        <NavCard
          to="/docs/nodes/note"
          icon={NODE_ICON.note}
          eyebrow="Content"
          title="Note"
          description="Rich Markdown for thoughts, outlines, AI-written prose."
        />
        <NavCard
          to="/docs/nodes/text"
          icon={NODE_ICON.text}
          eyebrow="Content"
          title="Text"
          description="Short plain text for titles, labels, captions."
        />
        <NavCard
          to="/docs/nodes/image"
          icon={NODE_ICON.image}
          eyebrow="Media"
          title="Image"
          description="PNG / JPG / GIF / WebP / SVG, auto-fit to source aspect."
        />
        <NavCard
          to="/docs/nodes/pdf"
          icon={NODE_ICON.pdf}
          eyebrow="Media"
          title="PDF"
          description="Full document with thumbnails, screenshots, text selection."
        />
        <NavCard
          to="/docs/nodes/office"
          icon={NODE_ICON.office}
          eyebrow="Media"
          title="Office"
          description="View-only Word / Excel / PowerPoint, text extracted for AI."
        />
        <NavCard
          to="/docs/nodes/video"
          icon={NODE_ICON.video}
          eyebrow="Media"
          title="Video"
          description="MP4 / WebM / MOV / OGG plus YouTube embeds."
        />
        <NavCard
          to="/docs/nodes/web"
          icon={NODE_ICON.web}
          eyebrow="Media"
          title="Web"
          description="Captured URL with the article body extracted in the background."
        />
        <NavCard
          to="/docs/nodes/frames"
          icon={NODE_ICON.frame}
          eyebrow="Structure"
          title="Frame"
          description="Labelled group container with free / column / row layout."
        />
        <NavCard
          to="/docs/nodes/sketch"
          icon={NODE_ICON.sketch}
          eyebrow="Interactive"
          title="Sketch"
          description="Freehand strokes you can ask the AI to interpret."
        />
        <NavCard
          to="/docs/nodes/question"
          icon={NODE_ICON.question}
          eyebrow="Interactive"
          title="Question"
          description="A sticky-note question the AI answers in a connected reply."
        />
      </CardGrid>

      <H2>Expand & edit</H2>
      <P>
        Most nodes open a focused editor or viewer when you double-click them —
        either the right-side lightbox or an in-place editor:
      </P>
      <Table
        headers={['Node', 'Double-click opens']}
        rows={[
          ['Note', 'Right-side lightbox with the Markdown block editor.'],
          ['Text', 'Inline editor — no lightbox; type directly on the node.'],
          ['Image / Video', 'Lightbox with a zoomable viewer / player.'],
          [
            'PDF',
            'Lightbox PDF viewer with page thumbnails, download, and selection mode.',
          ],
          ['Web', 'Lightbox preview of the extracted article body.'],
          [
            'Frame',
            'Title editor and layout-mode picker (free / column / row).',
          ],
          ['Question', 'Opens a chat session in the side panel — no lightbox.'],
          ['Sketch', 'No lightbox; you draw directly on the canvas.'],
        ]}
      />

      <H2>Single-select toolbar</H2>
      <P>
        When a single node is selected, a small floating toolbar appears above
        it. Each per-type page covers its toolbar in detail; the common shape
        is: open / primary actions on the left, type-specific controls in the
        middle, destructive actions on the right.
      </P>

      <H2>Multi-select toolbar</H2>
      <P>
        Selecting two or more nodes brings up a different toolbar with alignment
        (left / centre / right / top / middle / bottom), distribution (spread
        overlapping nodes), and <em>group into Frame</em>
        (also <code>Ctrl/Cmd+G</code>). See{' '}
        <DocLink href="/docs/nodes/frames">Frames</DocLink> for what grouping
        produces.
      </P>

      <H2>Locking</H2>
      <P>
        Lock any node from the Layers panel. Locked nodes can&apos;t be dragged
        or resized — but content remains editable. Locking a frame freezes its
        children too and stops it from auto-resizing.
      </P>
      <Callout tone="info">
        Want more on how node content is stored and retrieved by the AI? See{' '}
        <DocLink href="/docs/nodes/content">Node Content</DocLink>. Or jump to{' '}
        <DocLink href="/docs/nodes/edges">Edges &amp; Connections</DocLink> for
        the relationship layer.
      </Callout>
    </PageLayout>
  );
}
