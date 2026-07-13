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
  { id: 'picking-a-home', label: 'Picking a Home' },
  { id: 'switching-homes', label: 'Switching Homes' },
  { id: 'the-space-list', label: 'The Space list' },
  { id: 'lifecycle-of-a-space', label: 'Lifecycle of a Space' },
  { id: 'import-export', label: 'Import & export' },
  { id: 'sharing-and-collaboration', label: 'Sharing & collaboration' },
];

export default function Workspaces() {
  return (
    <PageLayout
      title="Homes & Spaces"
      description="All your data lives inside a single local folder you choose — a Home. Each Home holds any number of Spaces, and each Space is a self-contained subdirectory."
      toc={toc}
    >
      <H2>Picking a Home</H2>
      <P>
        On first launch you&apos;re shown a Home picker. Either select a folder
        via the native OS dialog or pick one from the recent list.
      </P>
      <Table
        headers={['Action', 'What it does']}
        rows={[
          [
            <strong>Pick folder</strong>,
            'Use a native OS dialog to choose any folder. An empty one is easiest, but Huabu coexists with existing files.',
          ],
          [
            <strong>Recent Homes</strong>,
            'Open or remove a previously used Home in one click; the list is remembered locally.',
          ],
        ]}
      />
      <P>
        Inside the chosen folder Huabu creates one subdirectory per Space (and a{' '}
        <Code>setting/</Code> folder for Home-wide memory and skills):
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
        Your last-opened Home is remembered, so re-launching Huabu drops you
        back where you left off.
      </P>

      <H2>Switching Homes</H2>
      <P>
        Open Settings at any time to switch. Switching swaps the Space list,
        node contents and chat history for the new Home; the previous folder is
        never touched.
      </P>
      <Callout tone="tip">
        Homes are <strong>plain folders</strong>. Back them up with Time Machine
        / Restic / rsync, sync them through iCloud / Dropbox / Syncthing, or
        commit them to Git — whatever you already use for files.
      </Callout>

      <H2>The Space list</H2>
      <P>
        Once a Home is loaded, the Space list (the &quot;Home&quot; screen) lets
        you create, open, delete, import and export Spaces. The header shows the
        current Home path and a link to switch.
      </P>
      <Table
        headers={['Action', 'What it does']}
        rows={[
          [
            <strong>New Space</strong>,
            'Create an empty Space and jump into it.',
          ],
          [<strong>Open Space</strong>, 'Click a card to open the Space.'],
          [
            <strong>Delete Space</strong>,
            'Removes the Space folder entirely, including its chat and intent history.',
          ],
          [
            <strong>Export Space</strong>,
            'Bundles the Space folder into a .zip you can hand off; attachments are included.',
          ],
          [
            <strong>Import Space</strong>,
            'Restores a Space from a previously exported .zip; a fresh Space ID is assigned.',
          ],
        ]}
      />

      <H2>Lifecycle of a Space</H2>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Create</strong> — click <em>New Space</em>; the app drops you
          straight into the new Space.
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
        Export produces a <Code>.zip</Code> archive containing the Space
        directory and its <Code>.artifacts/</Code>. Import accepts the same
        bundle and reconstitutes the Space under a new ID, so you can hand a
        snapshot to a teammate without worrying about ID collisions.
      </P>

      <H2>Sharing & collaboration</H2>
      <P>
        The current version is <strong>single-machine, local-first</strong>. One
        Space is expected to be edited by one client at a time. To share work:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Export the Space to a <Code>.zip</Code> bundle and hand over the
          snapshot.
        </li>
        <li>Or put the whole Home folder in version control / a sync drive.</li>
      </ul>
      <P>Real-time multi-user collaboration is not yet available.</P>
      <Callout tone="info">
        Want details on every file Huabu writes? See{' '}
        <DocLink href="/docs/reference/storage">Data Storage</DocLink>.
      </Callout>
    </PageLayout>
  );
}
