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
  { id: 'editing', label: 'Editing' },
  { id: 'layout', label: 'Layout' },
  { id: 'order-and-grouping', label: 'Layering & grouping' },
  { id: 'ai', label: 'AI' },
  { id: 'help-modals', label: 'Help' },
  { id: 'paste-behaviour', label: 'Paste behaviour' },
];

export default function Shortcuts() {
  return (
    <PageLayout
      title="Keyboard Shortcuts"
      description={
        <>
          <Kbd>Ctrl</Kbd> on Windows / Linux, <Kbd>Cmd</Kbd> (⌘) on macOS — the
          tables below write it as <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>. Press{' '}
          <Kbd>?</Kbd> on any canvas to view the same list in-app.
        </>
      }
      toc={toc}
    >
      <H2>Editing</H2>
      <Table
        headers={['Shortcut', 'Action']}
        rows={[
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Z</Kbd>
            </>,
            'Undo',
          ],
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd>
            </>,
            'Redo',
          ],
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>C</Kbd>
            </>,
            'Copy selected nodes',
          ],
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>V</Kbd>
            </>,
            'Paste nodes / files / URLs / text',
          ],
          [
            <>
              <Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd>
            </>,
            'Delete selected nodes or edges',
          ],
        ]}
      />

      <H2>Layout</H2>
      <Table
        headers={['Shortcut', 'Action']}
        rows={[
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Shift</Kbd>+<Kbd>L</Kbd>
            </>,
            'Run auto-layout on all nodes',
          ],
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>Shift</Kbd>+<Kbd>A</Kbd>
            </>,
            'Toggle incremental auto-layout',
          ],
          [
            <>
              <Kbd>Space</Kbd> (hold)
            </>,
            'Temporary pan tool',
          ],
        ]}
      />

      <H2>Layering & grouping</H2>
      <Table
        headers={['Shortcut', 'Action']}
        rows={[
          [<Kbd>[</Kbd>, 'Send to back'],
          [<Kbd>]</Kbd>, 'Bring to front'],
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>G</Kbd>
            </>,
            'Group selection into a new Frame',
          ],
        ]}
      />

      <H2>AI</H2>
      <Table
        headers={['Shortcut', 'Action']}
        rows={[
          [
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd>
            </>,
            'Open the Intent popover',
          ],
        ]}
      />

      <H2>Help</H2>
      <Table
        headers={['Shortcut', 'Action']}
        rows={[
          [<Kbd>?</Kbd>, 'Open the keyboard-shortcut modal'],
          [<Kbd>Esc</Kbd>, 'Cancel the current tool / close the modal'],
        ]}
      />

      <H2>Paste behaviour</H2>
      <P>
        <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>V</Kbd> resolves to different node
        types depending on what&apos;s on your clipboard:
      </P>
      <Table
        headers={['Clipboard contents', 'Result']}
        rows={[
          [
            'Canvas nodes copied earlier',
            'Pasted as duplicates at the cursor position.',
          ],
          ['Image file', 'Creates an Image node and uploads it.'],
          ['PDF file', 'Creates a PDF node and uploads it.'],
          ['Video file', 'Creates a Video node and uploads it.'],
          [
            'One or more URLs (one per line)',
            'Auto-detected as image / PDF / web page / YouTube; one node per line.',
          ],
          ['Plain text', 'Creates a Note with the pasted text.'],
        ]}
      />

      <Callout tone="info">
        Shortcuts adapt to your platform automatically — the modifier shows up
        as <Kbd>Cmd</Kbd> on macOS and <Kbd>Ctrl</Kbd> on Windows / Linux.
      </Callout>
    </PageLayout>
  );
}
