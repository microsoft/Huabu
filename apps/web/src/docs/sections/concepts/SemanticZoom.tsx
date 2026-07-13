import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-it-is', label: 'What Semantic Zoom does' },
  { id: 'why', label: 'Why it exists' },
  { id: 'thresholds', label: 'When nodes switch' },
  { id: 'typography', label: 'Font size follows node size' },
  { id: 'which-nodes', label: 'Which nodes participate' },
  { id: 'hysteresis', label: 'No flicker — the hysteresis buffer' },
  { id: 'interaction', label: 'Interacting with minimal nodes' },
];

export default function SemanticZoom() {
  return (
    <PageLayout
      title="Semantic Zoom"
      description="As you zoom out, heavy nodes — Notes, PDFs, web articles — automatically collapse to a lightweight title placeholder. Zoom back in and they re-render in full. The canvas stays fast and the overview stays readable, even with hundreds of nodes."
      toc={toc}
    >
      <H2>What Semantic Zoom does</H2>
      <P>
        Most nodes render at the same fidelity regardless of zoom level. That
        works for small canvases. Once you have a few dozen Notes, PDFs and web
        pages on the same surface, rendering all of them in full at every zoom
        level becomes both visually noisy (you can&apos;t read any of it) and
        computationally expensive.
      </P>
      <P>
        Semantic Zoom is the canvas&apos;s answer: each heavy node has two
        render modes, and the canvas picks one based on how big the node is on
        your screen.
      </P>

      <H2>Why it exists</H2>
      <Table
        headers={['Without Semantic Zoom', 'With Semantic Zoom']}
        rows={[
          [
            'A zoomed-out canvas is a wall of tiny illegible text.',
            'Zoomed-out nodes show their title — instantly scannable.',
          ],
          [
            'Performance degrades with every heavy node you add.',
            'Zoomed-out nodes defer expensive hydration and preview requests.',
          ],
          [
            'You have to zoom in to recognise what a node is.',
            'The node title stays visible at every zoom level.',
          ],
        ]}
      />

      <H2>When nodes switch</H2>
      <P>
        Each node is measured by its <strong>on-screen width in pixels</strong>{' '}
        — not by zoom percentage. That way the rule is the same whether you zoom
        out from a large node or shrink a node on a tight zoom. The default
        threshold is:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>&gt; 150 px wide on screen</strong> → render <Code>full</Code>{' '}
          (the normal component).
        </li>
        <li>
          <strong>≤ 150 px wide on screen</strong> → render <Code>minimal</Code>{' '}
          (a tier-sized title placeholder).
        </li>
      </ul>

      <H2>Font size follows node size</H2>
      <P>
        A minimal node&apos;s title font is chosen from a small set of{' '}
        <strong>discrete tiers keyed on the node&apos;s size</strong> — never on
        how long the title is. Two nodes of the same size always render at the
        same font size, so a zoomed-out canvas keeps a steady typographic rhythm
        instead of scattering a 40&nbsp;px title next to an 11&nbsp;px one.
        Bigger nodes get a bigger font, which lets more important content stand
        out at a glance. Because the tier font is a canvas size, the label
        simply scales down with the node as you zoom out — a smaller node always
        shows smaller text, with no separate icon or floor.
      </P>
      <P>
        Titles that don&apos;t fit <strong>wrap at word boundaries</strong>{' '}
        (never mid-word) and then ellipsize; the font is never shrunk to squeeze
        the text in. Taller nodes allow more lines before the title is
        truncated.
      </P>

      <H2>Which nodes participate</H2>
      <P>
        Only the three heaviest types swap render modes. Everything else stays
        at full fidelity at every zoom level because the savings aren&apos;t
        worth the visual cost.
      </P>
      <Table
        headers={['Node type', 'Has a minimal mode?']}
        rows={[
          [<DocLink href="/docs/nodes/note">Note</DocLink>, 'Yes'],
          [<DocLink href="/docs/nodes/pdf">PDF</DocLink>, 'Yes'],
          [<DocLink href="/docs/nodes/web">Web</DocLink>, 'Yes'],
          [
            <DocLink href="/docs/nodes/text">Text</DocLink>,
            'No — already lightweight',
          ],
          [
            <DocLink href="/docs/nodes/image">Image</DocLink>,
            'No — natively cheap to render',
          ],
          [
            <DocLink href="/docs/nodes/video">Video</DocLink>,
            'No — controls always visible',
          ],
          [
            <DocLink href="/docs/nodes/frames">Frame</DocLink>,
            'No — the container itself is light',
          ],
          [
            <DocLink href="/docs/nodes/sketch">Sketch</DocLink>,
            'No — strokes scale natively',
          ],
          [
            <DocLink href="/docs/nodes/question">Question</DocLink>,
            'No — small by design',
          ],
        ]}
      />

      <H2>No flicker — the hysteresis buffer</H2>
      <P>
        A naive threshold would flip nodes between full and minimal every time
        the screen width crossed 150&nbsp;px during a zoom gesture. Semantic
        Zoom adds a small <strong>hysteresis buffer</strong> (10 px) so the
        switch is sticky: a node has to drop well below 150&nbsp;px to collapse,
        and grow well past it to expand again. The result is a clean snap at one
        zoom level, not a strobe.
      </P>
      <Callout tone="info">
        Hysteresis only affects when the switch happens, not what it switches
        to. The minimal and full renders themselves are the same regardless of
        how you reached them.
      </Callout>

      <H2>Interacting with minimal nodes</H2>
      <P>
        Minimal nodes are still real, interactive nodes — selection, dragging,
        multi-select, the Layers panel, edges, all of it works. What changes is
        only the body. To edit a minimal node, either:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Zoom in (scroll wheel, pinch, or <em>Fit to selection</em>) until it
          crosses back into full mode, or
        </li>
        <li>
          Double-click — opening the lightbox is independent of zoom, so a
          minimal Note still opens its full Markdown editor.
        </li>
      </ul>
    </PageLayout>
  );
}
