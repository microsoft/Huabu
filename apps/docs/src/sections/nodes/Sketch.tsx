// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-sketch-is-for', label: 'What sketch is for' },
  { id: 'drawing', label: 'Drawing' },
  { id: 'apply-sketch', label: 'Apply Sketch (AI interpret)' },
  { id: 'merging-clusters', label: 'Merging similar suggestions' },
  { id: 'tips', label: 'Tips' },
];

export default function Sketch() {
  return (
    <PageLayout
      title="Sketch"
      description="Sketch is a freehand drawing tool. The strokes themselves are an annotation, but you can also ask the AI to look at what you drew and turn it into real nodes — boxes, arrows, labels, an outline."
      toc={toc}
    >
      <H2>What sketch is for</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Annotate</strong> — circle a region, draw an arrow, scribble a
          question mark next to something.
        </li>
        <li>
          <strong>Plan</strong> — rough out a diagram or a layout before
          building it with proper nodes.
        </li>
        <li>
          <strong>Talk to the AI visually</strong> — &quot;Apply&quot; a sketch
          and the AI interprets it as structure (e.g. three boxes connected by
          arrows become three nodes with edges).
        </li>
      </ul>

      <H2>Drawing</H2>
      <P>
        Activate the Sketch tool from the Space toolbar, then drag on the Space
        to draw a stroke. Each click-drag adds a new stroke to the current
        Sketch node; release and draw again to keep adding. The toolbar carries
        swatches for the pen colour and a slider for the stroke width.
      </P>
      <P>
        Sketch nodes are resizable like any other node — strokes scale
        proportionally — and can live inside a frame, be locked from the Layers
        panel, or be selected together with other nodes.
      </P>

      <H2>Apply Sketch (AI interpret)</H2>
      <P>
        Select a Sketch node and click <strong>Apply Sketch</strong> in its
        toolbar (or trigger Intent on the selection). Huabu sends the strokes
        plus the surrounding spatial context to the AI, which proposes a
        structured interpretation: real nodes, edges, frames, labels.
      </P>
      <P>The proposed changes appear as a preview overlay. You can:</P>
      <Table
        headers={['Action', 'What it does']}
        rows={[
          ['Accept', 'Apply the proposed nodes and edges to the Space.'],
          ['Revert', 'Discard the suggestion and keep the sketch as-is.'],
          [
            'Edit then accept',
            'Adjust labels or positions before committing — the AI&apos;s output is just a starting point.',
          ],
        ]}
      />

      <H2>Merging similar suggestions</H2>
      <P>
        When the AI returns several candidate interpretations that look similar
        (e.g. two clusterings of the same dots), the processing overlay groups
        them as clusters. Pick the cluster you like and accept it — or accept
        multiple clusters whose outputs don&apos;t overlap. This keeps you in
        control when the AI is uncertain rather than forcing one interpretation.
      </P>

      <H2>Tips</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Draw deliberately: clear shapes (rectangles, arrows, labels) are
          interpreted more reliably than scribbles.
        </li>
        <li>
          Place the Sketch <em>over</em> the area it refers to so the AI sees
          both the marks and the underlying nodes.
        </li>
        <li>
          Use sketches alongside the{' '}
          <DocLink href="/docs/ai/intent">Intent</DocLink> popover — &quot;Apply
          Sketch&quot; and Intent share the same suggestion machinery.
        </li>
      </ul>
      <Callout tone="tip">
        Press <Kbd>Esc</Kbd> after triggering Apply Sketch to dismiss the
        overlay without committing — the strokes stay on the Space.
      </Callout>
    </PageLayout>
  );
}
