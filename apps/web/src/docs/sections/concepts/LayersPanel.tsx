// TODO: fill in real handbook content for this section.
import {
  Callout,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'whats-in-it', label: "What's in the panel" },
  { id: 'search-and-filter', label: 'Search & type filter' },
  { id: 'drag-to-reparent', label: 'Drag to re-parent' },
  { id: 'rename-and-lock', label: 'Rename & lock' },
  { id: 'collapsing-frames', label: 'Collapsing frames' },
  { id: 'question-status', label: 'Question status badges' },
];

export default function LayersPanel() {
  return (
    <PageLayout
      title="Layers Panel"
      description="The collapsible panel on the left of every canvas — a tree view of every node and frame, plus tools to search, re-parent, lock, and rename them."
      toc={toc}
    >
      <H2>What&apos;s in the panel</H2>
      <P>
        The Layers panel mirrors your canvas as a hierarchical list: top-level
        nodes at the root, nested children inside their parent frames. Selecting
        a row selects the node on the canvas (and vice versa), so the panel
        doubles as both a navigator and a structural map.
      </P>

      <H2>Search & type filter</H2>
      <P>
        Use the search input at the top to find a node by title (case
        insensitive). Type-filter chips narrow the tree to specific node types —
        show only PDFs, or only Questions, etc. When a filter is active,
        drag-to-reorder is disabled so the displayed order can&apos;t introduce
        surprising z-order changes.
      </P>

      <H2>Drag to re-parent</H2>
      <P>
        Drag any row onto another to re-parent it (or into the empty space at
        the top to move it back to the root). Re-parenting also moves the node
        on the canvas — frames carry their children, and dragging out of a frame
        removes the parent link.
      </P>

      <H2>Rename & lock</H2>
      <Table
        headers={['Action', 'How']}
        rows={[
          ['Rename', 'Double-click the row, type a new title, press Enter.'],
          ['Lock / unlock', 'Hover the row to reveal the lock toggle.'],
        ]}
      />
      <P>
        Locked nodes can&apos;t be dragged or resized on the canvas. Locked
        frames freeze their children too and stop auto-resizing. Locked nodes
        can still be edited and deleted.
      </P>

      <H2>Collapsing frames</H2>
      <P>
        Frames have an expand/collapse chevron. Collapsing hides their children
        in the panel but doesn&apos;t change anything on the canvas — useful for
        taming long lists. Search results respect the collapsed state, so you
        can fold sections you&apos;re not looking at.
      </P>

      <H2>Question status badges</H2>
      <P>
        Question nodes show a small status dot next to their label so you can
        see at a glance which questions are still pending and which already have
        answers.
      </P>
      <Callout tone="tip">
        Pair the Layers panel with multi-select on the canvas: <Kbd>Cmd</Kbd>+
        click rows to multi-select, then act in bulk (group into a frame, align,
        delete).
      </Callout>
    </PageLayout>
  );
}
