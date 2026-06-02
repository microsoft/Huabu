// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  H3,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'tools', label: 'Selection & pan tools' },
  { id: 'node-creators', label: 'Node creators' },
  { id: 'upload-and-links', label: 'Upload & links' },
  { id: 'layout-and-intent', label: 'Layout & intent' },
  { id: 'selecting', label: 'Selecting & multi-select' },
  { id: 'creating-nodes', label: 'Creating nodes' },
  { id: 'moving-and-z-order', label: 'Moving & z-order' },
  { id: 'edges', label: 'Edges' },
  { id: 'copy-paste-undo', label: 'Copy / paste / undo' },
  { id: 'floating-controls', label: 'Floating top-right controls' },
];

export default function CanvasBasics() {
  return (
    <PageLayout
      title="Canvas Basics"
      description="The canvas is Huabu's main work surface — an infinite 2D plane with pan, zoom and direct manipulation. This page covers the moves that apply across all node types."
      toc={toc}
    >
      <H2>Selection & pan tools</H2>
      <P>The first dropdown in the top toolbar holds three modes:</P>
      <Table
        headers={['Tool', 'What it does']}
        rows={[
          [
            <strong>Select</strong>,
            'Default mode — click to select, drag in empty space to marquee, drag nodes to move them.',
          ],
          [
            <strong>Pan</strong>,
            'Drag anywhere to pan the viewport without selecting.',
          ],
          [
            <strong>Lasso</strong>,
            'Draw a freehand loop to select every node inside the path. Useful when nodes are arranged irregularly and a rectangle is too coarse.',
          ],
        ]}
      />
      <P>
        Hold <Kbd>Space</Kbd> to temporarily switch to Pan mode (release to go
        back). Middle-mouse drag also pans without changing tools.
      </P>

      <H2>Node creators</H2>
      <P>
        The second toolbar group has one button per creatable node type. Click
        the button to activate the tool, then click on the canvas to drop the
        node. <Kbd>Esc</Kbd> (or clicking the button again) cancels.
      </P>
      <Table
        headers={['Button', 'Node', 'Notes']}
        rows={[
          [
            <strong>Frame</strong>,
            'Group rectangle',
            'Drag a rectangle on the canvas instead of clicking once.',
          ],
          [
            <strong>Note</strong>,
            'Markdown note',
            'Click an empty spot to place an empty Note.',
          ],
          [
            <strong>Text</strong>,
            'Text block',
            'Click to place; type to fill, edits in place.',
          ],
          [
            <strong>Sketch</strong>,
            'Freehand strokes',
            'Drag to draw; pen colour and size live in the toolbar.',
          ],
          [
            <strong>Question</strong>,
            'AI-answered question',
            'Click to place a sticky-note-style question that the AI replies to.',
          ],
        ]}
      />

      <H2>Upload & links</H2>
      <P>The third group handles bulk content:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Upload</strong> — multi-file picker for images (PNG / JPG /
          GIF / WebP / SVG), PDFs and videos (MP4 / WebM / MOV / OGG). You can
          also drop files directly onto the canvas.
        </li>
        <li>
          <strong>Add link</strong> — paste one URL per line; Huabu detects each
          as image / PDF / web page / YouTube and creates the right node. Submit
          with <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Enter</Kbd>.
        </li>
      </ul>

      <H2>Layout & intent</H2>
      <P>The last group has two AI-adjacent actions:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Auto-layout toggle</strong> (<Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
          <Kbd>Shift</Kbd>+<Kbd>A</Kbd>) — when on, every new node slots in
          beside related content; frames grow / shrink to fit their children.
          See <DocLink href="/docs/ai/intent">Intent &amp; Auto-layout</DocLink>
          .
        </li>
        <li>
          <strong>Intent</strong> (<Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd>)
          — pops up 3–5 AI-suggested next moves you can run with one click.
        </li>
      </ul>

      <H2>Selecting & multi-select</H2>
      <Table
        headers={['Action', 'How']}
        rows={[
          ['Single select', 'Click the node.'],
          [
            'Add to selection',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+click the node.
            </>,
          ],
          ['Rectangle select', 'Drag in empty space (Select tool).'],
          ['Lasso select', 'Draw a freehand loop (Lasso tool).'],
          ['Deselect', 'Click empty canvas.'],
        ]}
      />
      <P>
        With multiple nodes selected, a floating multi-select toolbar appears
        with alignment (left / centre / right / top / middle / bottom),
        distribution, and <em>group into Frame</em> (also <Kbd>Ctrl</Kbd>/
        <Kbd>Cmd</Kbd>+<Kbd>G</Kbd>).
      </P>

      <H2>Creating nodes</H2>
      <Table
        headers={['Method', 'Result']}
        rows={[
          ['Toolbar button + click', 'Place the chosen node type.'],
          ['Drag a file from your OS', 'Create the matching media node type.'],
          [
            <>
              Paste with <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>V</Kbd>
            </>,
            'Images, PDFs and videos paste as their node type.',
          ],
          [
            'Paste one or more URLs',
            'Auto-detected as image / PDF / web page / YouTube nodes.',
          ],
          ['Paste plain text', 'Becomes a Note node.'],
          [
            'Drag from chat',
            'Drag a message snippet from the chat panel onto the canvas.',
          ],
          [
            'Drag a block out of a Note',
            'Lift a single block out of an open Note editor to make a new node.',
          ],
          [
            'PDF selection',
            'In the PDF viewer, drag a selection out as a Note (text) or Image (screenshot).',
          ],
          [
            'AI auto-create',
            'Operate, Intent and Question nodes all create nodes for you.',
          ],
        ]}
      />

      <H2>Moving & z-order</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Move</strong> — drag any node; multi-selection moves together.
        </li>
        <li>
          <strong>Send to back / bring to front</strong> — press <Kbd>[</Kbd> /{' '}
          <Kbd>]</Kbd>.
        </li>
        <li>
          <strong>
            Hold <Kbd>Alt</Kbd>
          </strong>{' '}
          while dragging or resizing to temporarily disable smart guides and
          snapping.
        </li>
        <li>
          The <DocLink href="/docs/concepts/layers-panel">Layers panel</DocLink>{' '}
          (left side) shows the full hierarchy and lets you re-parent, lock,
          rename, or filter nodes.
        </li>
      </ul>

      <H3>Locking</H3>
      <P>
        Hover any row in the Layers panel for a lock toggle. Locked nodes
        can&apos;t be dragged or resized and are treated as fixed points by
        auto-layout — but their content remains editable.
      </P>

      <H2>Edges</H2>
      <P>
        Edges express relationships between nodes. Drag from a connection handle
        on a node&apos;s edge to another node to create one. Selecting an edge
        surfaces a styling toolbar with line type, dash, weight, arrow direction
        and colour — see{' '}
        <DocLink href="/docs/nodes/edges">Edges &amp; Connections</DocLink>.
      </P>

      <H2>Copy / paste / undo</H2>
      <Table
        headers={['Action', 'Shortcut']}
        rows={[
          [
            'Copy',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>C</Kbd>
            </>,
          ],
          [
            'Paste',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>V</Kbd>
            </>,
          ],
          [
            'Delete',
            <>
              <Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd>
            </>,
          ],
          [
            'Undo',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Z</Kbd>
            </>,
          ],
          [
            'Redo',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd>
            </>,
          ],
        ]}
      />
      <P>
        Paste drops content at the cursor position. Nearly every canvas
        operation is undoable; bulk AI edits in Operate mode come with their own
        batch-undo via the change list — see{' '}
        <DocLink href="/docs/ai/overview">Ask &amp; Operate</DocLink>.
      </P>

      <H2>Floating top-right controls</H2>
      <P>A small floating row sits in the top-right of every canvas:</P>
      <Table
        headers={['Button', 'What it does']}
        rows={[
          [
            <strong>Keyboard shortcuts</strong>,
            'Opens the shortcut reference modal (also opens with ?).',
          ],
          [
            <strong>Handbook</strong>,
            'Opens this handbook in a new browser tab without disturbing the canvas.',
          ],
          [
            <strong>Settings</strong>,
            'Opens the global settings popover (LLM, providers, external agents).',
          ],
          [
            <strong>Chat toggle</strong>,
            'Collapses or expands the chat panel on the right.',
          ],
        ]}
      />
      <Callout tone="info">
        The left{' '}
        <DocLink href="/docs/concepts/layers-panel">Layers panel</DocLink> and
        the right Chat panel are both collapsible. The two panels and the
        floating controls together make up the main canvas chrome.
      </Callout>
    </PageLayout>
  );
}
