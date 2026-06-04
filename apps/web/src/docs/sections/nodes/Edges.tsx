// TODO: fill in real handbook content for this section.
import {
  Callout,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'creating-edges', label: 'Creating edges' },
  { id: 'styling-an-edge', label: 'Styling an edge' },
  { id: 'arrow-direction', label: 'Arrow direction' },
  { id: 'editing-and-deleting', label: 'Editing & deleting' },
  { id: 'ai-created-edges', label: 'AI-created edges' },
];

export default function Edges() {
  return (
    <PageLayout
      title="Edges & Connections"
      description="Edges are first-class objects on the canvas. They aren't decoration — the AI reads them as part of the canvas structure, so connecting two nodes is itself an authoring act."
      toc={toc}
    >
      <H2>Creating edges</H2>
      <P>
        Hover any node and connection handles appear on its sides. Drag from a
        handle to another node to create the edge. The connection inherits a
        sensible default style; selecting it brings up a styling toolbar.
      </P>

      <H2>Styling an edge</H2>
      <P>Click an edge to surface a floating toolbar with these controls:</P>
      <Table
        headers={['Control', 'What it does']}
        rows={[
          [
            <strong>Line type</strong>,
            'Switch between straight and curved (bezier).',
          ],
          [<strong>Dash pattern</strong>, 'Solid, dashed or dotted.'],
          [
            <strong>Stroke width</strong>,
            'Five preset widths from thin to thick.',
          ],
          [
            <strong>Colour</strong>,
            'Pick from the accent palette to colour-code relationships (e.g. red for blocking, blue for reference).',
          ],
          [
            <strong>Arrow direction</strong>,
            'None / source / target / both — see below.',
          ],
        ]}
      />

      <H2>Arrow direction</H2>
      <Table
        headers={['Direction', 'Reads as']}
        rows={[
          ['None', 'Symmetric association.'],
          ['Source', 'Reverse pointer (target → source).'],
          ['Target', 'Standard pointer (source → target).'],
          ['Both', 'Bi-directional flow.'],
        ]}
      />

      <H2>Editing & deleting</H2>
      <P>
        Curved edges expose a bezier handle you can drag to reshape the curve.
        Delete the selected edge with the toolbar trash button or with{' '}
        <code>Delete</code> / <code>Backspace</code>.
      </P>

      <H2>AI-created edges</H2>
      <P>
        When the AI runs in Operate mode (or when you accept an Intent
        suggestion), it can create edges as part of its batch of canvas commands
        — and it picks colours and styles that mirror the relationship it&apos;s
        expressing. You see them in the change list before they&apos;re
        committed and can edit or delete them like any other edge.
      </P>
      <Callout tone="info">
        Auto-layout also uses <em>invisible</em> semantic edges (e.g. between a
        Note and its source PDF) to keep related nodes close. Those don&apos;t
        render but they influence layout. See{' '}
        <a
          className="font-medium text-gray-900 underline decoration-gray-400 underline-offset-2 hover:decoration-gray-900"
          href="/docs/concepts/auto-layout"
        >
          Auto-layout
        </a>{' '}
        for the weight table.
      </Callout>
    </PageLayout>
  );
}
