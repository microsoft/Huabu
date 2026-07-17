// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Callout,
  DocImage,
  H2,
  H3,
  P,
  PageLayout,
  Shortcut,
  Table,
  type TocEntry,
} from '../../components';
import { NODE_ICON } from '../../config/nodeIcons';

const toc: TocEntry[] = [
  { id: 'understand-the-space', label: 'Understand the Space' },
  { id: 'navigate-and-select', label: 'Navigate and select' },
  { id: 'drag-content-into-the-space', label: 'Drag content into the Space' },
  { id: 'use-the-toolbar', label: 'Use the toolbar' },
  { id: 'choose-the-right-node', label: 'Choose the right node' },
  { id: 'build-structure', label: 'Build structure' },
  { id: 'open-view-and-edit', label: 'Open, view, and edit' },
  { id: 'everyday-operations', label: 'Everyday operations' },
];

const iconClassName = 'inline-block size-[1em] align-[-0.15em]';

export default function WorkInASpace() {
  return (
    <PageLayout
      title="Work in a Space"
      description="Create, arrange, connect, and inspect the materials and ideas in a Huabu Space."
      toc={toc}
    >
      <H2>Understand the Space</H2>
      <P>
        A <strong>Space</strong> is an infinite two-dimensional work surface for
        one topic, question, or project. Everything on it is built from three
        elements: <strong>nodes</strong> hold material or ideas,{' '}
        <strong>edges</strong> express relationships, and{' '}
        <strong>Frames</strong> group related nodes into named regions.
      </P>
      <P>
        Position is useful too: keep related material close, separate competing
        directions, and use Frames and labelled edges when a relationship should
        be explicit.
      </P>

      <H2>Navigate and select</H2>
      <Table
        headers={['Action', 'How']}
        rows={[
          [
            'Select',
            'Use the Select tool, then click a node. Click empty space to clear the selection.',
          ],
          [
            'Select several nodes',
            <>
              Hold <Shortcut combo="mod" /> while clicking nodes, drag a
              rectangle in empty space, or draw around them with Lasso.
            </>,
          ],
          [
            'Move',
            'Drag a node. If several nodes are selected, they move together.',
          ],
          [
            'Pan',
            <>
              Scroll the mouse wheel, use the Pan tool, or hold{' '}
              <Shortcut combo="Space" /> temporarily while dragging the Space.
            </>,
          ],
          [
            'Zoom',
            'Press Ctrl/Cmd+Plus to zoom in or Ctrl/Cmd+Minus to zoom out. You can also use a trackpad pinch gesture.',
          ],
        ]}
      />
      <Callout tone="tip">
        When dragging a node across a Frame, hold <Shortcut combo="Space" /> to
        move it without adding it to or removing it from that Frame.
      </Callout>

      <H2>Drag content into the Space</H2>
      <P>
        Content can flow directly from your computer and other sources into the
        Space and your writing. Drop a local file or a useful block or excerpt
        onto empty space to make it a node. You can also drop extracted content
        into a Note to continue working with it there. Huabu preserves the
        appropriate format, so you do not need to import, copy, create a
        destination, and paste in separate steps.
      </P>
      <DocImage
        src="/docs/work-in-a-space/chat-to-space.svg"
        alt="A highlighted excerpt from one reply in a Chat session being dragged into a dotted Space, where the same excerpt becomes a new independent material node"
        caption="Select a useful excerpt from a reply and drag that block into the Space. The excerpt becomes its own node, ready to arrange and connect with the rest of your work."
        className="mx-auto max-w-4xl"
      />
      <Table
        headers={['Drag from', 'Drop on empty space', 'Drop into a Note']}
        rows={[
          [
            'A local file',
            'Creates the matching Image, PDF, Video, or Web node and uploads the file.',
            'Not supported.',
          ],
          [
            'A Chat reply',
            'Creates a Note from a text block or an Image from an image block.',
            'Appends the block, or inserts it at the indicator when the Note is expanded.',
          ],
          [
            'A PDF selection',
            'Creates a Note from selected text or an Image from a captured area.',
            'Appends the text or image to the Note.',
          ],
          [
            'A Note block',
            'Moves the block into a new Note.',
            'Moves the block to the end of the other Note.',
          ],
        ]}
      />
      <P>
        Only one content node can be expanded at a time. A selection dragged
        from an expanded PDF or Note therefore lands on the target Note in the
        Space and is appended to its end. When the target Note itself is
        expanded, content available from Chat can follow the insertion indicator
        between existing blocks, and its own blocks can be reordered.
      </P>
      <Callout tone="tip">
        Dragging from Chat or a PDF always copies the source. When dragging a
        Note block, the default is move; hold <strong>Option</strong> on macOS
        or <strong>Ctrl</strong> on Windows / Linux while dragging to copy it
        instead.
      </Callout>

      <H2>Use the toolbar</H2>
      <P>
        The toolbar is the main place to choose how you interact with the Space
        and what you want to add. Select a creation tool, then click or drag in
        the Space to place the new node. Press <Shortcut combo="Esc" /> to
        cancel a placement tool.
      </P>
      <Table
        headers={['Group', 'Tools', 'What they do']}
        rows={[
          [
            'Navigate',
            'Select (S), Pan (P), Lasso (L)',
            'Select and move nodes, move the viewport, or draw a freehand selection.',
          ],
          [
            'Create',
            'Note (1), Text (2), Frame (3), Sketch (4)',
            'Create your own writing, labels, groups, and drawings.',
          ],
          [
            'Import',
            'Upload Files, Add Links',
            'Bring images, PDFs, videos, HTML files, and web links into the Space.',
          ],
          [
            'AI',
            'Agent (A)',
            'Place an Agent node and start an AI conversation beside the relevant material.',
          ],
        ]}
      />
      <P>
        You can also drag files from your computer onto the Space, paste files,
        URLs, images, or text, and copy existing nodes. Huabu creates the
        matching node type and places it near the pointer.
      </P>

      <H2>Choose the right node</H2>
      <Table
        headers={['Node', 'Use it for']}
        rows={[
          [
            <>
              <NODE_ICON.note aria-hidden className={iconClassName} />{' '}
              <strong>Note</strong>
            </>,
            'Ideas, prose, outlines, lists, quotes, code, and other structured Markdown content.',
          ],
          [
            <>
              <NODE_ICON.text aria-hidden className={iconClassName} />{' '}
              <strong>Text</strong>
            </>,
            'Short titles, labels, captions, and visual annotations.',
          ],
          [
            <>
              <NODE_ICON.image aria-hidden className={iconClassName} />{' '}
              <strong>Image</strong>
            </>,
            'Images, diagrams, and screenshots.',
          ],
          [
            <>
              <NODE_ICON.pdf aria-hidden className={iconClassName} />{' '}
              <strong>PDF</strong>
            </>,
            'Reading a complete document and extracting text or regions from it.',
          ],
          [
            <>
              <NODE_ICON.video aria-hidden className={iconClassName} />{' '}
              <strong>Video</strong>
            </>,
            'Local videos and supported video links.',
          ],
          [
            <>
              <NODE_ICON.web aria-hidden className={iconClassName} />{' '}
              <strong>Web</strong>
            </>,
            'Web pages and extracted article content.',
          ],
          [
            <>
              <NODE_ICON.frame aria-hidden className={iconClassName} />{' '}
              <strong>Frame</strong>
            </>,
            'A named group or region that contains and arranges other nodes.',
          ],
          [
            <>
              <NODE_ICON.sketch aria-hidden className={iconClassName} />{' '}
              <strong>Sketch</strong>
            </>,
            'Freehand diagrams, marks, and visual thinking.',
          ],
          [
            <>
              <NODE_ICON.question aria-hidden className={iconClassName} />{' '}
              <strong>Agent</strong>
            </>,
            'An AI conversation placed beside the material it concerns.',
          ],
        ]}
      />

      <H3>Text or Note?</H3>
      <Table
        headers={['', 'Text', 'Note']}
        rows={[
          [
            'Best for',
            'Titles, labels, short captions',
            'Ideas and longer writing',
          ],
          [
            'Content',
            'A short plain-text string',
            'Rich text stored as Markdown',
          ],
          [
            'Editing',
            'Directly in the Space',
            'In the node or expanded editor',
          ],
          [
            'Formatting',
            'Typography and colour',
            'Headings, lists, quotes, code, links, and more',
          ],
        ]}
      />
      <Callout tone="info">
        A simple rule: use <strong>Text</strong> to label the Space; use a{' '}
        <strong>Note</strong> to develop an idea.
      </Callout>

      <H2>Build structure</H2>
      <H3>Group related work with Frames</H3>
      <P>
        A Frame is more than a rectangle: it gives a group a name and keeps its
        contents together. Use one for a topic, project stage, chapter, source
        collection, or intended output. Drag nodes into or out of a Frame, or
        select several nodes and press <Shortcut combo="mod+g" /> to group them.
      </P>
      <P>
        A Frame can keep its children in a free arrangement or lay them out in a
        row or column. Moving the Frame moves its contents, while moving nodes
        inside it changes their local arrangement.
      </P>

      <H3>Create a connected Note or Agent node</H3>
      <P>
        Select a node to reveal arrows above, below, left, and right. Choose an
        arrow, then choose <strong>Note</strong> or <strong>Agent</strong>.
        Huabu places the new node on that side, avoids nearby content when
        possible, and connects it to the original node automatically.
      </P>
      <DocImage
        src="/docs/work-in-a-space/quick-create-arrows-full.png"
        alt="A selected Note with directional arrows and the connected-node menu open beside the right arrow"
        caption="Select a directional arrow, then choose Note or Agent to create and connect a new node on that side."
        className="mx-auto max-w-3xl"
      />

      <H3>Connect existing nodes</H3>
      <P>
        Hover or select a node to reveal its small connection points. Drag from
        one point to another node to create an edge. Select the edge to add a
        label or change its direction. Use an edge when the relationship should
        remain explicit even after the nodes move.
      </P>

      <H2>Open, view, and edit</H2>
      <P>
        Double-click a content node to expand it. The expanded panel can stay
        beside the Space in <strong>Split View</strong>, or switch to{' '}
        <strong>Full View</strong> when you want more room to read or edit.
        Close the panel to return to the same place in the Space.
      </P>

      <H3>Work with a Note</H3>
      <P>
        A Note supports headings, lists, tasks, quotes, code, tables, links, and
        other rich content. Expand it for the full editor; switch between rich
        text and raw Markdown when needed. Drag blocks out to organize them as
        separate Notes, or move them to the end of another Note in the Space.
        When this Note is expanded, you can also place content dragged from Chat
        at the insertion indicator.
      </P>

      <H3>Work with a PDF</H3>
      <P>
        Expand a PDF to read the full document with page thumbnails. Highlight
        text to drag it out as a Note, or select an area to drag it out as an
        Image. Drop either one on empty space to create a node or into a Note to
        add it to your writing. You can also send a capture to Chat, keeping the
        extracted idea close to its source.
      </P>

      <H2>Everyday operations</H2>
      <Table
        headers={['Action', 'How']}
        rows={[
          [
            'Copy and paste',
            <>
              <Shortcut combo="mod+c" /> and <Shortcut combo="mod+v" />
            </>,
          ],
          [
            'Delete',
            <>
              Select nodes or edges, then press <Shortcut combo="Delete" /> or{' '}
              <Shortcut combo="Backspace" />.
            </>,
          ],
          [
            'Undo and redo',
            <>
              <Shortcut combo="mod+z" /> and <Shortcut combo="mod+shift+z" />
            </>,
          ],
          [
            'Align and distribute',
            'Select several nodes, then use the floating toolbar to align their edges or centres and spread them evenly.',
          ],
          [
            'Resize',
            'Select a node and drag its resize handles. Available handles depend on the node type.',
          ],
        ]}
      />
      <Callout tone="tip">
        Start simple: add a source, write a Note beside it, and group related
        work in a Frame. Add edges only when a relationship needs to be stated
        explicitly.
      </Callout>
    </PageLayout>
  );
}
