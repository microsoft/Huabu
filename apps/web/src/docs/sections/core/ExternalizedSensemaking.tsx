import {
  Callout,
  DocLink,
  H2,
  H3,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'why-externalize', label: 'Why externalize thinking' },
  { id: 'the-pieces', label: 'The pieces' },
  { id: 'how-they-fit', label: 'How the pieces fit together' },
  { id: 'where-next', label: 'Where to go next' },
];

export default function ExternalizedSensemaking() {
  return (
    <PageLayout
      title="Externalized Sensemaking"
      description="Huabu treats the canvas as an external workspace for your thinking. Instead of holding half-formed ideas in your head, you spread them out as nodes you can read, move, group and revisit — and the AI works on the same surface, not in a separate chat window."
      toc={toc}
    >
      <H2>Why externalize thinking</H2>
      <P>
        Working memory is a few items at a time. Most real problems are larger
        than that — a paper to digest, a spec to design, a decision with five
        moving parts. Huabu&apos;s answer is to give that work a{' '}
        <strong>persistent visual home</strong>:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Fragments stay visible</strong> — every note, quote, sketch,
          link and AI reply lives as a node you can find later.
        </li>
        <li>
          <strong>Structure is spatial</strong> — proximity, grouping and edges
          carry meaning the way arrows on a whiteboard do.
        </li>
        <li>
          <strong>Revision is cheap</strong> — drag, resize, regroup; the canvas
          rewards iteration instead of punishing it.
        </li>
      </ul>

      <H2>The pieces</H2>
      <P>
        The building blocks of a Huabu session map onto familiar concepts from
        any visual workspace:
      </P>
      <Table
        headers={['Piece', 'What it is', 'Reference']}
        rows={[
          [
            <strong>Workspace</strong>,
            'A local folder you pick once. Holds every canvas, attachment, memory and history file.',
            <DocLink href="/docs/concepts/workspaces">
              Workspaces &amp; Canvases
            </DocLink>,
          ],
          [
            <strong>Canvas</strong>,
            'One infinite 2D surface inside a workspace. Pan, zoom and drop things anywhere.',
            <DocLink href="/docs/concepts/canvas-basics">
              Canvas Basics
            </DocLink>,
          ],
          [
            <strong>Nodes</strong>,
            'Nine typed containers — Note, Text, Image, PDF, Video, Web, Frame, Sketch, Question.',
            <DocLink href="/docs/nodes/overview">Nodes</DocLink>,
          ],
          [
            <strong>Edges</strong>,
            'Typed connections that carry direction, colour and style.',
            <DocLink href="/docs/nodes/edges">Edges &amp; Connections</DocLink>,
          ],
          [
            <strong>Layers panel</strong>,
            'A flat list of every node on the canvas — rename, lock, jump-to.',
            <DocLink href="/docs/concepts/layers-panel">Layers Panel</DocLink>,
          ],
          [
            <strong>Chat panel</strong>,
            'A persistent chat thread that always sees the canvas alongside you.',
            <DocLink href="/docs/concepts/chat-panel">Chat Panel</DocLink>,
          ],
        ]}
      />

      <H2>How the pieces fit together</H2>
      <H3>One workspace = one folder</H3>
      <P>
        Everything starts with a folder on your disk. Huabu treats that folder
        as the canonical store, so nothing about your project is locked inside
        the app — back it up, sync it, version-control it, edit a note in any
        text editor, all transparent.
      </P>

      <H3>One canvas = one problem</H3>
      <P>
        A canvas is your unit of work. A literature review, a product brief, a
        debugging session — anything where you want the same set of inputs and
        artefacts within arm&apos;s reach. Canvases stay open in the canvas list
        so you can jump between in-flight problems.
      </P>

      <H3>Nodes carry the content; edges carry the structure</H3>
      <P>
        Each node has a body that&apos;s a real file (Markdown for notes, binary
        plus extracted text for media). Edges are lightweight metadata — they
        connect nodes but never own content. Together they form a graph the AI
        can read as easily as you can.
      </P>

      <Callout tone="tip">
        The canvas isn&apos;t a presentation tool. It&apos;s closer to a
        long-lived workbench — messy in the middle, tidy at the edges, always
        editable.
      </Callout>

      <H2>Where to go next</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          See how the same surface becomes an{' '}
          <DocLink href="/docs/core/agentic-canvas">agentic canvas</DocLink> the
          moment you start chatting.
        </li>
        <li>
          Or jump straight into{' '}
          <DocLink href="/docs/quickstart">Quick Start</DocLink> to build your
          first canvas in four steps.
        </li>
      </ul>
    </PageLayout>
  );
}
