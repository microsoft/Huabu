// TODO: fill in real handbook content for this section.
import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'picking-a-workspace', label: 'Picking a workspace' },
  { id: 'switching-workspaces', label: 'Switching workspaces' },
  { id: 'the-canvas-list', label: 'The canvas list' },
  { id: 'lifecycle-of-a-canvas', label: 'Lifecycle of a canvas' },
  { id: 'import-export', label: 'Import & export' },
  { id: 'sharing-and-collaboration', label: 'Sharing & collaboration' },
];

export default function Workspaces() {
  return (
    <PageLayout
      title="Workspaces & Canvases"
      description="All your data lives inside a single local folder you choose — a workspace. Each workspace holds any number of canvases, and each canvas is a self-contained subdirectory."
      toc={toc}
    >
      <H2>Picking a workspace</H2>
      <P>
        On first launch you&apos;re shown a workspace picker. Either select a
        folder via the native OS dialog or pick one from the recent list.
      </P>
      <Table
        headers={['Action', 'What it does']}
        rows={[
          [
            <strong>Pick folder</strong>,
            'Use a native OS dialog to choose any folder. An empty one is easiest, but Huabu coexists with existing files.',
          ],
          [
            <strong>Recent workspaces</strong>,
            'Open or remove a previously used workspace in one click; the list is remembered locally.',
          ],
        ]}
      />
      <P>
        Inside the chosen folder Huabu creates one subdirectory per canvas (and
        a <Code>setting/</Code> folder for workspace-wide memory and skills):
      </P>
      <CodeBlock language="text">{`<workspace>/
├── <canvas-title>/          one folder per canvas
│   ├── canvas.json          topology (nodes, edges, version)
│   ├── nodes/               one Markdown file per node
│   ├── .artifacts/          hidden: raw binaries (PDFs, images, videos)
│   ├── .memory/canvas.md    AI-written canvas memory
│   └── .history/            hidden: chat & intent history
└── setting/
    ├── .huabu.md            workspace-wide memory
    └── skills/              your custom skills`}</CodeBlock>
      <P>
        Your last-opened workspace is remembered, so re-launching Huabu drops
        you back where you left off.
      </P>

      <H2>Switching workspaces</H2>
      <P>
        Open Settings at any time to switch. Switching swaps the canvas list,
        node contents and chat history for the new workspace; the previous
        folder is never touched.
      </P>
      <Callout tone="tip">
        Workspaces are <strong>plain folders</strong>. Back them up with Time
        Machine / Restic / rsync, sync them through iCloud / Dropbox /
        Syncthing, or commit them to Git — whatever you already use for files.
      </Callout>

      <H2>The canvas list</H2>
      <P>
        Once a workspace is loaded, the canvas list (the &quot;Home&quot;
        screen) lets you create, open, delete, import and export canvases. The
        header shows the current workspace path and a link to switch.
      </P>
      <Table
        headers={['Action', 'What it does']}
        rows={[
          [
            <strong>New canvas</strong>,
            'Create an empty canvas and jump into it.',
          ],
          [<strong>Open canvas</strong>, 'Click a card to open the canvas.'],
          [
            <strong>Delete canvas</strong>,
            'Removes the canvas folder entirely, including its chat and intent history.',
          ],
          [
            <strong>Export canvas</strong>,
            'Bundles the canvas folder into a .zip you can hand off; attachments are included.',
          ],
          [
            <strong>Import canvas</strong>,
            'Restores a canvas from a previously exported .zip; a fresh canvas ID is assigned.',
          ],
        ]}
      />

      <H2>Lifecycle of a canvas</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Create</strong> — click <em>New canvas</em>; the app drops you
          straight into the new canvas.
        </li>
        <li>
          <strong>Edit</strong> — add nodes, draw connections, chat with the AI.
        </li>
        <li>
          <strong>Auto-save</strong> — every change is written back to{' '}
          <Code>canvas.json</Code> atomically (write-to-tmp + rename), so a
          crash mid-write can&apos;t corrupt the file.
        </li>
        <li>
          <strong>Versioning</strong> — the file carries a version number
          that&apos;s validated on load.
        </li>
        <li>
          <strong>Export / share</strong> — export to a portable bundle at any
          time, attachments included.
        </li>
      </ol>

      <H2>Import & export</H2>
      <P>
        Export produces a <Code>.zip</Code> archive containing the canvas
        directory and its <Code>.artifacts/</Code>. Import accepts the same
        bundle and reconstitutes the canvas under a new ID, so you can hand a
        snapshot to a teammate without worrying about ID collisions.
      </P>

      <H2>Sharing & collaboration</H2>
      <P>
        The current version is <strong>single-machine, local-first</strong>. One
        canvas is expected to be edited by one client at a time. To share work:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Export the canvas to a <Code>.zip</Code> bundle and hand over the
          snapshot.
        </li>
        <li>
          Or put the whole workspace folder in version control / a sync drive.
        </li>
      </ul>
      <P>Real-time multi-user collaboration is not yet available.</P>
      <Callout tone="info">
        Want details on every file Huabu writes? See{' '}
        <DocLink href="/docs/reference/storage">Data Storage</DocLink>.
      </Callout>
    </PageLayout>
  );
}
